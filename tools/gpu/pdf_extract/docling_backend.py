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

import json
import math
import os
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

from extraction_errors import (
    BackendUnavailableError,
    DoclingConversionError,
    DocumentRejectedError,
    ExtractionTimeoutError,
)


class DoclingBackend:
    """Run native extraction in Docling's isolated dependency environment.

    Returns conversion diagnostics, native coverage assessment, and Markdown
    from the worker. Calls must be serialized by the owning service.
    """

    def __init__(self) -> None:
        self.root = Path(__file__).resolve().parent
        venv = Path(os.environ.get("TEXT_EXTRACTION_DOCLING_VENV_DIR") or self.root / ".venv-docling")
        self.python = venv.resolve() / "bin" / "python"
        self._lock = threading.Lock()
        self._process: subprocess.Popen | None = None
        self._cancelled = False

    def check_ready(self) -> None:
        if not self.python.is_file():
            raise BackendUnavailableError(
                f"Docling Python is missing at {self.python}; run pdf_extract/run.sh to install it."
            )

    def cancel(self) -> None:
        # Also closes the race where the watchdog fires just before spawning.
        with self._lock:
            self._cancelled = True
            if self._process is not None and self._process.poll() is None:
                self._process.kill()

    def convert(
        self, file_bytes: bytes, file_name: str, *, timeout_secs: float
    ) -> dict[str, Any]:
        if not math.isfinite(timeout_secs) or timeout_secs <= 0:
            raise ValueError("Docling conversion timeout must be finite and positive.")
        deadline = time.monotonic() + timeout_secs
        self.check_ready()
        with tempfile.TemporaryDirectory(prefix="infumap-docling-") as directory:
            source = Path(directory) / "input.pdf"
            output = Path(directory) / "result.json"
            source.write_bytes(file_bytes)
            command = [
                str(self.python),
                str(self.root / "docling_worker.py"),
                str(source),
                str(output),
                Path(file_name or "document.pdf").name,
            ]
            try:
                with self._lock:
                    if self._cancelled or time.monotonic() >= deadline:
                        raise ExtractionTimeoutError("Docling worker was cancelled.")
                    process = subprocess.Popen(command, stdin=subprocess.DEVNULL)
                    self._process = process
                try:
                    process.wait(timeout=max(0, deadline - time.monotonic()))
                    if process.returncode != 0:
                        raise BackendUnavailableError(
                            f"Docling worker exited with status {process.returncode}; see worker logs."
                        )
                except subprocess.TimeoutExpired as exc:
                    raise ExtractionTimeoutError("Docling conversion timed out.") from exc
                finally:
                    if process.poll() is None:
                        process.kill()
                    process.wait()
                    with self._lock:
                        self._process = None
                result = json.loads(output.read_text(encoding="utf-8"))
            except ExtractionTimeoutError:
                raise
            except (OSError, ValueError) as exc:
                raise BackendUnavailableError(f"Could not run Docling worker: {exc}") from exc
            if not isinstance(result, dict):
                raise BackendUnavailableError("Docling worker returned an invalid conversion result.")
            error = result.get("worker_error")
            if error:
                message = error["message"]
                if error["kind"] == "document":
                    raise DocumentRejectedError(error["error_code"], message)
                if error["kind"] == "timeout":
                    raise ExtractionTimeoutError(message)
                if error["kind"] == "conversion":
                    raise DoclingConversionError(message)
                raise BackendUnavailableError(message)
            return result
