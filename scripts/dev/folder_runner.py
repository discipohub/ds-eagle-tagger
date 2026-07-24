"""开发用交互运行器：粘贴 Eagle 文件夹链接后调用插件引擎。"""
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse


FOLDER_ID_RE = re.compile(r"^[A-Za-z0-9_-]{6,128}$")
PROJECT_ROOT = Path(__file__).resolve().parents[2]
ENGINE_ROOT = PROJECT_ROOT / "eagle-plugin" / "engine"


def parse_folder_id(value):
    """接受 localhost 链接、eagle:// 链接或纯文件夹 ID。"""
    text = value.strip().strip('"').strip("'")
    if not text:
        raise ValueError("没有输入链接")

    parsed = urlparse(text)
    folder_id = None
    if parsed.scheme in {"http", "https"}:
        folder_id = parse_qs(parsed.query).get("id", [None])[0]
    elif parsed.scheme == "eagle":
        folder_id = parsed.path.rstrip("/").split("/")[-1] or parsed.netloc
    elif FOLDER_ID_RE.fullmatch(text):
        folder_id = text

    if not folder_id or not FOLDER_ID_RE.fullmatch(folder_id):
        raise ValueError("无法从输入内容中识别 Eagle 文件夹 ID")
    return folder_id


def find_folder(folders, folder_id, parents=()):
    """在 Eagle 文件夹树中查找 ID，并返回 (folder, 完整路径)。"""
    for folder in folders:
        path = (*parents, folder.get("name", folder.get("id", "?")))
        if folder.get("id") == folder_id:
            return folder, " / ".join(path)
        found = find_folder(folder.get("children") or [], folder_id, path)
        if found:
            return found
    return None


def count_folder_images(eagle, folder_id, image_exts):
    """按 Eagle API 的实际筛选范围统计图片及未标签图片。"""
    image_count = 0
    untagged_count = 0
    for item in eagle.iter_items(folder=folder_id):
        if item.get("ext", "").lower() not in image_exts:
            continue
        image_count += 1
        if not item.get("tags"):
            untagged_count += 1
    return image_count, untagged_count


def count_selected_folder_images(eagle, folder_ids, image_exts):
    """统计各文件夹，并按条目 ID 计算跨文件夹去重后的合计。"""
    details = {}
    image_ids = set()
    untagged_ids = set()
    for folder_id in folder_ids:
        folder_image_ids = set()
        folder_untagged_ids = set()
        for item in eagle.iter_items(folder=folder_id):
            if item.get("ext", "").lower() not in image_exts:
                continue
            item_id = item["id"]
            folder_image_ids.add(item_id)
            image_ids.add(item_id)
            if not item.get("tags"):
                folder_untagged_ids.add(item_id)
                untagged_ids.add(item_id)
        details[folder_id] = (len(folder_image_ids), len(folder_untagged_ids))
    return details, len(image_ids), len(untagged_ids)


def read_folder_ids():
    """逐行读取链接；空行结束，并忽略重复 ID。"""
    folder_ids = []
    while True:
        raw = input(f"文件夹 {len(folder_ids) + 1} > ").strip()
        if not raw:
            if folder_ids:
                return folder_ids
            print("请至少粘贴一个 Eagle 文件夹链接。")
            continue
        try:
            folder_id = parse_folder_id(raw)
        except ValueError as e:
            print(f"  [输入错误] {e}，请重新输入。")
            continue
        if folder_id in folder_ids:
            print("  [已忽略] 这个文件夹已经添加过。")
            continue
        folder_ids.append(folder_id)
        print("  已添加。继续粘贴下一个；添加完成后直接按回车。")


def main():
    from eagle_api import EagleClient
    from tagger import IMAGE_EXTS, load_config

    print("=" * 64)
    print("Eagle 多文件夹自动打标")
    print("=" * 64)
    print("请逐行粘贴 Eagle 文件夹链接，例如：")
    print("http://localhost:41595/folder?id=YOUR_EAGLE_FOLDER_ID")
    print("每输入一个链接按回车；全部添加完成后，再直接按一次回车。")
    print()
    folder_ids = read_folder_ids()

    cfg = load_config()
    eagle = EagleClient(cfg["eagle_url"], cfg["eagle_token"])
    try:
        app = eagle.app_info()
        folder_tree = eagle.list_folders()
    except Exception as e:
        print(f"\n[Eagle] 连接或读取文件夹失败：{e}")
        print("请确认 Eagle 已打开，并且当前图库正确。")
        return 3

    selected = []
    missing = []
    for folder_id in folder_ids:
        found = find_folder(folder_tree, folder_id)
        if found:
            folder, folder_path = found
            selected.append((folder_id, folder, folder_path))
        else:
            missing.append(folder_id)

    if missing:
        print("\n[Eagle] 当前图库中找不到以下文件夹：")
        for folder_id in missing:
            print(f"  - {folder_id}")
        print("请确认链接来自当前打开的 Eagle 图库。")
        return 4

    try:
        details, image_count, untagged_count = count_selected_folder_images(
            eagle, folder_ids, IMAGE_EXTS
        )
    except Exception as e:
        print(f"\n[Eagle] 统计文件夹图片失败：{e}")
        return 5

    print()
    print(f"已连接 Eagle {app.get('version', '?')}")
    print(f"已选择 {len(selected)} 个文件夹：")
    for index, (folder_id, _folder, folder_path) in enumerate(selected, 1):
        folder_images, folder_untagged = details[folder_id]
        print(
            f"  {index}. {folder_path}（图片 {folder_images}，"
            f"未标签 {folder_untagged}）"
        )
    print(f"去重后图片总数：{image_count}")
    print(f"去重后待处理未标签图片：{untagged_count}")
    print()
    print("即将处理以上 Eagle 文件夹中所有尚未打标签的图片。")
    print("已有标签的图片会自动跳过；图片文件本身不会被修改。")
    print()

    if untagged_count == 0:
        print("所选文件夹没有需要处理的未标签图片。")
        return 0

    confirm = input("是否开始处理？输入 Y 开始，输入 N 取消 [Y/N] > ").strip().upper()
    if confirm != "Y":
        print("\n已取消，没有修改 Eagle。")
        return 0

    print("\n已确认，开始自动打标...\n")
    command = [sys.executable, str(ENGINE_ROOT / "tagger.py")]
    for folder_id in folder_ids:
        command.extend(["--folder", folder_id])
    return subprocess.call(command, cwd=str(ENGINE_ROOT))


if __name__ == "__main__":
    raise SystemExit(main())
