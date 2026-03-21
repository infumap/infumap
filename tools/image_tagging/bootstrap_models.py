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

from __future__ import annotations

import argparse
import json
from pathlib import Path

from huggingface_hub import hf_hub_download


def ensure_hf_file(repo_id: str, filename: str, dest_dir: Path) -> Path:
    target_path = dest_dir / filename
    if target_path.exists():
        return target_path

    downloaded_path = hf_hub_download(
        repo_id=repo_id,
        filename=filename,
        local_dir=str(dest_dir),
    )
    return Path(downloaded_path)


def main() -> int:
    parser = argparse.ArgumentParser(description="Download the image-tagging GGUF and mmproj files if they are missing.")
    parser.add_argument("--repo-id", required=True)
    parser.add_argument("--model-file", required=True)
    parser.add_argument("--mmproj-file", required=True)
    parser.add_argument("--dest-dir", required=True)
    args = parser.parse_args()

    dest_dir = Path(args.dest_dir).expanduser().resolve()
    dest_dir.mkdir(parents=True, exist_ok=True)

    model_path = ensure_hf_file(args.repo_id, args.model_file, dest_dir)
    mmproj_path = ensure_hf_file(args.repo_id, args.mmproj_file, dest_dir)

    print(
        json.dumps(
            {
                "model_path": str(model_path),
                "mmproj_path": str(mmproj_path),
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
