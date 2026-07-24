"""WD14 v3 系列打标器封装（onnxruntime）"""
import csv
import hashlib
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import requests
from PIL import Image

CATEGORY_GENERAL = 0
CATEGORY_CHARACTER = 4
CATEGORY_RATING = 9

# 官方源优先；配置中可显式添加备用镜像。
DEFAULT_MIRRORS = ["https://huggingface.co"]
_DLL_DIRECTORY_HANDLES = []
_DLL_PATHS_CONFIGURED = False


class IntegrityError(RuntimeError):
    pass


def _safe_cache_part(value):
    clean = "".join(char if char.isalnum() or char in "._-" else "_" for char in str(value))
    return clean[:80] or "unknown"


def model_cache_dir(repo, revision, base_dir=None):
    base = Path(base_dir) if base_dir else Path(__file__).parent / "models"
    return base / _safe_cache_part(repo.split("/")[-1]) / _safe_cache_part(revision)


def _migrate_legacy_cache(repo, revision, expected_hashes, expected_sizes):
    base = Path(__file__).parent / "models"
    legacy = base / repo.split("/")[-1]
    target = model_cache_dir(repo, revision, base)
    if target.exists() or not legacy.exists():
        return target
    moved = False
    for filename in ("model.onnx", "selected_tags.csv"):
        source = legacy / filename
        if not source.exists():
            continue
        try:
            _validate_file(
                source,
                (expected_hashes or {}).get(filename),
                (expected_sizes or {}).get(filename),
            )
        except IntegrityError:
            continue
        target.mkdir(parents=True, exist_ok=True)
        source.replace(target / filename)
        moved = True
    if moved:
        print(f"    已将旧模型缓存迁移到版本目录：{target.name}")
    return target


def _configure_nvidia_dll_paths():
    """让 Windows 能找到 pip 安装的 cuDNN/CUDA 拆分 DLL。"""
    global _DLL_PATHS_CONFIGURED
    if os.name != "nt" or _DLL_PATHS_CONFIGURED:
        return

    bin_dirs = []
    for entry in sys.path:
        if not entry:
            continue
        nvidia_root = Path(entry) / "nvidia"
        if not nvidia_root.is_dir():
            continue
        for package_dir in nvidia_root.iterdir():
            bin_dir = package_dir / "bin"
            if bin_dir.is_dir():
                bin_dirs.append(bin_dir.resolve())

    if bin_dirs:
        existing = os.environ.get("PATH", "")
        os.environ["PATH"] = os.pathsep.join(map(str, bin_dirs)) + os.pathsep + existing
        if hasattr(os, "add_dll_directory"):
            for bin_dir in bin_dirs:
                _DLL_DIRECTORY_HANDLES.append(os.add_dll_directory(str(bin_dir)))
    _DLL_PATHS_CONFIGURED = True


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _validate_file(path: Path, expected_sha256=None, expected_size=None):
    if not path.exists() or path.stat().st_size <= 0:
        raise IntegrityError(f"{path.name} 为空或不存在")
    if expected_size is not None and path.stat().st_size != int(expected_size):
        raise IntegrityError(
            f"{path.name} 大小不符：{path.stat().st_size} != {expected_size}"
        )
    if expected_sha256:
        actual = _sha256(path)
        if actual.lower() != str(expected_sha256).lower():
            raise IntegrityError(f"{path.name} SHA256 不匹配")


def _download_file(
    repo,
    filename,
    dest_dir: Path,
    mirrors=None,
    revision="main",
    expected_sha256=None,
    expected_size=None,
    progress_callback=None,
):
    """直链下载模型文件，支持断点续传和多镜像重试。"""
    dest = dest_dir / filename
    dest_dir.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".part")

    if dest.exists():
        try:
            print(f"    校验缓存 {filename}...")
            if progress_callback:
                progress_callback(
                    filename=filename,
                    stage="checking",
                    downloaded_bytes=dest.stat().st_size,
                    total_bytes=expected_size or dest.stat().st_size,
                )
            _validate_file(dest, expected_sha256, expected_size)
            if progress_callback:
                progress_callback(
                    filename=filename,
                    stage="complete",
                    downloaded_bytes=dest.stat().st_size,
                    total_bytes=expected_size or dest.stat().st_size,
                )
            return dest
        except IntegrityError as e:
            print(f"    [警告] 缓存无效，将重新下载：{e}")
            dest.unlink()

    if tmp.exists():
        try:
            _validate_file(tmp, expected_sha256, expected_size)
            tmp.replace(dest)
            return dest
        except IntegrityError:
            if expected_size is not None and tmp.stat().st_size >= int(expected_size):
                tmp.unlink()

    last_err = None
    for base in mirrors or DEFAULT_MIRRORS:
        url = f"{base.rstrip('/')}/{repo}/resolve/{revision}/{filename}"
        try:
            done = tmp.stat().st_size if tmp.exists() else 0
            if progress_callback:
                progress_callback(
                    filename=filename,
                    stage="connecting",
                    downloaded_bytes=done,
                    total_bytes=expected_size or 0,
                    source=base,
                )
            headers = {"Accept-Encoding": "identity"}
            if done:
                headers["Range"] = f"bytes={done}-"
            with requests.get(
                url,
                headers=headers,
                stream=True,
                timeout=(10, 120),
                allow_redirects=True,
            ) as r:
                if done and r.status_code == 200:  # 服务端不支持续传，重头下
                    done = 0
                elif done and r.status_code == 206:
                    content_range = r.headers.get("content-range", "")
                    if not content_range.startswith(f"bytes {done}-"):
                        raise IntegrityError(f"续传响应范围异常：{content_range!r}")
                r.raise_for_status()
                total = int(r.headers.get("content-length", 0)) + done
                mode = "ab" if done and r.status_code == 206 else "wb"
                started_at, started_bytes, reported = time.time(), done, done
                last_progress_at = 0.0
                with open(tmp, mode) as f:
                    for chunk in r.iter_content(chunk_size=1 << 20):
                        if not chunk:
                            continue
                        f.write(chunk)
                        done += len(chunk)
                        now = time.time()
                        if progress_callback and (now - last_progress_at >= 0.5 or done >= total):
                            speed = (done - started_bytes) / max(now - started_at, 0.1) / (1 << 20)
                            progress_callback(
                                filename=filename,
                                stage="downloading",
                                downloaded_bytes=done,
                                total_bytes=total or expected_size or 0,
                                speed_mbps=round(speed, 2),
                                source=base,
                            )
                            last_progress_at = now
                        if done - reported >= 100 << 20:  # 每 100MB 报一次进度
                            reported = done
                            speed = (done - started_bytes) / max(
                                time.time() - started_at, 0.1
                            ) / (1 << 20)
                            print(f"    下载 {filename}: {done >> 20}MB / {total >> 20}MB ({speed:.1f} MB/s)")
            _validate_file(tmp, expected_sha256, expected_size)
            tmp.replace(dest)
            if progress_callback:
                progress_callback(
                    filename=filename,
                    stage="complete",
                    downloaded_bytes=dest.stat().st_size,
                    total_bytes=expected_size or dest.stat().st_size,
                    source=base,
                )
            return dest
        except Exception as e:
            last_err = e
            if isinstance(e, IntegrityError) and tmp.exists():
                tmp.unlink()
            print(f"    [警告] 从 {base} 下载失败: {e}，尝试下一个源...")

    # 某些 Windows 网络环境会中断 Python/OpenSSL 握手，但系统 Schannel 可用。
    curl = shutil.which("curl.exe") if os.name == "nt" else None
    if curl:
        print(f"    [下载] Python HTTPS 不可用，切换到 Windows curl：{filename}")
        for base in mirrors or DEFAULT_MIRRORS:
            url = f"{base.rstrip('/')}/{repo}/resolve/{revision}/{filename}"
            try:
                if progress_callback:
                    progress_callback(
                        filename=filename,
                        stage="fallback",
                        downloaded_bytes=tmp.stat().st_size if tmp.exists() else 0,
                        total_bytes=expected_size or 0,
                        source=base,
                    )
                result = subprocess.run(
                    [
                        curl,
                        "-L",
                        "--fail",
                        "--silent",
                        "--show-error",
                        "--retry",
                        "20",
                        "--retry-delay",
                        "3",
                        "--retry-all-errors",
                        "--connect-timeout",
                        "20",
                        "--speed-limit",
                        "1024",
                        "--speed-time",
                        "120",
                        "--continue-at",
                        "-",
                        "--output",
                        str(tmp),
                        url,
                    ],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    check=False,
                )
                if result.returncode != 0:
                    detail = result.stderr.strip() or f"exit {result.returncode}"
                    raise RuntimeError(detail)
                _validate_file(tmp, expected_sha256, expected_size)
                tmp.replace(dest)
                if progress_callback:
                    progress_callback(
                        filename=filename,
                        stage="complete",
                        downloaded_bytes=dest.stat().st_size,
                        total_bytes=expected_size or dest.stat().st_size,
                        source=base,
                    )
                return dest
            except Exception as e:
                last_err = e
                if isinstance(e, IntegrityError) and tmp.exists():
                    tmp.unlink()
                print(f"    [警告] curl 从 {base} 下载失败: {e}，尝试下一个源...")
    raise RuntimeError(f"{filename} 所有下载源均失败: {last_err}")


def _pick_providers():
    _configure_nvidia_dll_paths()
    import onnxruntime as ort

    try:  # onnxruntime>=1.21：从 pip 装的 nvidia 包里预加载 CUDA/cuDNN DLL
        ort.preload_dlls(directory="")
    except Exception as e:
        print(f"    [警告] CUDA/cuDNN DLL 预加载失败，将尝试可用后端：{e}")
    available = ort.get_available_providers()
    preferred = ["CUDAExecutionProvider", "DmlExecutionProvider", "CPUExecutionProvider"]
    return [p for p in preferred if p in available] or available


class WD14Tagger:
    def __init__(
        self,
        repo,
        cache_dir=None,
        mirrors=None,
        revision="main",
        hashes=None,
        sizes=None,
        progress_callback=None,
    ):
        _configure_nvidia_dll_paths()
        import onnxruntime as ort

        hashes = hashes or {}
        sizes = sizes or {}
        cache = Path(cache_dir) if cache_dir else _migrate_legacy_cache(
            repo, revision, hashes, sizes
        )
        model_path = _download_file(
            repo,
            "model.onnx",
            cache,
            mirrors,
            revision,
            hashes.get("model.onnx"),
            sizes.get("model.onnx"),
            progress_callback,
        )
        csv_path = _download_file(
            repo,
            "selected_tags.csv",
            cache,
            mirrors,
            revision,
            hashes.get("selected_tags.csv"),
            sizes.get("selected_tags.csv"),
            progress_callback,
        )

        providers = _pick_providers()
        self.session = ort.InferenceSession(model_path, providers=providers)
        self.provider = self.session.get_providers()[0]

        inp = self.session.get_inputs()[0]
        self.input_name = inp.name
        # NHWC: (batch, size, size, 3)
        self.size = inp.shape[1] if isinstance(inp.shape[1], int) else 448

        self.tags = []  # [(name, category)]
        with open(csv_path, newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                self.tags.append((row["name"], int(row["category"])))
        output_size = self.session.get_outputs()[0].shape[-1]
        if isinstance(output_size, int) and len(self.tags) != output_size:
            raise RuntimeError(
                f"模型输出 {output_size} 项，但标签表有 {len(self.tags)} 项；文件版本不匹配"
            )

    def _preprocess(self, img: Image.Image) -> np.ndarray:
        if img.mode != "RGBA":
            img = img.convert("RGBA")
        bg = Image.new("RGBA", img.size, (255, 255, 255, 255))
        img = Image.alpha_composite(bg, img).convert("RGB")
        w, h = img.size
        s = max(w, h)
        canvas = Image.new("RGB", (s, s), (255, 255, 255))
        canvas.paste(img, ((s - w) // 2, (s - h) // 2))
        canvas = canvas.resize((self.size, self.size), Image.BICUBIC)
        return np.asarray(canvas, dtype=np.float32)[:, :, ::-1]  # RGB -> BGR

    def _decode_probs(self, probs, general_threshold, character_threshold):
        """把单张图片的概率转换为标签结果。"""
        general, characters, ratings = [], [], []
        for (name, category), p in zip(self.tags, probs):
            p = float(p)
            if category == CATEGORY_RATING:
                ratings.append((name, p))
            elif category == CATEGORY_CHARACTER and p >= character_threshold:
                characters.append((name, p))
            elif category == CATEGORY_GENERAL and p >= general_threshold:
                general.append((name, p))

        general.sort(key=lambda x: -x[1])
        characters.sort(key=lambda x: -x[1])
        rating = max(ratings, key=lambda x: x[1])[0] if ratings else None
        return general, characters, rating

    def predict_batch(
        self, images, general_threshold=0.35, character_threshold=0.75
    ):
        """一次推理多张图片，返回与输入顺序一致的标签结果。"""
        if not images:
            return []
        batch = np.stack([self._preprocess(img) for img in images])
        probs_batch = self.session.run(None, {self.input_name: batch})[0]
        self.provider = self.session.get_providers()[0]
        if len(probs_batch) != len(images):
            raise RuntimeError(
                f"模型批量输出数量异常：输入 {len(images)}，输出 {len(probs_batch)}"
            )
        return [
            self._decode_probs(probs, general_threshold, character_threshold)
            for probs in probs_batch
        ]

    def predict(self, img: Image.Image, general_threshold=0.35, character_threshold=0.75):
        """返回 (general_tags, character_tags, rating) ，tag 按置信度降序。"""
        return self.predict_batch(
            [img], general_threshold, character_threshold
        )[0]
