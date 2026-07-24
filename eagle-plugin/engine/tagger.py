"""Eagle 自动打标工具：扫描 Eagle 库中未打标的图片，用 WD14 打标后写回。

用法：
    python tagger.py --dry-run          # 只看结果不写入
    python tagger.py                    # 正式跑
    python tagger.py --limit 200        # 先试跑 200 张
    python tagger.py --folder <ID> --folder <ID>  # 同时处理多个文件夹
"""
import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

from PIL import Image, ImageOps

from eagle_api import EagleClient
from wd14 import WD14Tagger

HERE = Path(__file__).parent
IMAGE_EXTS = {"png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff"}

GRAPHIC_NAME_RE = re.compile(
    r"(?:^|[\s_.-])(?:logo|wordmark|logotype)(?:$|[\s_.-])|字标|文字标志|商标|标志",
    re.IGNORECASE,
)
GRAPHIC_SIGNAL_TAGS = {
    "monochrome",
    "greyscale",
    "simple_background",
    "transparent_background",
    "white_background",
    "text_focus",
    "negative_space",
}
GRAPHIC_PERSON_TAGS = {
    "1girl",
    "1boy",
    "2girls",
    "2boys",
    "3girls",
    "3boys",
    "multiple_girls",
    "multiple_boys",
    "solo",
    "male_focus",
    "female_focus",
    "looking_at_viewer",
    "looking_away",
    "smile",
    "open_mouth",
    "closed_mouth",
    "no_mouth",
    "straight-on",
    "short_hair",
    "long_hair",
    "very_long_hair",
    "twintails",
    "ponytail",
    "blush",
    "child",
    "breasts",
    "upper_body",
    "full_body",
    "standing",
    "sitting",
    "shirt",
    "dress",
    "skirt",
    "long_sleeves",
    "short_sleeves",
    "bare_shoulders",
    "holding",
}


def load_config():
    defaults = {
        "eagle_url": "http://localhost:41595",
        "eagle_token": None,
        "model_repo": "SmilingWolf/wd-eva02-large-tagger-v3",
        "model_revision": "main",
        "model_hashes": {},
        "model_sizes": {},
        "general_threshold": 0.35,
        "character_threshold": 0.75,
        "batch_size": 4,
        "max_tags": 50,
        "include_rating": True,
        "filter_graphic_person_tags": True,
        "model_mirrors": None,
        "model_catalog_urls": [],
        "model_catalog_timeout_seconds": 30,
    }
    cfg_path = HERE / "config.json"
    if cfg_path.exists():
        defaults.update(json.loads(cfg_path.read_text(encoding="utf-8")))
    local_cfg_path = HERE / "config.local.json"
    if local_cfg_path.exists():
        defaults.update(json.loads(local_cfg_path.read_text(encoding="utf-8")))
    model_selection_path = HERE / "model-selection.json"
    if model_selection_path.exists():
        defaults.update(json.loads(model_selection_path.read_text(encoding="utf-8")))
    if os.environ.get("EAGLE_TOKEN"):
        defaults["eagle_token"] = os.environ["EAGLE_TOKEN"]
    return defaults


def validate_config(cfg):
    if not isinstance(cfg["batch_size"], int) or cfg["batch_size"] < 1:
        raise ValueError("config.json: batch_size 必须是大于 0 的整数")
    if not isinstance(cfg["max_tags"], int) or cfg["max_tags"] < 1:
        raise ValueError("config.json: max_tags 必须是大于 0 的整数")
    mirrors = cfg.get("model_mirrors")
    if mirrors is not None and (
        not isinstance(mirrors, list)
        or not all(isinstance(url, str) and url.startswith("https://") for url in mirrors)
    ):
        raise ValueError("config.json: model_mirrors 必须是 HTTPS 地址数组")
    if not isinstance(cfg.get("model_hashes"), dict):
        raise ValueError("config.json: model_hashes 必须是对象")
    if not isinstance(cfg.get("model_sizes"), dict):
        raise ValueError("config.json: model_sizes 必须是对象")
    catalog_urls = cfg.get("model_catalog_urls") or []
    if not isinstance(catalog_urls, list) or not all(
        isinstance(url, str) and url.startswith("https://") for url in catalog_urls
    ):
        raise ValueError("config.json: model_catalog_urls 必须是 HTTPS 地址数组")


def collect_todo(eagle, folder=None, retag=False, limit=0):
    """收集一个或多个文件夹的待处理图片；条目按 ID 去重。"""
    todo = []
    scanned = 0
    limit_reached = False
    seen_ids = set()
    folders = [folder] if isinstance(folder, str) else (folder or [None])
    for folder_id in folders:
        for item in eagle.iter_items(folder=folder_id):
            item_id = item["id"]
            if item_id in seen_ids:
                continue
            seen_ids.add(item_id)
            scanned += 1
            if item.get("ext", "").lower() not in IMAGE_EXTS:
                continue
            if item.get("tags") and not retag:
                continue
            todo.append(item)
            if limit > 0 and len(todo) >= limit:
                limit_reached = True
                return todo, scanned, limit_reached
    return todo, scanned, limit_reached


def build_tags(general, characters, rating, max_tags, include_rating):
    """组合标签，并保证最终数量不超过 max_tags。"""
    tags = [name for name, _ in characters] + [name for name, _ in general]
    if include_rating and rating:
        return tags[: max_tags - 1] + [f"rating:{rating}"]
    return tags[:max_tags]


def image_has_transparency(image):
    """Return whether the source image contains any genuinely transparent pixels."""
    if image.mode in ("RGBA", "LA"):
        alpha = image.getchannel("A")
        return alpha.getextrema()[0] < 255
    return image.mode == "P" and "transparency" in image.info


def filter_graphic_false_positives(
    item_name,
    image_size,
    general,
    characters,
    has_transparency=False,
    enabled=True,
):
    """Suppress WD14 person hallucinations on obvious logos and wordmarks.

    The guard deliberately requires multiple signals, so normal illustrations are
    not changed merely because they use a simple or monochrome background.
    """
    if not enabled:
        return general, characters, []

    width, height = image_size
    short_side = max(1, min(width, height))
    aspect_ratio = max(width, height) / short_side
    predicted = {name for name, _score in general}
    signal_count = len(predicted & GRAPHIC_SIGNAL_TAGS)
    explicit_graphic_name = bool(GRAPHIC_NAME_RE.search(str(item_name or "")))
    likely_graphic = (
        explicit_graphic_name and (aspect_ratio >= 3 or signal_count >= 3)
    ) or (aspect_ratio >= 5 and signal_count >= 3)
    if not likely_graphic:
        return general, characters, []

    removed = []
    filtered_general = []
    for tag in general:
        name = tag[0]
        if name in GRAPHIC_PERSON_TAGS or (
            has_transparency and name == "white_background"
        ):
            removed.append(name)
        else:
            filtered_general.append(tag)

    if characters:
        removed.extend(name for name, _score in characters)
    filtered_characters = []

    if explicit_graphic_name and not any(name == "logo" for name, _ in filtered_general):
        filtered_general.insert(0, ("logo", 1.0))

    return filtered_general, filtered_characters, removed


def batched(items, batch_size):
    """按固定大小切分任务，最后一批可以不足 batch_size。"""
    for start in range(0, len(items), batch_size):
        yield items[start : start + batch_size]


def main():
    cfg = load_config()
    try:
        validate_config(cfg)
    except (KeyError, TypeError, ValueError) as e:
        sys.exit(f"[配置] {e}")
    ap = argparse.ArgumentParser(description="Eagle auto tagger (WD14)")
    ap.add_argument("--dry-run", action="store_true", help="只打印结果，不写入 Eagle")
    ap.add_argument("--limit", type=int, default=0, help="最多处理多少张（0 = 全部）")
    ap.add_argument(
        "--folder",
        action="append",
        default=None,
        help="只处理指定 Eagle 文件夹 ID；可重复使用以选择多个文件夹",
    )
    ap.add_argument("--retag", action="store_true", help="已有 tag 的也重新打标（默认跳过）")
    ap.add_argument("--yes", action="store_true", help="配合 --retag 跳过覆盖确认")
    ap.add_argument("--threshold", type=float, default=cfg["general_threshold"], help="general tag 阈值")
    ap.add_argument("--char-threshold", type=float, default=cfg["character_threshold"], help="角色 tag 阈值")
    args = ap.parse_args()
    if args.limit < 0:
        ap.error("--limit 不能小于 0")
    if not 0 <= args.threshold <= 1:
        ap.error("--threshold 必须在 0 到 1 之间")
    if not 0 <= args.char_threshold <= 1:
        ap.error("--char-threshold 必须在 0 到 1 之间")

    if args.retag and not args.dry_run and not args.yes:
        confirm = input("[警告] --retag 会覆盖已有标签。输入 RETAG 继续：").strip()
        if confirm != "RETAG":
            print("已取消，未修改 Eagle。")
            return

    eagle = EagleClient(cfg["eagle_url"], cfg["eagle_token"])
    try:
        info = eagle.app_info()
        print(f"[eagle] 已连接，版本 {info.get('version', '?')}")
    except Exception as e:
        sys.exit(f"[eagle] 连不上 Eagle（{cfg['eagle_url']}）。请确认 Eagle 已打开。\n{e}")

    print("[eagle] 扫描库中条目...")
    todo, scanned, limit_reached = collect_todo(
        eagle, folder=args.folder, retag=args.retag, limit=args.limit
    )
    scope = "已扫描" if limit_reached else "共扫描"
    print(
        f"[eagle] {scope} {scanned} 个条目，待打标 {len(todo)} 张"
        + ("（dry-run，不会写入）" if args.dry_run else "")
    )
    if not todo:
        return

    print(f"[model] 加载 {cfg['model_repo']}（首次运行会自动下载权重）...")
    t0 = time.time()
    tagger = WD14Tagger(
        cfg["model_repo"],
        mirrors=cfg["model_mirrors"],
        revision=cfg.get("model_revision", "main"),
        hashes=cfg.get("model_hashes"),
        sizes=cfg.get("model_sizes"),
    )
    print(
        f"[model] 就绪，用时 {time.time() - t0:.1f}s，推理后端: {tagger.provider}，"
        f"批量: {cfg['batch_size']} 张"
    )

    errors = []
    t0 = time.time()
    completed = 0
    for item_batch in batched(todo, cfg["batch_size"]):
        loaded = []
        for item in item_batch:
            try:
                path = eagle.item_file_path(item)
                with Image.open(path) as source:
                    image = ImageOps.exif_transpose(source).copy()
                loaded.append((item, image))
            except Exception as e:
                completed += 1
                errors.append((item["id"], item.get("name", ""), str(e)))
                print(
                    f"  [{completed}/{len(todo)}] {item.get('name', item['id'])}: "
                    f"读取失败 - {e}"
                )

        if not loaded:
            continue

        try:
            results = tagger.predict_batch(
                [image for _, image in loaded], args.threshold, args.char_threshold
            )
        except Exception as batch_error:
            print(f"  [提示] 本批推理失败，自动改为逐张重试：{batch_error}")
            results = []
            for item, image in loaded:
                try:
                    results.append(
                        tagger.predict(image, args.threshold, args.char_threshold)
                    )
                except Exception as e:
                    results.append(e)

        for (item, image), result in zip(loaded, results):
            image.close()
            completed += 1
            if isinstance(result, Exception):
                errors.append((item["id"], item.get("name", ""), str(result)))
                print(
                    f"  [{completed}/{len(todo)}] {item.get('name', item['id'])}: "
                    f"推理失败 - {result}"
                )
                continue

            try:
                general, characters, rating = result
                tags = build_tags(
                    general,
                    characters,
                    rating,
                    cfg["max_tags"],
                    cfg["include_rating"],
                )
                if args.dry_run:
                    print(
                        f"  [{completed}/{len(todo)}] {item.get('name', item['id'])}: "
                        f"{', '.join(tags)}"
                    )
                else:
                    eagle.update_tags(item["id"], tags)
                    rate = completed / (time.time() - t0)
                    eta = (len(todo) - completed) / rate if rate > 0 else 0
                    print(
                        f"  [{completed}/{len(todo)}] {item.get('name', item['id'])}: "
                        f"{len(tags)} tags | {rate:.2f} 张/秒 | 剩余约 {eta / 60:.0f} 分钟"
                    )
            except Exception as e:
                errors.append((item["id"], item.get("name", ""), str(e)))
                print(
                    f"  [{completed}/{len(todo)}] {item.get('name', item['id'])}: "
                    f"写入失败 - {e}"
                )

    elapsed = time.time() - t0
    print(f"\n完成：{len(todo) - len(errors)} 成功 / {len(errors)} 失败，共 {elapsed / 60:.1f} 分钟")
    if errors:
        log = HERE / "errors.log"
        with open(log, "a", encoding="utf-8") as f:
            for item_id, name, err in errors:
                f.write(f"{item_id}\t{name}\t{err}\n")
        print(f"失败明细已写入 {log}")


if __name__ == "__main__":
    main()
