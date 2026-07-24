from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

import sys

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "eagle-plugin" / "engine"))

from tag_history import execute  # noqa: E402


class TagHistoryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.database = Path(self.temporary.name) / "other-drive" / "history.sqlite3"
        self.context = {
            "model_repo": "example/model",
            "model_revision": "revision-1",
            "signature": "signature-1",
            "settings": {
                "general_threshold": 0.35,
                "character_threshold": 0.75,
                "max_tags": 50,
                "include_rating": True,
                "filter_graphic_person_tags": True,
            },
        }

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def record(self, item_id: str, tags: list[str]) -> None:
        result = execute(
            self.database,
            "record",
            {
                **self.context,
                "records": [{"id": item_id, "generated_tags": tags}],
            },
        )
        self.assertEqual(result["recorded"], 1)

    def test_creates_database_in_custom_parent(self) -> None:
        result = execute(self.database, "status", {})
        self.assertTrue(result["ok"])
        self.assertEqual(result["count"], 0)
        self.assertEqual(result["integrity"], "ok")
        self.assertTrue(self.database.exists())

    def test_same_signature_and_existing_model_tags_are_skipped(self) -> None:
        self.record("item-1", ["blue_hair", "Solo"])
        result = execute(
            self.database,
            "filter",
            {
                "signature": "signature-1",
                "items": [
                    {
                        "id": "item-1",
                        "tags": ["手动标签", "BLUE_HAIR", "solo", "另一个手动标签"],
                    }
                ],
            },
        )
        self.assertEqual(result["skipped_ids"], ["item-1"])
        self.assertEqual(result["pending_ids"], [])

    def test_deleted_model_tag_or_changed_settings_requeues_item(self) -> None:
        self.record("item-1", ["blue_hair", "solo"])
        missing_tag = execute(
            self.database,
            "filter",
            {
                "signature": "signature-1",
                "items": [{"id": "item-1", "tags": ["blue_hair", "手动标签"]}],
            },
        )
        changed_signature = execute(
            self.database,
            "filter",
            {
                "signature": "signature-2",
                "items": [{"id": "item-1", "tags": ["blue_hair", "solo"]}],
            },
        )
        self.assertEqual(missing_tag["pending_ids"], ["item-1"])
        self.assertEqual(changed_signature["pending_ids"], ["item-1"])

    def test_latest_processing_state_replaces_previous_state(self) -> None:
        self.record("item-1", ["old_tag"])
        self.context["signature"] = "signature-2"
        self.context["settings"]["general_threshold"] = 0.5
        self.record("item-1", ["new_tag", "NEW_TAG"])

        with sqlite3.connect(self.database) as connection:
            row = connection.execute(
                """
                SELECT signature, settings_json, generated_tags_json
                FROM item_history WHERE item_id=?
                """,
                ("item-1",),
            ).fetchone()
        self.assertEqual(row[0], "signature-2")
        self.assertEqual(json.loads(row[1])["general_threshold"], 0.5)
        self.assertEqual(json.loads(row[2]), ["new_tag"])


if __name__ == "__main__":
    unittest.main()
