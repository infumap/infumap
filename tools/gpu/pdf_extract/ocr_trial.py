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

"""Try Docling OCR engines on PDFs, to judge whether Docling can replace Marker.

Not used by the service. Run it with the Docling virtualenv while the PDF
extraction service is stopped, so the two do not compete for GPU memory:

    .venv-docling/bin/python ocr_trial.py scans/*.pdf
    .venv-docling/bin/python ocr_trial.py -e native -e rapidocr:english -e easyocr:en,de --max-pages 20 some/dir

Each PDF gets a directory under --out with one Markdown file per engine, in the
production page format ({n}-------- markers), plus summary.tsv for all PDFs.

Engines (-e, repeatable; default native, rapidocr:english, easyocr:en; a spec
is name[:lang,lang][@backend]):
  native              Docling without OCR, as the service runs it today.
  rapidocr            RapidOCR (installed with Docling). Backend defaults to
                      torch; add @onnxruntime if onnxruntime(-gpu) is installed.
  easyocr             EasyOCR. Needs: .venv-docling/bin/pip install easyocr
  tesseract           Tesseract CLI. Needs the tesseract binary on PATH.
  nemotron            NVIDIA Nemotron OCR. Needs docling[feat-ocr-nemotron].
Languages use the engine's own codes, e.g. rapidocr:english, easyocr:en,de,
tesseract:eng. Without them Docling's defaults are used; for RapidOCR that is
its Chinese model, which drops the spaces between English words.

Word scores ignore case, punctuation and order. "vs_native" is the share of
the native text layer's words that an engine also produced; for born-digital
PDFs the text layer is close to ground truth. With --reference-dir, "vs_ref"
compares against <pdf stem>.txt or .md there, for example the text infumap
stored from Marker (download it from /files/<item id>/text). With --max-pages,
vs_ref is understated, since the reference covers the whole document.
"""

from __future__ import annotations

import argparse
import re
import sys
import time
import unicodedata
from collections import Counter
from pathlib import Path
from typing import Any

from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import (
    EasyOcrOptions,
    PdfPipelineOptions,
    RapidOcrOptions,
    TableFormerMode,
    TableStructureOptions,
    TesseractCliOcrOptions,
)
from docling.document_converter import DocumentConverter, PdfFormatOption

from docling_quality import markdown_by_page

PAGE_MARKER = re.compile(r"^\{\d+\}-{8,}$", re.MULTILINE)
WORD = re.compile(r"\w+")


def parse_engine(spec: str) -> tuple[str, list[str] | None, str | None]:
    name, _, backend = spec.partition("@")
    name, _, langs = name.partition(":")
    return name.strip(), [lang for lang in langs.split(",") if lang] or None, backend or None


def ocr_options(name: str, langs: list[str] | None, backend: str | None) -> Any:
    extra: dict[str, Any] = {"force_full_page_ocr": True}
    if langs:
        extra["lang"] = langs
    if name == "rapidocr":
        return RapidOcrOptions(backend=backend or "torch", **extra)
    if name == "easyocr":
        return EasyOcrOptions(**extra)
    if name == "tesseract":
        return TesseractCliOcrOptions(**extra)
    if name == "nemotron":
        from docling.datamodel.pipeline_options import NemotronOcrOptions

        return NemotronOcrOptions(**extra)
    raise ValueError(f"Unknown engine '{name}'.")


def build_converter(spec: str) -> DocumentConverter:
    """The service's Docling options, with OCR added for every engine but native."""
    name, langs, backend = parse_engine(spec)
    options = PdfPipelineOptions()
    options.do_table_structure = True
    options.table_structure_options = TableStructureOptions(mode=TableFormerMode.ACCURATE, do_cell_matching=True)
    options.do_code_enrichment = False
    options.do_formula_enrichment = False
    options.do_picture_classification = False
    options.do_picture_description = False
    options.generate_page_images = False
    options.generate_picture_images = False
    options.generate_table_images = False
    if name == "native":
        options.do_ocr = False
    else:
        options.do_ocr = True
        options.ocr_options = ocr_options(name, langs, backend)
    return DocumentConverter(
        allowed_formats=[InputFormat.PDF],
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)},
    )


def render(result: Any) -> str:
    """Markdown in the service's page format: {0-based page}-------- per page."""
    by_page = markdown_by_page(result.document)
    pages = [f"{{{number - 1}}}--------\n\n{by_page.get(number, '')}" for number in range(1, len(result.pages) + 1)]
    return "\n\n".join(pages)


def words(text: str) -> Counter[str]:
    text = PAGE_MARKER.sub(" ", unicodedata.normalize("NFKC", text).casefold())
    return Counter(WORD.findall(text))


def recall(found: Counter[str], expected: Counter[str]) -> str:
    total = expected.total()
    return f"{(found & expected).total() / total:.3f}" if total else "-"


def collect_pdfs(paths: list[str]) -> list[Path]:
    pdfs: list[Path] = []
    for raw in paths:
        path = Path(raw)
        if path.is_dir():
            pdfs.extend(sorted(p for p in path.rglob("*") if p.suffix.lower() == ".pdf"))
        elif path.is_file():
            pdfs.append(path)
        else:
            print(f"Not found: {path}", file=sys.stderr)
    return pdfs


def reference_words(reference_dir: Path | None, pdf: Path) -> Counter[str] | None:
    if reference_dir is None:
        return None
    for suffix in (".txt", ".md"):
        candidate = reference_dir / (pdf.stem + suffix)
        if candidate.is_file():
            return words(candidate.read_text(encoding="utf-8", errors="replace"))
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("pdfs", nargs="+", help="PDF files, or directories searched recursively for PDFs.")
    parser.add_argument("-e", "--engine", action="append", dest="engines", help="Engine spec; repeat for several.")
    parser.add_argument("--out", default="ocr_trial_out", help="Output directory. Default: %(default)s")
    parser.add_argument("--max-pages", type=int, default=None, help="Convert only the first N pages of each PDF.")
    parser.add_argument("--reference-dir", type=Path, default=None, help="Directory of <pdf stem>.txt/.md reference texts.")
    args = parser.parse_args()

    specs = args.engines or ["native", "rapidocr:english", "easyocr:en"]
    pdfs = collect_pdfs(args.pdfs)
    if not pdfs:
        print("No PDFs to process.", file=sys.stderr)
        return 1
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    converters: dict[str, DocumentConverter] = {}
    for spec in specs:
        started = time.perf_counter()
        try:
            converter = build_converter(spec)
            converter.initialize_pipeline(InputFormat.PDF)
        except Exception as exc:
            print(f"Skipping engine '{spec}': {type(exc).__name__}: {exc}", file=sys.stderr)
            continue
        converters[spec] = converter
        print(f"Loaded engine '{spec}' in {time.perf_counter() - started:.1f}s.", file=sys.stderr)
    if not converters:
        print("No engine could be loaded.", file=sys.stderr)
        return 1

    page_range = (1, args.max_pages) if args.max_pages else None
    rows = [["pdf", "engine", "status", "pages", "seconds", "sec_per_page", "words", "vs_native", "vs_ref"]]
    # Written as each PDF finishes, so a native crash in an engine keeps earlier results.
    summary_path = out_dir / "summary.tsv"
    summary_path.write_text("\t".join(rows[0]) + "\n", encoding="utf-8")
    for pdf in pdfs:
        pdf_out = out_dir / pdf.stem
        pdf_out.mkdir(parents=True, exist_ok=True)
        reference = reference_words(args.reference_dir, pdf)
        results: list[tuple[str, str, int, float, Counter[str]]] = []
        for spec, converter in converters.items():
            print(f"{pdf.name}: {spec} ...", file=sys.stderr)
            started = time.perf_counter()
            try:
                kwargs = {"raises_on_error": False}
                if page_range:
                    kwargs["page_range"] = page_range
                result = converter.convert(str(pdf), **kwargs)
                markdown = render(result)
                status, pages = result.status.value, len(result.pages)
            except Exception as exc:
                print(f"  failed: {type(exc).__name__}: {exc}", file=sys.stderr)
                markdown, status, pages = "", f"error:{type(exc).__name__}", 0
            seconds = time.perf_counter() - started
            safe_spec = re.sub(r"[^A-Za-z0-9_.-]+", "_", spec)
            (pdf_out / f"{safe_spec}.md").write_text(markdown, encoding="utf-8")
            results.append((spec, status, pages, seconds, words(markdown)))
        native = next((found for spec, _, _, _, found in results if spec == "native"), None)
        pdf_rows = []
        for spec, status, pages, seconds, found in results:
            pdf_rows.append([
                str(pdf),
                spec,
                status,
                str(pages),
                f"{seconds:.1f}",
                f"{seconds / pages:.2f}" if pages else "-",
                str(found.total()),
                recall(found, native) if native is not None and spec != "native" else "-",
                recall(found, reference) if reference is not None else "-",
            ])
        with summary_path.open("a", encoding="utf-8") as summary:
            summary.writelines("\t".join(row) + "\n" for row in pdf_rows)
        rows.extend(pdf_rows)

    shown = [[Path(row[0]).name if index else row[0]] + row[1:] for index, row in enumerate(rows)]
    widths = [max(len(row[i]) for row in shown) for i in range(len(shown[0]))]
    for row in shown:
        print("  ".join(cell.ljust(width) for cell, width in zip(row, widths)))
    print(f"\nOutputs in {out_dir}/<pdf name>/, summary in {out_dir}/summary.tsv", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
