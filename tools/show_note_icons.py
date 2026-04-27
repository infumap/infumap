#!/usr/bin/env python3
"""
Set ShowDesktopPopupIcon on existing note items in an Infumap items.json file.

For the real database file, items.json is a JSON-lines log. This script replays
that log, finds live note items whose flags do not include the note popup icon
bit, and appends update records for those items.

It also supports plain JSON exports containing item objects, in which case it
updates note objects in the JSON tree and writes a rewritten JSON document.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path
from typing import Any


NOTE_POPUP_ICON_FLAG = 0x800


def is_note_record(value: Any) -> bool:
    return isinstance(value, dict) and value.get("itemType") == "note"


def flags_value(record: dict[str, Any], path: str) -> int:
    raw = record.get("flags", 0)
    if raw is None:
        return 0
    if not isinstance(raw, int):
        raise ValueError(f"{path}: expected integer flags on note {record.get('id')!r}, got {raw!r}")
    return raw


def parse_jsonl_records(text: str) -> list[dict[str, Any]] | None:
    records: list[dict[str, Any]] = []
    saw_record_type = False
    for line_number, line in enumerate(text.splitlines(), start=1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as exc:
            if records:
                raise ValueError(f"line {line_number}: invalid JSON: {exc}") from exc
            return None
        if not isinstance(value, dict):
            return None
        if "__recordType" in value:
            saw_record_type = True
        records.append(value)
    return records if saw_record_type else None


def replay_live_items(records: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    live_items: dict[str, dict[str, Any]] = {}
    for line_number, record in enumerate(records, start=1):
        record_type = record.get("__recordType")
        if record_type == "descriptor":
            continue
        if record_type == "entry":
            item_id = record.get("id")
            if not isinstance(item_id, str):
                raise ValueError(f"line {line_number}: entry record is missing string id")
            live_items[item_id] = dict(record)
            continue
        if record_type == "update":
            item_id = record.get("id")
            if not isinstance(item_id, str):
                raise ValueError(f"line {line_number}: update record is missing string id")
            if item_id not in live_items:
                raise ValueError(f"line {line_number}: update references unknown id {item_id!r}")
            for key, value in record.items():
                if key not in ("__recordType", "id"):
                    live_items[item_id][key] = value
            continue
        if record_type == "delete":
            item_id = record.get("id")
            if not isinstance(item_id, str):
                raise ValueError(f"line {line_number}: delete record is missing string id")
            live_items.pop(item_id, None)
            continue
        raise ValueError(f"line {line_number}: unknown __recordType {record_type!r}")
    return live_items


def update_records_for_jsonl(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    live_items = replay_live_items(records)
    updates: list[dict[str, Any]] = []
    for item_id in sorted(live_items):
        item = live_items[item_id]
        if not is_note_record(item):
            continue
        flags = flags_value(item, f"item {item_id}")
        new_flags = flags | NOTE_POPUP_ICON_FLAG
        if new_flags != flags:
            updates.append({
                "__recordType": "update",
                "id": item_id,
                "flags": new_flags,
            })
    return updates


def update_plain_json(value: Any, path: str = "$") -> int:
    changed = 0
    if isinstance(value, dict):
        if is_note_record(value):
            flags = flags_value(value, path)
            new_flags = flags | NOTE_POPUP_ICON_FLAG
            if new_flags != flags:
                value["flags"] = new_flags
                changed += 1
        for key, child in value.items():
            changed += update_plain_json(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            changed += update_plain_json(child, f"{path}[{index}]")
    return changed


def default_output_path(input_path: Path) -> Path:
    return input_path.with_name(f"{input_path.name}.with-note-icons")


def backup_path_for(input_path: Path) -> Path:
    candidate = input_path.with_name(f"{input_path.name}.bak")
    if not candidate.exists():
        return candidate
    index = 1
    while True:
        candidate = input_path.with_name(f"{input_path.name}.bak{index}")
        if not candidate.exists():
            return candidate
        index += 1


def write_jsonl_output(input_path: Path, output_path: Path, original_text: str, updates: list[dict[str, Any]]) -> None:
    output_text = original_text
    if updates:
        if output_text and not output_text.endswith("\n"):
            output_text += "\n"
        output_text += "\n".join(json.dumps(update, separators=(",", ":")) for update in updates)
        output_text += "\n"
    output_path.write_text(output_text, encoding="utf-8")


def update_file(args: argparse.Namespace) -> int:
    input_path = Path(args.items_json)
    if not input_path.exists():
        raise FileNotFoundError(input_path)
    original_text = input_path.read_text(encoding="utf-8")
    output_path = input_path if args.in_place else Path(args.output or default_output_path(input_path))

    jsonl_records = parse_jsonl_records(original_text)
    if jsonl_records is not None:
        updates = update_records_for_jsonl(jsonl_records)
        if args.dry_run:
            print(f"Would append {len(updates)} note icon update record(s).")
            return 0
        if args.in_place and updates and not args.no_backup:
            backup_path = backup_path_for(input_path)
            shutil.copy2(input_path, backup_path)
            print(f"Backup written to {backup_path}")
        write_jsonl_output(input_path, output_path, original_text, updates)
        print(f"Appended {len(updates)} note icon update record(s) to {output_path}")
        return 0

    value = json.loads(original_text)
    changed = update_plain_json(value)
    if args.dry_run:
        print(f"Would update {changed} note object(s).")
        return 0
    if args.in_place and changed and not args.no_backup:
        backup_path = backup_path_for(input_path)
        shutil.copy2(input_path, backup_path)
        print(f"Backup written to {backup_path}")
    output_path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Updated {changed} note object(s) in {output_path}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Set the note popup icon visibility flag on existing notes in an items.json file.",
    )
    parser.add_argument("items_json", help="Path to items.json or a plain JSON item export.")
    parser.add_argument("output", nargs="?", help="Output path. Defaults to <items_json>.with-note-icons.")
    parser.add_argument("--in-place", action="store_true", help="Modify items_json in place.")
    parser.add_argument("--no-backup", action="store_true", help="Do not create a .bak file when using --in-place.")
    parser.add_argument("--dry-run", action="store_true", help="Report how many notes would change without writing.")
    args = parser.parse_args()

    if args.in_place and args.output:
        parser.error("output path cannot be used with --in-place")

    return update_file(args)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1)
