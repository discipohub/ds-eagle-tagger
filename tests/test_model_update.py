from __future__ import annotations

import unittest
import hashlib
import json
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "eagle-plugin" / "engine"))

from model_update import (
    choose_update,
    import_local_release,
    install_release,
    release_is_compatible,
    selection_payload,
    validate_catalog,
)
from wd14 import model_cache_dir
from tagger import load_config


def release(identifier: str, sequence: int, revision: str, minimum: str = "0.5.0"):
    return {
        "id": identifier,
        "sequence": sequence,
        "name": f"Model {sequence}",
        "version": f"v{sequence}",
        "model_repo": "owner/model",
        "model_revision": revision,
        "min_engine_version": minimum,
        "model_hashes": {
            "model.onnx": "a" * 64,
            "selected_tags.csv": "b" * 64,
        },
        "model_sizes": {
            "model.onnx": 100,
            "selected_tags.csv": 20,
        },
        "model_mirrors": ["https://example.com"],
    }


class ModelUpdateTests(unittest.TestCase):
    def test_catalog_selects_newer_compatible_approved_release(self):
        first = release("r1", 1, "revision-one")
        second = release("r2", 2, "revision-two")
        releases = validate_catalog(
            {"schema_version": 1, "releases": [first, second]}
        )
        result = choose_update(
            {
                "model_id": "r1",
                "model_repo": "owner/model",
                "model_revision": "revision-one",
            },
            releases,
            "0.5.0",
        )
        self.assertTrue(result["update_available"])
        self.assertEqual(result["latest"]["id"], "r2")

    def test_incompatible_release_requests_plugin_update(self):
        first = release("r1", 1, "revision-one")
        future = release("r2", 2, "revision-two", minimum="0.6.0")
        result = choose_update(
            {
                "model_id": "r1",
                "model_repo": "owner/model",
                "model_revision": "revision-one",
            },
            [first, future],
            "0.5.0",
        )
        self.assertFalse(result["update_available"])
        self.assertTrue(result["plugin_update_required"])
        self.assertFalse(release_is_compatible(future, "0.5.0"))

    def test_selection_contains_locked_model_metadata(self):
        selected = selection_payload(release("r2", 2, "revision-two"))
        self.assertEqual(selected["model_revision"], "revision-two")
        self.assertEqual(selected["model_hashes"]["model.onnx"], "a" * 64)
        self.assertEqual(selected["model_sequence"], 2)

    def test_cache_is_versioned_by_revision(self):
        cache = model_cache_dir(
            "owner/model",
            "revision-two",
            base_dir=Path("X:/models"),
        )
        self.assertEqual(cache, Path("X:/models/model/revision-two"))

    def test_install_switches_only_after_cached_files_validate(self):
        with tempfile.TemporaryDirectory() as temporary:
            engine_root = Path(temporary)
            model_bytes = b"test-model"
            tags_bytes = b"name,category\nsample,0\n"
            approved = release("r2", 2, "revision-two")
            approved["model_hashes"] = {
                "model.onnx": hashlib.sha256(model_bytes).hexdigest(),
                "selected_tags.csv": hashlib.sha256(tags_bytes).hexdigest(),
            }
            approved["model_sizes"] = {
                "model.onnx": len(model_bytes),
                "selected_tags.csv": len(tags_bytes),
            }
            cache = model_cache_dir(
                approved["model_repo"],
                approved["model_revision"],
                base_dir=engine_root / "models",
            )
            cache.mkdir(parents=True)
            (cache / "model.onnx").write_bytes(model_bytes)
            (cache / "selected_tags.csv").write_bytes(tags_bytes)

            selection = install_release(approved, engine_root=engine_root)
            data = json.loads(selection.read_text(encoding="utf-8"))
            self.assertEqual(data["model_id"], "r2")
            self.assertEqual(data["model_revision"], "revision-two")

    def test_local_import_validates_and_switches_atomically(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "download"
            source.mkdir()
            model_bytes = b"offline-model"
            tags_bytes = b"name,category\nsample,0\n"
            model_path = source / "renamed-model.onnx"
            tags_path = source / "renamed-tags.csv"
            model_path.write_bytes(model_bytes)
            tags_path.write_bytes(tags_bytes)
            approved = release("r2", 2, "revision-two")
            approved["model_hashes"] = {
                "model.onnx": hashlib.sha256(model_bytes).hexdigest(),
                "selected_tags.csv": hashlib.sha256(tags_bytes).hexdigest(),
            }
            approved["model_sizes"] = {
                "model.onnx": len(model_bytes),
                "selected_tags.csv": len(tags_bytes),
            }

            selection = import_local_release(
                approved,
                model_path,
                tags_path,
                engine_root=root,
            )
            cache = model_cache_dir(
                approved["model_repo"],
                approved["model_revision"],
                base_dir=root / "models",
            )
            self.assertEqual((cache / "model.onnx").read_bytes(), model_bytes)
            self.assertEqual((cache / "selected_tags.csv").read_bytes(), tags_bytes)
            self.assertEqual(
                json.loads(selection.read_text(encoding="utf-8"))["model_id"],
                "r2",
            )

    def test_local_import_rejects_wrong_hash_without_replacing_cache(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            model_path = root / "model.onnx"
            tags_path = root / "selected_tags.csv"
            model_path.write_bytes(b"wrong-model")
            tags_path.write_bytes(b"tags")
            approved = release("r2", 2, "revision-two")
            approved["model_sizes"] = {
                "model.onnx": len(b"wrong-model"),
                "selected_tags.csv": len(b"tags"),
            }
            approved["model_hashes"] = {
                "model.onnx": hashlib.sha256(b"expected-model").hexdigest(),
                "selected_tags.csv": hashlib.sha256(b"tags").hexdigest(),
            }
            with self.assertRaisesRegex(ValueError, "SHA-256"):
                import_local_release(
                    approved,
                    model_path,
                    tags_path,
                    engine_root=root,
                )
            cache = model_cache_dir(
                approved["model_repo"],
                approved["model_revision"],
                base_dir=root / "models",
            )
            self.assertFalse((cache / "model.onnx").exists())

    def test_inference_config_uses_active_model_selection(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "config.json").write_text(
                json.dumps(
                    {
                        "model_repo": "owner/default",
                        "model_revision": "default-revision",
                    }
                ),
                encoding="utf-8",
            )
            (root / "model-selection.json").write_text(
                json.dumps(
                    {
                        "model_id": "r2",
                        "model_repo": "owner/model",
                        "model_revision": "revision-two",
                    }
                ),
                encoding="utf-8",
            )
            with patch("tagger.HERE", root):
                config = load_config()
            self.assertEqual(config["model_id"], "r2")
            self.assertEqual(config["model_revision"], "revision-two")


if __name__ == "__main__":
    unittest.main()
