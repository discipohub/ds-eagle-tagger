"""Approved WD14 model catalog checker and safe installer."""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

import requests

from tagger import load_config
from wd14 import _download_file, model_cache_dir


HERE = Path(__file__).resolve().parent
CATALOG_SCHEMA_VERSION = 1
MODEL_FILENAMES = ("model.onnx", "selected_tags.csv")


def emit(event_type: str, **payload: Any) -> None:
    sys.__stdout__.write(
        json.dumps({"type": event_type, **payload}, ensure_ascii=False) + "\n"
    )
    sys.__stdout__.flush()


def version_tuple(value: str) -> tuple[int, ...]:
    numbers = re.findall(r"\d+", str(value or ""))
    return tuple(int(number) for number in numbers[:3]) or (0,)


def release_is_compatible(release: dict[str, Any], engine_version: str) -> bool:
    minimum = version_tuple(str(release.get("min_engine_version") or "0"))
    maximum_raw = release.get("max_engine_version")
    current = version_tuple(engine_version)
    if current < minimum:
        return False
    return not maximum_raw or current <= version_tuple(str(maximum_raw))


def validate_release(release: Any) -> dict[str, Any]:
    if not isinstance(release, dict):
        raise ValueError("模型版本必须是对象")
    required = (
        "id",
        "sequence",
        "name",
        "version",
        "model_repo",
        "model_revision",
        "model_hashes",
        "model_sizes",
    )
    missing = [key for key in required if release.get(key) in (None, "")]
    if missing:
        raise ValueError(f"模型版本缺少字段：{', '.join(missing)}")
    if not isinstance(release["sequence"], int) or release["sequence"] < 1:
        raise ValueError("模型 sequence 必须是正整数")
    for field in ("model_hashes", "model_sizes"):
        if not isinstance(release[field], dict):
            raise ValueError(f"{field} 必须是对象")
        for filename in MODEL_FILENAMES:
            if filename not in release[field]:
                raise ValueError(f"{field} 缺少 {filename}")
    for filename, digest in release["model_hashes"].items():
        if filename in MODEL_FILENAMES and not re.fullmatch(r"[0-9a-fA-F]{64}", str(digest)):
            raise ValueError(f"{filename} SHA-256 无效")
    for filename, size in release["model_sizes"].items():
        if filename in MODEL_FILENAMES and (not isinstance(size, int) or size <= 0):
            raise ValueError(f"{filename} 文件大小无效")
    mirrors = release.get("model_mirrors") or []
    if not isinstance(mirrors, list) or not all(
        isinstance(url, str) and url.startswith("https://") for url in mirrors
    ):
        raise ValueError("model_mirrors 必须是 HTTPS 地址数组")
    return dict(release)


def validate_catalog(data: Any) -> list[dict[str, Any]]:
    if not isinstance(data, dict) or data.get("schema_version") != CATALOG_SCHEMA_VERSION:
        raise ValueError("不支持的模型清单格式")
    releases = data.get("releases")
    if not isinstance(releases, list) or not releases:
        raise ValueError("模型清单没有可用版本")
    return [validate_release(release) for release in releases]


def read_catalog_file(path: Path) -> list[dict[str, Any]]:
    return validate_catalog(json.loads(path.read_text(encoding="utf-8")))


def fetch_catalog(url: str, timeout: int) -> list[dict[str, Any]]:
    if not url.startswith("https://"):
        raise ValueError("在线模型清单必须使用 HTTPS")
    response = requests.get(url, timeout=(10, timeout), headers={"Accept": "application/json"})
    response.raise_for_status()
    return validate_catalog(response.json())


def load_approved_releases(
    config: dict[str, Any],
    catalog_file: Path | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    bundled_path = catalog_file or HERE / "model-catalog.json"
    releases_by_id = {
        release["id"]: release for release in read_catalog_file(bundled_path)
    }
    urls = config.get("model_catalog_urls") or []
    if not isinstance(urls, list) or not all(isinstance(url, str) for url in urls):
        raise ValueError("model_catalog_urls 必须是地址数组")
    timeout = int(config.get("model_catalog_timeout_seconds") or 30)
    online_checked = False
    warnings: list[str] = []
    for url in urls:
        try:
            for release in fetch_catalog(url, timeout):
                releases_by_id[release["id"]] = release
            online_checked = True
        except Exception as error:
            warnings.append(f"{url}: {error}")
    return list(releases_by_id.values()), {
        "online_configured": bool(urls),
        "online_checked": online_checked,
        "warnings": warnings,
    }


def active_release(config: dict[str, Any], releases: list[dict[str, Any]]) -> dict[str, Any]:
    active_id = str(config.get("model_id") or "")
    if active_id:
        for release in releases:
            if release["id"] == active_id:
                return release
    for release in releases:
        if (
            release["model_repo"] == config.get("model_repo")
            and release["model_revision"] == config.get("model_revision")
        ):
            return release
    return {
        "id": active_id or "custom",
        "sequence": int(config.get("model_sequence") or 0),
        "name": str(config.get("model_repo") or "自定义模型"),
        "version": str(config.get("model_revision") or "未知版本")[:12],
        "model_repo": config.get("model_repo"),
        "model_revision": config.get("model_revision"),
    }


def choose_update(
    config: dict[str, Any],
    releases: list[dict[str, Any]],
    engine_version: str,
) -> dict[str, Any]:
    current = active_release(config, releases)
    compatible = [
        release for release in releases if release_is_compatible(release, engine_version)
    ]
    latest_compatible = max(compatible, key=lambda release: release["sequence"], default=current)
    latest_overall = max(releases, key=lambda release: release["sequence"])
    update_available = int(latest_compatible.get("sequence") or 0) > int(
        current.get("sequence") or 0
    )
    plugin_update_required = (
        int(latest_overall["sequence"]) > int(latest_compatible.get("sequence") or 0)
        and int(latest_overall["sequence"]) > int(current.get("sequence") or 0)
    )
    return {
        "current": current,
        "latest": latest_compatible,
        "update_available": update_available,
        "plugin_update_required": plugin_update_required,
        "incompatible_latest": latest_overall if plugin_update_required else None,
    }


def selection_payload(release: dict[str, Any]) -> dict[str, Any]:
    return {
        "model_id": release["id"],
        "model_version": release["version"],
        "model_sequence": release["sequence"],
        "model_repo": release["model_repo"],
        "model_revision": release["model_revision"],
        "model_hashes": release["model_hashes"],
        "model_sizes": release["model_sizes"],
        "model_mirrors": release.get("model_mirrors") or [],
    }


def install_release(
    release: dict[str, Any],
    engine_root: Path = HERE,
) -> Path:
    cache = model_cache_dir(
        release["model_repo"],
        release["model_revision"],
        base_dir=engine_root / "models",
    )

    def progress(**payload: Any) -> None:
        emit("model_update_download", release_id=release["id"], **payload)

    for filename in MODEL_FILENAMES:
        _download_file(
            release["model_repo"],
            filename,
            cache,
            release.get("model_mirrors"),
            release["model_revision"],
            release["model_hashes"][filename],
            release["model_sizes"][filename],
            progress,
        )

    selection_path = engine_root / "model-selection.json"
    temporary = selection_path.with_suffix(".json.tmp")
    temporary.write_text(
        json.dumps(selection_payload(release), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, selection_path)
    return selection_path


def import_local_file(
    source: Path,
    target: Path,
    *,
    filename: str,
    expected_sha256: str,
    expected_size: int,
    release_id: str,
) -> None:
    if not source.is_file():
        raise ValueError(f"找不到本地文件：{source}")
    source_size = source.stat().st_size
    if source_size != int(expected_size):
        raise ValueError(
            f"{filename} 大小不符：{source_size} != {expected_size}"
        )

    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + ".importing")
    digest = hashlib.sha256()
    copied = 0
    try:
        with source.open("rb") as reader, temporary.open("wb") as writer:
            while True:
                chunk = reader.read(8 << 20)
                if not chunk:
                    break
                writer.write(chunk)
                digest.update(chunk)
                copied += len(chunk)
                emit(
                    "model_update_import",
                    release_id=release_id,
                    filename=filename,
                    copied_bytes=copied,
                    total_bytes=expected_size,
                )
            writer.flush()
            os.fsync(writer.fileno())
        actual = digest.hexdigest()
        if actual.lower() != str(expected_sha256).lower():
            raise ValueError(f"{filename} SHA-256 不匹配")
        os.replace(temporary, target)
    except Exception:
        with contextlib.suppress(OSError):
            temporary.unlink()
        raise


def import_local_release(
    release: dict[str, Any],
    model_path: Path,
    tags_path: Path,
    engine_root: Path = HERE,
) -> Path:
    cache = model_cache_dir(
        release["model_repo"],
        release["model_revision"],
        base_dir=engine_root / "models",
    )
    sources = {
        "model.onnx": model_path,
        "selected_tags.csv": tags_path,
    }
    for filename in MODEL_FILENAMES:
        emit(
            "model_update_status",
            message=f"正在校验并导入 {filename}…",
        )
        import_local_file(
            sources[filename],
            cache / filename,
            filename=filename,
            expected_sha256=release["model_hashes"][filename],
            expected_size=release["model_sizes"][filename],
            release_id=release["id"],
        )

    selection_path = engine_root / "model-selection.json"
    temporary = selection_path.with_suffix(".json.tmp")
    temporary.write_text(
        json.dumps(selection_payload(release), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, selection_path)
    return selection_path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine-version", required=True)
    parser.add_argument("--catalog-file")
    subparsers = parser.add_subparsers(dest="operation", required=True)
    subparsers.add_parser("check")
    install_parser = subparsers.add_parser("install")
    install_parser.add_argument("release_id")
    import_parser = subparsers.add_parser("import-local")
    import_parser.add_argument("model_path")
    import_parser.add_argument("tags_path")
    args = parser.parse_args()

    try:
        config = load_config()
        releases, catalog_status = load_approved_releases(
            config,
            Path(args.catalog_file) if args.catalog_file else None,
        )
        update = choose_update(config, releases, args.engine_version)
        if args.operation == "check":
            emit("model_update_check", ok=True, **update, **catalog_status)
            return 0

        if args.operation == "import-local":
            current = active_release(config, releases)
            release = next(
                (item for item in releases if item["id"] == current.get("id")),
                None,
            )
            if not release:
                release = next(
                    (
                        item
                        for item in releases
                        if item["model_repo"] == config.get("model_repo")
                        and item["model_revision"] == config.get("model_revision")
                    ),
                    None,
                )
            if not release:
                raise ValueError("当前模型不在批准清单中，无法安全导入")
            if not release_is_compatible(release, args.engine_version):
                raise ValueError("当前模型需要先更新插件")
            import_local_release(
                release,
                Path(args.model_path),
                Path(args.tags_path),
            )
            emit("model_update_imported", ok=True, release=release)
            return 0

        release = next(
            (item for item in releases if item["id"] == args.release_id),
            None,
        )
        if not release:
            raise ValueError("模型版本不在批准清单中")
        if not release_is_compatible(release, args.engine_version):
            raise ValueError("该模型需要先更新插件")
        emit("model_update_status", message=f"正在准备 {release['name']}…")
        with contextlib.redirect_stdout(sys.stderr):
            install_release(release)
        emit("model_update_installed", ok=True, release=release)
        return 0
    except Exception as error:
        emit("model_update_error", ok=False, error=str(error))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
