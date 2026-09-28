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

import unicodedata
from collections import Counter
from itertools import chain
from typing import Any, Iterator

import pypdfium2 as pdfium
from docling.datamodel.base_models import Cluster
from docling.datamodel.document import ConversionResult

# Conservative routing thresholds, not a claim of OCR or semantic accuracy.
MIN_TEXT_RETENTION = 0.8
DOMINANT_IMAGE_FRACTION = 0.65
MIN_NATIVE_CHARS_ON_IMAGE_PAGE = 200
MIN_EMPTY_TEXT_REGION_FRACTION = 0.01
TEXT_REGION_LABELS = {"text", "title", "section_header", "list_item", "table", "code", "formula"}
FURNITURE_LABELS = {"page_header", "page_footer"}


def characters(text: str) -> Counter[str]:
    return Counter(char for char in unicodedata.normalize("NFKC", text).casefold() if char.isalnum())


def garbled(text: str) -> bool:
    visible = [char for char in text if not char.isspace()]
    bad = sum(char == "\ufffd" or unicodedata.category(char) in {"Cc", "Co", "Cs"} for char in visible)
    return bad >= 3 and bad / max(1, len(visible)) > 0.02


def clusters_with_children(clusters: list[Cluster]) -> Iterator[Cluster]:
    for cluster in clusters:
        yield cluster
        yield from clusters_with_children(cluster.children)


def is_blank_page(pdf: pdfium.PdfDocument, page_no: int) -> bool:
    # Probe the rendered page instead of equating an empty text layer with a
    # blank page. This also recognizes a uniform blank scanned page.
    page = pdf[page_no - 1]
    try:
        scale = min(1.0, 512 / max(page.get_width(), page.get_height(), 1))
        bitmap = page.render(scale=scale)
        try:
            image = bitmap.to_pil().convert("L")
            try:
                low, high = image.getextrema()
                return high - low <= 2
            finally:
                image.close()
        finally:
            bitmap.close()
    finally:
        page.close()


def assess_and_render(result: ConversionResult, pdf: pdfium.PdfDocument) -> tuple[dict[str, Any], str]:
    """Accept only complete native extraction; a single suspect page rejects it.

    Retention compares normalized alphanumeric character counts, tolerating
    whitespace, ligatures, and formatting changes. It does not establish
    correct reading order, tables, or completeness of text embedded in images.
    """
    page_stats: list[dict[str, Any]] = []

    def rejected(reason: str) -> tuple[dict[str, Any], str]:
        return {"fallback_reason": reason, "pages": page_stats}, ""

    if result.status.value != "success" or result.errors:
        return rejected(f"docling_status_{result.status.value}")
    count = len(pdf)
    page_numbers = [page.page_no for page in result.pages]
    expected = set(range(1, count + 1))
    if count == 0 or len(page_numbers) != len(set(page_numbers)) or not set(page_numbers) <= expected:
        return rejected("incomplete_page_coverage")
    if not set(result.document.pages) <= expected:
        return rejected("invalid_document_pages")
    # A page-filtered export repeats multi-page items. Until the richer export
    # adapter handles them, retain Marker's whole-document output for these.
    for item, _ in result.document.iterate_items(traverse_pictures=True):
        if len({prov.page_no for prov in getattr(item, "prov", [])}) > 1:
            return rejected("cross_page_document_item")
    furniture_by_page: dict[int, Counter[str]] = {}
    for text in result.document.texts:
        if text.label.value in FURNITURE_LABELS:
            for number in {prov.page_no for prov in text.prov}:
                furniture_by_page.setdefault(number, Counter()).update(characters(text.text))

    markdown_pages: list[str] = []
    pages = {page.page_no: page for page in result.pages}
    for number in range(1, count + 1):
        stats: dict[str, Any] = {"page_no": number}
        page_stats.append(stats)
        page = pages.get(number)
        parsed = page.parsed_page if page is not None else None
        if parsed is None:
            stats["blank"] = is_blank_page(pdf, number)
            if stats["blank"]:
                markdown_pages.append(f"{{{number - 1}}}--------\n\n")
                continue
            return rejected(f"page_{number}:missing_native_page")
        cells = parsed.word_cells or parsed.textline_cells
        if any(cell.from_ocr for cell in chain(parsed.word_cells, parsed.textline_cells)):
            return rejected(f"page_{number}:unexpected_ocr_text")
        native_text = " ".join(cell.text for cell in cells)
        native = characters(native_text)
        stats["native_chars"] = native.total()
        if garbled(native_text):
            return rejected(f"page_{number}:garbled_native_text")
        if not native:
            stats["blank"] = is_blank_page(pdf, number)
            if not stats["blank"]:
                return rejected(f"page_{number}:visible_content_without_native_text")
            markdown_pages.append(f"{{{number - 1}}}--------\n\n")
            continue
        if number not in result.document.pages:
            return rejected(f"page_{number}:missing_document_page")

        height = parsed.dimension.height
        crop = parsed.dimension.crop_bbox.to_top_left_origin(height)
        area = crop.area()
        if area <= 0:
            return rejected(f"page_{number}:invalid_page_geometry")
        image_area = sum(
            bitmap.rect.to_bounding_box().to_top_left_origin(height).intersection_area_with(crop)
            for bitmap in parsed.bitmap_resources
        )
        stats["image_fraction"] = min(1.0, image_area / area)
        # Exclude recognized running headers and footers when deciding whether
        # a page has body text or the exporter has dropped meaningful content.
        body = native - furniture_by_page.get(number, Counter())
        stats["body_chars"] = body.total()
        if not body and parsed.bitmap_resources:
            return rejected(f"page_{number}:images_without_native_body_text")
        if stats["image_fraction"] >= DOMINANT_IMAGE_FRACTION and body.total() < MIN_NATIVE_CHARS_ON_IMAGE_PAGE:
            return rejected(f"page_{number}:image_dominated_with_sparse_native_text")

        layout = page.predictions.layout
        if layout is None:
            return rejected(f"page_{number}:missing_layout")
        native_boxes = [
            cell.rect.to_bounding_box().to_top_left_origin(height)
            for cell in cells if characters(cell.text)
        ]
        for cluster in clusters_with_children(layout.clusters):
            box = cluster.bbox.to_top_left_origin(height)
            if cluster.label.value in TEXT_REGION_LABELS and box.intersection_area_with(crop) / area >= MIN_EMPTY_TEXT_REGION_FRACTION:
                if not any(native_box.intersection_over_self(box) >= 0.5 for native_box in native_boxes):
                    return rejected(f"page_{number}:text_region_without_native_text")

        markdown = result.document.export_to_markdown(
            page_no=number, image_placeholder="", traverse_pictures=True
        ).strip()
        exported = characters(markdown)
        retained = (body & exported).total() / max(1, body.total())
        stats["text_retention"] = retained
        if body and (not exported or retained < MIN_TEXT_RETENTION):
            return rejected(f"page_{number}:native_text_missing_from_markdown")
        if garbled(markdown):
            return rejected(f"page_{number}:garbled_markdown")
        markdown_pages.append(f"{{{number - 1}}}--------\n\n{markdown}")

    markdown = "\n\n".join(markdown_pages)
    if all(page.get("blank") for page in page_stats):
        markdown = ""
    return {"fallback_reason": None, "pages": page_stats}, markdown
