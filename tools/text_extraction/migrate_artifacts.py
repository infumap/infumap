#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path

PDF_SOURCE_MIME_TYPE = "application/pdf"
MARKDOWN_CONTENT_MIME_TYPE = "text/markdown"


@dataclass
class MigrationStats:
    item_dirs_seen: int = 0
    manifests_moved: int = 0
    texts_moved: int = 0
    manifests_updated: int = 0
    dirs_removed: int = 0
    dirs_skipped: int = 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Migrate legacy extracted-text artifacts from per-item directories like "
            "'text/ab/<uid>/manifest.json' and 'text/ab/<uid>/stage1.md' to flat shard files "
            "like 'text/ab/<uid>_manifest.json' and 'text/ab/<uid>_text'."
        )
    )
    parser.add_argument("data_dir", type=Path, help="Infumap data directory (for example ~/.infumap/data)")
    parser.add_argument("--user-id", help="Only migrate artifacts for a single user id")
    parser.add_argument("--dry-run", action="store_true", help="Show planned moves without changing any files")
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Replace destination files if they already exist",
    )
    return parser.parse_args()


def iter_legacy_item_dirs(data_dir: Path, user_id: str | None):
    for user_dir in sorted(data_dir.glob("user_*")):
        if not user_dir.is_dir():
            continue
        current_user_id = user_dir.name.removeprefix("user_")
        if user_id is not None and current_user_id != user_id:
            continue

        text_dir = user_dir / "text"
        if not text_dir.is_dir():
            continue

        for shard_dir in sorted(text_dir.iterdir()):
            if not shard_dir.is_dir() or len(shard_dir.name) != 2:
                continue
            for item_dir in sorted(shard_dir.iterdir()):
                if item_dir.is_dir():
                    yield current_user_id, text_dir, item_dir


def destination_paths(text_dir: Path, item_id: str) -> tuple[Path, Path]:
    if len(item_id) < 2:
        raise ValueError(f"Item id '{item_id}' is too short to build a shard path")
    shard_dir = text_dir / item_id[:2]
    return shard_dir / f"{item_id}_manifest.json", shard_dir / f"{item_id}_text"


def is_text_extraction_manifest(manifest_data: object) -> bool:
    if not isinstance(manifest_data, dict):
        return False
    extractor = manifest_data.get("extractor")
    return isinstance(extractor, dict) and "text_extraction_url" in extractor


def normalize_text_extraction_manifest(manifest_data: dict) -> bool:
    changed = False
    if manifest_data.get("source_mime_type") != PDF_SOURCE_MIME_TYPE:
        manifest_data["source_mime_type"] = PDF_SOURCE_MIME_TYPE
        changed = True
    if manifest_data.get("content_mime_type") != MARKDOWN_CONTENT_MIME_TYPE:
        manifest_data["content_mime_type"] = MARKDOWN_CONTENT_MIME_TYPE
        changed = True
    return changed


def load_manifest(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as infile:
        manifest_data = json.load(infile)
    if not isinstance(manifest_data, dict):
        raise RuntimeError(f"Manifest did not contain a JSON object: {path}")
    return manifest_data


def write_manifest(path: Path, manifest_data: dict, *, dry_run: bool) -> None:
    print(f"write manifest {path}")
    if dry_run:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as outfile:
        json.dump(manifest_data, outfile, indent=2)
        outfile.write("\n")


def move_file(src: Path, dst: Path, *, dry_run: bool, overwrite: bool) -> bool:
    if not src.exists():
        return False

    if dst.exists():
        if not overwrite:
            raise RuntimeError(f"Destination already exists: {dst}")
        print(f"overwrite {dst}")
        if not dry_run:
            dst.unlink()

    print(f"move {src} -> {dst}")
    if not dry_run:
        dst.parent.mkdir(parents=True, exist_ok=True)
        src.replace(dst)
    return True


def move_and_update_manifest(src: Path, dst: Path, *, dry_run: bool, overwrite: bool) -> bool:
    if not src.exists():
        return False

    if dst.exists() and src.resolve() != dst.resolve():
        if not overwrite:
            raise RuntimeError(f"Destination already exists: {dst}")
        print(f"overwrite {dst}")
        if not dry_run:
            dst.unlink()

    manifest_data = load_manifest(src)
    if not is_text_extraction_manifest(manifest_data):
        raise RuntimeError(f"Expected a text extraction manifest: {src}")
    normalize_text_extraction_manifest(manifest_data)
    write_manifest(dst, manifest_data, dry_run=dry_run)

    if src.resolve() != dst.resolve():
        print(f"remove old manifest {src}")
        if not dry_run:
            src.unlink()
    return True


def remove_dir_if_empty(path: Path, *, dry_run: bool) -> bool:
    if not path.is_dir():
        return False
    try:
        next(path.iterdir())
    except StopIteration:
        print(f"remove empty dir {path}")
        if not dry_run:
            path.rmdir()
        return True
    return False


def migrate_item_dir(
    text_dir: Path,
    item_dir: Path,
    *,
    dry_run: bool,
    overwrite: bool,
    stats: MigrationStats,
) -> None:
    stats.item_dirs_seen += 1

    item_id = item_dir.name
    src_manifest = item_dir / "manifest.json"
    src_text = item_dir / "stage1.md"

    if not src_manifest.exists() and not src_text.exists():
        stats.dirs_skipped += 1
        return

    dst_manifest, dst_text = destination_paths(text_dir, item_id)
    manifest_moved = move_and_update_manifest(src_manifest, dst_manifest, dry_run=dry_run, overwrite=overwrite)
    text_moved = move_file(src_text, dst_text, dry_run=dry_run, overwrite=overwrite)

    if manifest_moved:
        stats.manifests_moved += 1
        stats.manifests_updated += 1
    if text_moved:
        stats.texts_moved += 1
    if remove_dir_if_empty(item_dir, dry_run=dry_run):
        stats.dirs_removed += 1


def update_flat_manifests(
    data_dir: Path,
    user_id: str | None,
    *,
    dry_run: bool,
    stats: MigrationStats,
) -> None:
    for user_dir in sorted(data_dir.glob("user_*")):
        if not user_dir.is_dir():
            continue
        current_user_id = user_dir.name.removeprefix("user_")
        if user_id is not None and current_user_id != user_id:
            continue

        text_dir = user_dir / "text"
        if not text_dir.is_dir():
            continue

        for shard_dir in sorted(text_dir.iterdir()):
            if not shard_dir.is_dir() or len(shard_dir.name) != 2:
                continue
            for manifest_path in sorted(shard_dir.glob("*_manifest.json")):
                manifest_data = load_manifest(manifest_path)
                if not is_text_extraction_manifest(manifest_data):
                    continue
                if normalize_text_extraction_manifest(manifest_data):
                    write_manifest(manifest_path, manifest_data, dry_run=dry_run)
                    stats.manifests_updated += 1


def main() -> int:
    args = parse_args()
    data_dir = args.data_dir.expanduser().resolve()

    if not data_dir.is_dir():
        print(f"Data directory does not exist: {data_dir}", file=sys.stderr)
        return 1

    stats = MigrationStats()

    try:
        for _user_id, text_dir, item_dir in iter_legacy_item_dirs(data_dir, args.user_id):
            migrate_item_dir(
                text_dir,
                item_dir,
                dry_run=args.dry_run,
                overwrite=args.overwrite,
                stats=stats,
            )
        update_flat_manifests(data_dir, args.user_id, dry_run=args.dry_run, stats=stats)
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"Migration failed: {exc}", file=sys.stderr)
        return 1

    print(
        "done "
        f"item_dirs_seen={stats.item_dirs_seen} "
        f"manifests_moved={stats.manifests_moved} "
        f"texts_moved={stats.texts_moved} "
        f"manifests_updated={stats.manifests_updated} "
        f"dirs_removed={stats.dirs_removed} "
        f"dirs_skipped={stats.dirs_skipped}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
