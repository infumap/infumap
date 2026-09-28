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

STARTUP_CHECK_TIMEOUT_SECS = 300.0


def describe_exit(returncode: int) -> str:
    if returncode < 0:
        return f"was terminated by signal {-returncode}"
    return f"exited with status {returncode}"


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

    def load(self) -> None:
        """Check that the worker's imports succeed in the Docling environment.

        After this, a worker that exits abnormally is treated as having failed
        on its document, not as a broken installation.
        """
        self.check_ready()
        try:
            check = subprocess.run(
                [str(self.python), "-c", "import docling_worker"],
                cwd=self.root,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                timeout=STARTUP_CHECK_TIMEOUT_SECS,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise BackendUnavailableError(f"Could not start the Docling worker: {exc}") from exc
        if check.returncode != 0:
            detail = check.stderr.strip().splitlines()[-1:] or ["no error output"]
            raise BackendUnavailableError(
                f"Docling worker imports failed ({describe_exit(check.returncode)}): {detail[0]}"
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
        """Convert with Docling within timeout_secs.

        Raises DoclingConversionError when Docling fails on the document,
        including a crash or exceeding timeout_secs, and ExtractionTimeoutError
        only when the service cancelled the conversion.
        """
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
            with self._lock:
                if self._cancelled:
                    raise ExtractionTimeoutError("Docling worker was cancelled.")
                try:
                    process = subprocess.Popen(command, stdin=subprocess.DEVNULL)
                except OSError as exc:
                    raise BackendUnavailableError(f"Could not start the Docling worker: {exc}") from exc
                self._process = process
            timed_out = False
            try:
                process.wait(timeout=max(0, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                timed_out = True
            finally:
                if process.poll() is None:
                    process.kill()
                process.wait()
                with self._lock:
                    self._process = None
            if self._cancelled:
                raise ExtractionTimeoutError("Docling worker was cancelled.")
            if timed_out:
                raise DoclingConversionError(f"Docling exceeded its {timeout_secs:.0f} second budget.")
            if process.returncode != 0:
                raise DoclingConversionError(
                    f"Docling worker {describe_exit(process.returncode)}; see worker logs."
                )
            try:
                result = json.loads(output.read_text(encoding="utf-8"))
            except (OSError, ValueError) as exc:
                raise DoclingConversionError(f"Docling worker left no readable result: {exc}") from exc
            if not isinstance(result, dict):
                raise DoclingConversionError("Docling worker returned an invalid conversion result.")
            error = result.get("worker_error")
            if error:
                message = error["message"]
                if error["kind"] == "document":
                    raise DocumentRejectedError(error["error_code"], message)
                if error["kind"] == "unavailable":
                    raise BackendUnavailableError(message)
                raise DoclingConversionError(message)
            return result
