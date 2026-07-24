"""Persistent processing history for the ds Eagle Tagger plugin.

The helper intentionally uses only Python's standard library so it can run in
the same private environment as the inference engine without another package.
It communicates with the Eagle plugin through one JSON request on stdin and
one JSON response on stdout.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
import unicodedata
from pathlib import Path
from typing import Any, Iterable


SCHEMA_VERSION = 1


def tag_key(value: Any) -> str:
    return unicodedata.normalize("NFKC", str(value or "").strip()).casefold()


def unique_tags(values: Any) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values if isinstance(values, list) else []:
        tag = str(value or "").strip()
        key = tag_key(tag)
        if not key or key in seen:
            continue
        seen.add(key)
        result.append(tag)
    return result


def open_database(database_path: str | Path) -> sqlite3.Connection:
    path = Path(database_path).expanduser()
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(str(path), timeout=5)
    connection.execute("PRAGMA journal_mode=DELETE")
    connection.execute("PRAGMA synchronous=NORMAL")
    connection.execute("PRAGMA busy_timeout=5000")
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS item_history (
            item_id TEXT PRIMARY KEY,
            model_repo TEXT NOT NULL,
            model_revision TEXT NOT NULL,
            signature TEXT NOT NULL,
            settings_json TEXT NOT NULL,
            generated_tags_json TEXT NOT NULL,
            processed_at INTEGER NOT NULL
        )
        """
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_item_history_signature "
        "ON item_history(signature)"
    )
    connection.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
    connection.commit()
    return connection


def batched(values: list[str], size: int = 500) -> Iterable[list[str]]:
    for start in range(0, len(values), size):
        yield values[start : start + size]


def load_records(
    connection: sqlite3.Connection, item_ids: list[str]
) -> dict[str, tuple[str, str]]:
    records: dict[str, tuple[str, str]] = {}
    for group in batched(item_ids):
        placeholders = ",".join("?" for _ in group)
        rows = connection.execute(
            f"""
            SELECT item_id, signature, generated_tags_json
            FROM item_history
            WHERE item_id IN ({placeholders})
            """,
            group,
        )
        for item_id, signature, generated_tags_json in rows:
            records[item_id] = (signature, generated_tags_json)
    return records


def filter_items(
    connection: sqlite3.Connection, signature: str, items: Any
) -> dict[str, list[str]]:
    source_items = items if isinstance(items, list) else []
    clean_items = [
        item
        for item in source_items
        if isinstance(item, dict) and str(item.get("id") or "").strip()
    ]
    item_ids = [str(item["id"]) for item in clean_items]
    records = load_records(connection, item_ids)
    pending_ids: list[str] = []
    skipped_ids: list[str] = []

    for item in clean_items:
        item_id = str(item["id"])
        record = records.get(item_id)
        if not record or record[0] != signature:
            pending_ids.append(item_id)
            continue
        try:
            generated_tags = unique_tags(json.loads(record[1]))
        except (TypeError, ValueError, json.JSONDecodeError):
            pending_ids.append(item_id)
            continue
        current_keys = {tag_key(tag) for tag in item.get("tags", []) if tag_key(tag)}
        generated_keys = {tag_key(tag) for tag in generated_tags if tag_key(tag)}
        if generated_keys.issubset(current_keys):
            skipped_ids.append(item_id)
        else:
            pending_ids.append(item_id)

    return {"pending_ids": pending_ids, "skipped_ids": skipped_ids}


def record_items(connection: sqlite3.Connection, payload: dict[str, Any]) -> int:
    model_repo = str(payload.get("model_repo") or "").strip()
    model_revision = str(payload.get("model_revision") or "").strip()
    signature = str(payload.get("signature") or "").strip()
    settings = payload.get("settings")
    records = payload.get("records")
    if not model_repo or not model_revision or not signature:
        raise ValueError("model_repo、model_revision 和 signature 不能为空")
    if not isinstance(settings, dict) or not isinstance(records, list):
        raise ValueError("settings 必须是对象，records 必须是数组")

    settings_json = json.dumps(
        settings, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    processed_at = int(time.time())
    rows: list[tuple[str, str, str, str, str, str, int]] = []
    for record in records:
        if not isinstance(record, dict):
            continue
        item_id = str(record.get("id") or "").strip()
        if not item_id:
            continue
        tags_json = json.dumps(
            unique_tags(record.get("generated_tags")),
            ensure_ascii=False,
            separators=(",", ":"),
        )
        rows.append(
            (
                item_id,
                model_repo,
                model_revision,
                signature,
                settings_json,
                tags_json,
                processed_at,
            )
        )

    with connection:
        connection.executemany(
            """
            INSERT INTO item_history (
                item_id, model_repo, model_revision, signature, settings_json,
                generated_tags_json, processed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(item_id) DO UPDATE SET
                model_repo=excluded.model_repo,
                model_revision=excluded.model_revision,
                signature=excluded.signature,
                settings_json=excluded.settings_json,
                generated_tags_json=excluded.generated_tags_json,
                processed_at=excluded.processed_at
            """,
            rows,
        )
    return len(rows)


def status(connection: sqlite3.Connection, database_path: str | Path) -> dict[str, Any]:
    count = connection.execute("SELECT COUNT(*) FROM item_history").fetchone()[0]
    integrity = connection.execute("PRAGMA quick_check").fetchone()[0]
    return {
        "ok": True,
        "path": str(Path(database_path).resolve()),
        "count": int(count),
        "integrity": str(integrity),
        "schema_version": SCHEMA_VERSION,
    }


def execute(database_path: str | Path, operation: str, payload: dict[str, Any]) -> dict[str, Any]:
    with open_database(database_path) as connection:
        if operation == "status":
            return status(connection, database_path)
        if operation == "filter":
            signature = str(payload.get("signature") or "").strip()
            if not signature:
                raise ValueError("signature 不能为空")
            result = filter_items(connection, signature, payload.get("items"))
            return {"ok": True, **result}
        if operation == "record":
            recorded = record_items(connection, payload)
            return {"ok": True, "recorded": recorded}
        raise ValueError(f"未知操作：{operation}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("operation", choices=("status", "filter", "record"))
    args = parser.parse_args()
    try:
        raw = sys.stdin.read().strip()
        payload = json.loads(raw) if raw else {}
        if not isinstance(payload, dict):
            raise ValueError("输入必须是 JSON 对象")
        response = execute(args.db, args.operation, payload)
    except Exception as error:  # The plugin needs a compact actionable error.
        response = {"ok": False, "error": str(error)}
        print(json.dumps(response, ensure_ascii=False), flush=True)
        return 1
    print(json.dumps(response, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
