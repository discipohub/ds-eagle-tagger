import hashlib
import sys
import tempfile
import types
import unittest
from pathlib import Path

# 这些测试只覆盖纯逻辑；允许在未安装联网依赖的检查环境中运行。
sys.modules.setdefault("requests", types.ModuleType("requests"))
PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "eagle-plugin" / "engine"))
sys.path.insert(0, str(PROJECT_ROOT / "scripts" / "dev"))

from tagger import batched, build_tags, collect_todo, filter_graphic_false_positives
from wd14 import IntegrityError, _download_file, _validate_file
from folder_runner import (
    count_folder_images,
    count_selected_folder_images,
    find_folder,
    parse_folder_id,
)


class FakeEagle:
    def __init__(self, items):
        self.items = items

    def iter_items(self, folder=None):
        yield from self.items


class FolderFakeEagle:
    def __init__(self, items_by_folder):
        self.items_by_folder = items_by_folder

    def iter_items(self, folder=None):
        yield from self.items_by_folder.get(folder, [])


class CoreTests(unittest.TestCase):
    def test_parse_folder_link_and_plain_id(self):
        folder_id = "TESTFOLDER123"
        self.assertEqual(
            parse_folder_id(f"http://localhost:41595/folder?id={folder_id}"), folder_id
        )
        self.assertEqual(parse_folder_id(folder_id), folder_id)

    def test_find_nested_folder(self):
        folders = [
            {
                "id": "PARENT1",
                "name": "父文件夹",
                "children": [{"id": "CHILD123", "name": "子文件夹"}],
            }
        ]
        folder, path = find_folder(folders, "CHILD123")
        self.assertEqual(folder["name"], "子文件夹")
        self.assertEqual(path, "父文件夹 / 子文件夹")

    def test_count_folder_images(self):
        items = [
            {"id": "1", "ext": "jpg", "tags": []},
            {"id": "2", "ext": "png", "tags": ["manual"]},
            {"id": "3", "ext": "mp4", "tags": []},
        ]
        total, untagged = count_folder_images(
            FakeEagle(items), "FOLDER1", {"jpg", "png"}
        )
        self.assertEqual((total, untagged), (2, 1))

    def test_collect_todo_stops_at_limit(self):
        items = [
            {"id": "1", "ext": "txt", "tags": []},
            {"id": "2", "ext": "jpg", "tags": ["manual"]},
            {"id": "3", "ext": "png", "tags": []},
            {"id": "4", "ext": "webp", "tags": []},
            {"id": "5", "ext": "jpg", "tags": []},
        ]
        todo, scanned, limit_reached = collect_todo(FakeEagle(items), limit=2)
        self.assertEqual([item["id"] for item in todo], ["3", "4"])
        self.assertEqual(scanned, 4)
        self.assertTrue(limit_reached)

    def test_collect_todo_deduplicates_multiple_folders(self):
        shared = {"id": "2", "ext": "png", "tags": []}
        eagle = FolderFakeEagle(
            {
                "A": [{"id": "1", "ext": "jpg", "tags": []}, shared],
                "B": [shared, {"id": "3", "ext": "webp", "tags": []}],
            }
        )
        todo, scanned, limit_reached = collect_todo(eagle, folder=["A", "B"])
        self.assertEqual([item["id"] for item in todo], ["1", "2", "3"])
        self.assertEqual(scanned, 3)
        self.assertFalse(limit_reached)

    def test_count_selected_folders_reports_unique_total(self):
        shared = {"id": "2", "ext": "png", "tags": []}
        eagle = FolderFakeEagle(
            {
                "A": [{"id": "1", "ext": "jpg", "tags": ["tag"]}, shared],
                "B": [shared, {"id": "3", "ext": "webp", "tags": []}],
            }
        )
        details, total, untagged = count_selected_folder_images(
            eagle, ["A", "B"], {"jpg", "png", "webp"}
        )
        self.assertEqual(details, {"A": (2, 1), "B": (2, 2)})
        self.assertEqual((total, untagged), (3, 2))

    def test_build_tags_respects_total_limit_with_rating(self):
        general = [("g1", 0.9), ("g2", 0.8), ("g3", 0.7)]
        characters = [("c1", 0.95)]
        tags = build_tags(general, characters, "general", 3, True)
        self.assertEqual(tags, ["c1", "g1", "rating:general"])
        self.assertEqual(len(tags), 3)

    def test_graphic_guard_removes_person_hallucinations_from_logo(self):
        general = [
            ("monochrome", 0.93),
            ("solo", 0.89),
            ("1girl", 0.89),
            ("transparent_background", 0.71),
            ("greyscale", 0.64),
            ("simple_background", 0.64),
            ("white_background", 0.52),
            ("looking_at_viewer", 0.50),
            ("smile", 0.45),
            ("open_mouth", 0.45),
            ("short_hair", 0.36),
        ]
        filtered, characters, removed = filter_graphic_false_positives(
            "logo", (803, 88), general, [], has_transparency=True
        )
        names = [name for name, _score in filtered]
        self.assertEqual(names[0], "logo")
        self.assertIn("transparent_background", names)
        self.assertNotIn("1girl", names)
        self.assertNotIn("white_background", names)
        self.assertEqual(characters, [])
        self.assertIn("looking_at_viewer", removed)

    def test_graphic_guard_leaves_normal_illustration_unchanged(self):
        general = [
            ("1girl", 0.91),
            ("solo", 0.88),
            ("simple_background", 0.70),
        ]
        filtered, characters, removed = filter_graphic_false_positives(
            "character concept", (1200, 1600), general, [], has_transparency=False
        )
        self.assertEqual(filtered, general)
        self.assertEqual(characters, [])
        self.assertEqual(removed, [])

    def test_batched_uses_requested_size(self):
        self.assertEqual(list(batched([1, 2, 3, 4, 5], 4)), [[1, 2, 3, 4], [5]])

    def test_validate_file_checks_size_and_hash(self):
        payload = b"verified model fixture"
        expected_hash = hashlib.sha256(payload).hexdigest()
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "fixture.bin"
            path.write_bytes(payload)
            _validate_file(path, expected_hash, len(payload))
            with self.assertRaises(IntegrityError):
                _validate_file(path, "0" * 64, len(payload))

    def test_cached_model_reports_checking_and_complete_progress(self):
        payload = b"cached model fixture"
        expected_hash = hashlib.sha256(payload).hexdigest()
        events = []
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "model.onnx"
            path.write_bytes(payload)
            result = _download_file(
                "example/model",
                "model.onnx",
                Path(tmp_dir),
                expected_sha256=expected_hash,
                expected_size=len(payload),
                progress_callback=lambda **event: events.append(event),
            )
        self.assertEqual(result.name, "model.onnx")
        self.assertEqual([event["stage"] for event in events], ["checking", "complete"])
        self.assertEqual(events[-1]["total_bytes"], len(payload))


if __name__ == "__main__":
    unittest.main()
