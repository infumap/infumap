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
import logging
import os
import sys
import time
from io import BytesIO
from pathlib import Path

# Ops the Apple GPU (MPS) lacks run on the CPU instead of failing. Set before
# torch is imported.
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

from docling.datamodel.base_models import DocumentStream, InputFormat
from docling.datamodel.pipeline_options import (
    HeadingHierarchyOptions,
    PdfPipelineOptions,
    RapidOcrOptions,
    TableFormerMode,
    TableStructureOptions,
)
from docling.document_converter import DocumentConverter, PdfFormatOption
import pypdfium2 as pdfium

from docling_quality import assess_and_render, markdown_by_page, page_section
from extraction_errors import (
    BackendUnavailableError,
    DocumentRejectedError,
    classify_document_rejection,
    is_setup_failure,
)


OCR_ENGINE = "rapidocr"
# RapidOCR recognition models Docling selects by name. Its default is the
# Chinese model, which drops the spaces between English words.
SUPPORTED_OCR_LANGS = ("english", "latin")


def ocr_lang() -> str:
    lang = os.environ.get("TEXT_EXTRACTION_OCR_LANG", "").strip().lower() or "english"
    if lang not in SUPPORTED_OCR_LANGS:
        raise ValueError(
            f"Invalid TEXT_EXTRACTION_OCR_LANG={lang!r}; expected one of {', '.join(SUPPORTED_OCR_LANGS)}."
        )
    return lang


# Checked on import, so the service's startup check rejects a bad setting.
OCR_LANG = ocr_lang()


def ocr_device() -> str:
    """Where RapidOCR runs, for the log.

    Docling enables CUDA for RapidOCR itself. RapidOCR also supports the Apple
    GPU (MPS), but it is deliberately not enabled: Docling runs OCR and layout
    in parallel threads, and two threads using MPS at once abort the worker in
    Metal ("A command encoder is already encoding to this command buffer").
    The layout model still uses MPS.
    """
    import torch

    return "cuda" if torch.cuda.is_available() else "cpu"


def build_ocr_options() -> RapidOcrOptions:
    """Full-page OCR settings for the fallback pass."""
    return RapidOcrOptions(lang=[OCR_LANG], backend="torch", force_full_page_ocr=True)


def build_converter(ocr: bool = False) -> DocumentConverter:
    """Native extraction, or full-page OCR."""
    options = PdfPipelineOptions()
    options.do_ocr = ocr
    if ocr:
        options.ocr_options = build_ocr_options()
    options.do_table_structure = True
    # Explicitly select TableFormer V1, as used by Groundwork's pinned version.
    options.table_structure_options = TableStructureOptions(
        mode=TableFormerMode.ACCURATE, do_cell_matching=True
    )
    # Native assessment compares against the parsed text layer.
    options.generate_parsed_pages = not ocr
    options.heading_hierarchy_options = HeadingHierarchyOptions(enabled=True)
    options.do_code_enrichment = False
    options.do_formula_enrichment = False
    options.do_picture_classification = False
    options.do_picture_description = False
    options.do_chart_extraction = False
    options.generate_page_images = False
    options.generate_picture_images = False
    options.generate_table_images = False
    return DocumentConverter(
        allowed_formats=[InputFormat.PDF],
        format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_options=options),
        },
    )


# OCR runs in page blocks so progress can be printed after each.
OCR_CHUNK_PAGES = 10


def raise_for_reported_errors(result) -> None:
    """Raise for errors that are not about converting this document.

    Other reported errors leave a non-success status: for native extraction
    the assessment turns that into an OCR fallback.
    """
    for error in result.errors:
        message = error.error_message
        rejection = classify_document_rejection(RuntimeError(message))
        if rejection is not None:
            raise DocumentRejectedError(*rejection)
        if is_setup_failure(message):
            raise BackendUnavailableError(message)


def result_payload(result) -> dict:
    # Only what the service uses. JSON serialization normalizes non-finite
    # confidence values.
    payload = json.loads(result.model_dump_json(include={"version", "status", "errors", "confidence"}))
    payload["page_count"] = result.input.page_count
    return payload


def convert(source_path: str, filename: str) -> dict:
    source = DocumentStream(name=filename, stream=BytesIO(Path(source_path).read_bytes()))
    result = build_converter().convert(source, raises_on_error=False)
    raise_for_reported_errors(result)

    pdf = pdfium.PdfDocument(source_path)
    try:
        assessment, markdown = assess_and_render(result, pdf)
    finally:
        pdf.close()
    payload = result_payload(result)
    payload["assessment"] = assessment
    payload["markdown"] = markdown
    return payload


def convert_ocr(source_path: str, filename: str) -> dict:
    """OCR every page, ignoring any text layer.

    There is no reliable text to assess OCR output against, so it is used as
    is; every page gets a section, empty when nothing was recognized.
    """
    device = ocr_device()
    data = Path(source_path).read_bytes()
    document = pdfium.PdfDocument(source_path)
    try:
        page_count = len(document)
    finally:
        document.close()
    converter = build_converter(ocr=True)
    sections: list[str] = []
    statuses: list[str] = []
    errors: list = []
    version = None
    started = time.monotonic()
    # Docling keeps original page numbers when converting a page range.
    for first in range(1, page_count + 1, OCR_CHUNK_PAGES):
        last = min(first + OCR_CHUNK_PAGES - 1, page_count)
        source = DocumentStream(name=filename, stream=BytesIO(data))
        result = converter.convert(source, raises_on_error=False, page_range=(first, last))
        raise_for_reported_errors(result)
        chunk = result_payload(result)
        version = version or chunk.get("version")
        statuses.append(chunk.get("status"))
        errors.extend(chunk.get("errors") or [])
        by_page = markdown_by_page(result.document)
        sections.extend(page_section(number, by_page.get(number, "")) for number in range(first, last + 1))
        if last < page_count:
            elapsed = time.monotonic() - started
            remaining = elapsed / last * (page_count - last)
            print(
                f"Docling OCR progress: file={filename} pages={last}/{page_count} "
                f"elapsed={elapsed:.0f}s remaining~{remaining:.0f}s",
                file=sys.stderr,
                flush=True,
            )

    if all(status == "success" for status in statuses):
        status = "success"
    elif any(status in ("success", "partial_success") for status in statuses):
        status = "partial_success"
    else:
        status = statuses[0] if statuses else "failure"
    return {
        "version": version,
        "status": status,
        "errors": errors,
        "page_count": page_count,
        "markdown": "\n\n".join(sections),
        "ocr": {"engine": OCR_ENGINE, "lang": OCR_LANG, "device": device},
    }


def main() -> None:
    """Usage: docling_worker.py SOURCE OUTPUT FILENAME [--ocr]"""
    args = sys.argv[1:]
    ocr = args[3:] == ["--ocr"]
    if ocr:
        args = args[:3]
    source_path, output_path, filename = args
    try:
        payload = convert_ocr(source_path, filename) if ocr else convert(source_path, filename)
    except Exception as exc:
        logging.exception("Docling worker failed for %s", filename)
        rejection = classify_document_rejection(exc)
        message = f"Docling {type(exc).__name__}: {exc}"
        if isinstance(exc, DocumentRejectedError):
            error = {"kind": "document", "error_code": exc.error_code, "message": exc.message}
        elif rejection is not None:
            error = {"kind": "document", "error_code": rejection[0], "message": rejection[1]}
        elif isinstance(exc, (BackendUnavailableError, ImportError)) or is_setup_failure(message):
            # OCR would hide a broken installation, and the caller retries.
            error = {"kind": "unavailable", "message": message}
        else:
            # Includes memory exhaustion. The extractor falls back to OCR when
            # native extraction fails, and retries OCR memory exhaustion.
            error = {"kind": "conversion", "message": message}
        payload = {"worker_error": error}
    Path(output_path).write_text(json.dumps(payload, ensure_ascii=False, allow_nan=False), encoding="utf-8")


if __name__ == "__main__":
    main()
