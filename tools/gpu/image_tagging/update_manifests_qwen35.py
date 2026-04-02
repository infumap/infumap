#!/usr/bin/env python3
# Copyright (C) The Infumap Authors
# This file is part of Infumap.
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as
# published by the Free Software Foundation, either version 3 of the
# License, or (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

"""
Retroactively update image tag manifests to record the model that processed them.

Adds extractor.model_id and extractor.backend to every succeeded image manifest
that is missing those fields. Skips PDF and other non-image manifests.

Usage:
    python3 update_manifests_qwen35.py --data-dir /path/to/infumap/data
    python3 update_manifests_qwen35.py --data-dir /path/to/infumap/data --dry-run

Options:
    --data-dir   Path to the infumap data directory (required)
    --model-id   Model identifier to write (default: unsloth/Qwen3.5-9B-GGUF:Qwen3.5-9B-Q4_K_M.gguf)
    --backend    Backend name to write (default: llama-server)
    --dry-run    Print what would be changed without writing anything
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

IMAGE_MIME_TYPES = {"image/jpeg", "image/png", "image/webp", "image/tiff"}

DEFAULT_MODEL_ID = "unsloth/Qwen3.5-9B-GGUF:Qwen3.5-9B-Q4_K_M.gguf"
DEFAULT_BACKEND = "llama-server"


def find_manifest_files(data_dir: Path) -> list[Path]:
    return sorted(data_dir.glob("user_*/text/*/*_manifest.json"))


def process_manifest(path: Path, model_id: str, backend: str, dry_run: bool) -> str:
    """Returns one of: 'updated', 'skipped_not_image', 'skipped_already_has_model',
    'skipped_not_succeeded', 'error'."""
    try:
        raw = path.read_text(encoding="utf-8")
        manifest = json.loads(raw)
    except Exception as exc:
        print(f"  ERROR reading {path}: {exc}", file=sys.stderr)
        return "error"

    source_mime = manifest.get("source_mime_type", "")
    if source_mime not in IMAGE_MIME_TYPES:
        return "skipped_not_image"

    if manifest.get("status") != "succeeded":
        return "skipped_not_succeeded"

    extractor = manifest.get("extractor", {})
    if extractor.get("model_id") is not None or extractor.get("backend") is not None:
        return "skipped_already_has_model"

    extractor["model_id"] = model_id
    extractor["backend"] = backend
    manifest["extractor"] = extractor

    if dry_run:
        print(f"  Would update: {path}")
        return "updated"

    try:
        path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    except Exception as exc:
        print(f"  ERROR writing {path}: {exc}", file=sys.stderr)
        return "error"

    return "updated"


def main() -> int:
    parser = argparse.ArgumentParser(description="Backfill model_id/backend into image tag manifests.")
    parser.add_argument("--data-dir", required=True, help="Path to the infumap data directory")
    parser.add_argument("--model-id", default=DEFAULT_MODEL_ID, help=f"model_id to write (default: {DEFAULT_MODEL_ID})")
    parser.add_argument("--backend", default=DEFAULT_BACKEND, help=f"backend to write (default: {DEFAULT_BACKEND})")
    parser.add_argument("--dry-run", action="store_true", help="Print changes without writing")
    args = parser.parse_args()

    data_dir = Path(args.data_dir).expanduser().resolve()
    if not data_dir.is_dir():
        print(f"Error: data directory not found: {data_dir}", file=sys.stderr)
        return 1

    if args.dry_run:
        print("Dry run — no files will be written.")

    manifests = find_manifest_files(data_dir)
    print(f"Found {len(manifests)} manifest file(s) under {data_dir}")

    counts: dict[str, int] = {
        "updated": 0,
        "skipped_not_image": 0,
        "skipped_not_succeeded": 0,
        "skipped_already_has_model": 0,
        "error": 0,
    }

    for path in manifests:
        result = process_manifest(path, args.model_id, args.backend, args.dry_run)
        counts[result] = counts.get(result, 0) + 1

    print()
    print(f"  {'Would update' if args.dry_run else 'Updated'}:          {counts['updated']}")
    print(f"  Skipped (not image):    {counts['skipped_not_image']}")
    print(f"  Skipped (not success):  {counts['skipped_not_succeeded']}")
    print(f"  Skipped (already set):  {counts['skipped_already_has_model']}")
    print(f"  Errors:                 {counts['error']}")

    return 1 if counts["error"] > 0 else 0


if __name__ == "__main__":
    raise SystemExit(main())
