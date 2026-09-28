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

import re
import unicodedata
from collections import Counter
from itertools import chain
from typing import Any

import pypdfium2 as pdfium
from docling.datamodel.base_models import Page
from docling.datamodel.document import ConversionResult
from docling_core.types.doc import (
    DocItemLabel,
    DoclingDocument,
    FloatingItem,
    NodeItem,
    ProvenanceItem,
    TextItem,
)
from docling_core.types.doc.document import ContentLayer

# Routing heuristics, not a claim of OCR or semantic accuracy. A nonblank page
# is unusable when it looks scanned or its native text is garbled. Documents
# go to Marker only when at least this fraction of nonblank pages is unusable;
# otherwise Docling is used and unusable pages contribute little or no text.
MIN_UNUSABLE_PAGE_FRACTION = 0.5
DOMINANT_IMAGE_FRACTION = 0.65
MIN_NATIVE_CHARS_ON_IMAGE_PAGE = 200
MAX_GARBLED_WORD_FRACTION = 0.5
# Below this, Docling's Markdown has lost native text. Logged, not routed on.
MIN_TEXT_RETENTION = 0.8
FURNITURE_LABELS = {"page_header", "page_footer"}
# docling-parse writes glyphs it cannot map to Unicode as GLYPH<...>; other
# broken encodings surface as runs of glyph names such as /G12/G13.
UNMAPPED_GLYPH_PATTERN = re.compile(r"GLYPH<[^>]*>|(?:/G\d+){2,}")


class NativeExtractionRejected(Exception):
    """Docling's output should not be used for this document."""


def characters(text: str) -> Counter[str]:
    return Counter(char for char in unicodedata.normalize("NFKC", text).casefold() if char.isalnum())


def garbled_word(word: str) -> bool:
    return bool(UNMAPPED_GLYPH_PATTERN.search(word)) or any(
        char == "�" or unicodedata.category(char) in {"Cc", "Co", "Cs"} for char in word
    )


def garbled(text: str) -> bool:
    """Whether most words are unmapped glyphs or replacement/control/private-use text.

    An isolated unmapped symbol, such as a bullet from a font without a Unicode
    map, does not make the text garbled.
    """
    words = text.split()
    bad = sum(garbled_word(word) for word in words)
    return bad >= 3 and bad > MAX_GARBLED_WORD_FRACTION * len(words)


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


def document_for_export(document: DoclingDocument) -> DoclingDocument:
    """Return a copy adjusted so page-filtered Markdown export keeps native text."""
    document = document.model_copy(deep=True)
    items = [item for item, _ in document.iterate_items(
        traverse_pictures=True, included_content_layers=set(ContentLayer)
    )]
    # The Markdown exporter leaves footnotes of tables and pictures to their
    # owner, which never emits them. Detached, they export as ordinary text.
    for item in items:
        if isinstance(item, FloatingItem):
            item.footnotes = []
    split_cross_page_items(document, items)
    return document


def split_cross_page_items(document: DoclingDocument, items: list[NodeItem]) -> None:
    """Split items so that each one has provenance on a single page.

    Docling merges a paragraph that continues on a later page into one text
    item with provenance on each page, and page-filtered export emits an item
    only on its first page. Splitting at the page boundaries keeps each part,
    and its coverage check, with the page it came from.
    """
    for item in items:
        provs = getattr(item, "prov", [])
        if len({prov.page_no for prov in provs}) <= 1:
            continue
        # Docling only merges plain text items; anything else is unexpected.
        if not isinstance(item, TextItem) or item.label != DocItemLabel.TEXT:
            raise NativeExtractionRejected("cross_page_document_item")
        runs: list[list[ProvenanceItem]] = []
        for prov in provs:
            if runs and runs[-1][0].page_no == prov.page_no:
                runs[-1].append(prov)
            else:
                runs.append([prov])
        if len(runs) != len({run[0].page_no for run in runs}):
            raise NativeExtractionRejected("cross_page_document_item")

        text = item.text
        starts = [0]
        for run in runs[1:]:
            start = run[0].charspan[0]
            # Joining a soft-hyphenated word shifts the recorded offset into
            # the joined word; keep that word with the page it started on.
            while 0 < start < len(text) and not text[start - 1].isspace():
                start += 1
            if start < starts[-1] or start > len(text):
                raise NativeExtractionRejected("cross_page_document_item")
            starts.append(start)
        pieces = [text[start:end].strip() for start, end in zip(starts, starts[1:] + [len(text)])]

        # Charspans keep their merged-item offsets; nothing reads them after this.
        item.text = item.orig = pieces[0]
        item.prov = runs[0]
        previous = item
        for piece, run in zip(pieces[1:], runs[1:]):
            if not piece:
                continue
            previous = document.insert_text(
                sibling=previous,
                label=item.label,
                text=piece,
                orig=piece,
                prov=run[0],
                content_layer=item.content_layer,
                formatting=item.formatting,
                hyperlink=item.hyperlink,
            )
            previous.prov = run


def assess_page(
    document: DoclingDocument,
    page: Page | None,
    pdf: pdfium.PdfDocument,
    number: int,
    furniture: Counter[str],
    stats: dict[str, Any],
) -> tuple[str | None, str]:
    """Return why the page's native text is unusable (None if usable) and its Markdown.

    Raises NativeExtractionRejected for problems that invalidate the document.
    """
    parsed = page.parsed_page if page is not None else None
    if parsed is None:
        stats["blank"] = is_blank_page(pdf, number)
        return (None if stats["blank"] else "missing_native_page"), ""
    cells = parsed.word_cells or parsed.textline_cells
    if any(cell.from_ocr for cell in chain(parsed.word_cells, parsed.textline_cells)):
        raise NativeExtractionRejected(f"page_{number}:unexpected_ocr_text")
    native_text = " ".join(cell.text for cell in cells)
    native = characters(native_text)
    stats["native_chars"] = native.total()
    if garbled(native_text):
        return "garbled_native_text", ""
    if not native:
        stats["blank"] = is_blank_page(pdf, number)
        return (None if stats["blank"] else "visible_content_without_native_text"), ""
    if number not in document.pages:
        stats["warning"] = "missing_document_page"
        return None, ""

    height = parsed.dimension.height
    crop = parsed.dimension.crop_bbox.to_top_left_origin(height)
    area = crop.area()
    if area <= 0:
        raise NativeExtractionRejected(f"page_{number}:invalid_page_geometry")

    markdown = document.export_to_markdown(
        page_no=number, image_placeholder="", traverse_pictures=True, escape_html=False
    )
    if garbled(markdown):
        return "garbled_markdown", ""
    markdown = UNMAPPED_GLYPH_PATTERN.sub("", markdown).strip()

    # A scanned page may still carry a little native text, such as a stamp.
    # Exclude recognized running headers and footers when judging body text.
    image_area = sum(
        bitmap.rect.to_bounding_box().to_top_left_origin(height).intersection_area_with(crop)
        for bitmap in parsed.bitmap_resources
    )
    stats["image_fraction"] = min(1.0, image_area / area)
    body = native - furniture
    stats["body_chars"] = body.total()
    if not body and parsed.bitmap_resources:
        return "images_without_native_body_text", markdown
    if stats["image_fraction"] >= DOMINANT_IMAGE_FRACTION and body.total() < MIN_NATIVE_CHARS_ON_IMAGE_PAGE:
        return "image_dominated_with_sparse_native_text", markdown

    exported = characters(markdown)
    retained = (body & exported).total() / max(1, body.total())
    stats["text_retention"] = retained
    if body and retained < MIN_TEXT_RETENTION:
        stats["warning"] = "native_text_missing_from_markdown"
    return None, markdown


def render_pages(result: ConversionResult, pdf: pdfium.PdfDocument, page_stats: list[dict[str, Any]]) -> str:
    if result.status.value != "success" or result.errors:
        raise NativeExtractionRejected(f"docling_status_{result.status.value}")
    count = len(pdf)
    page_numbers = [page.page_no for page in result.pages]
    expected = set(range(1, count + 1))
    if count == 0 or len(page_numbers) != len(set(page_numbers)) or not set(page_numbers) <= expected:
        raise NativeExtractionRejected("incomplete_page_coverage")
    if not set(result.document.pages) <= expected:
        raise NativeExtractionRejected("invalid_document_pages")
    document = document_for_export(result.document)
    furniture_by_page: dict[int, Counter[str]] = {}
    for text in document.texts:
        if text.label.value in FURNITURE_LABELS:
            for number in {prov.page_no for prov in text.prov}:
                furniture_by_page.setdefault(number, Counter()).update(characters(text.text))

    unusable: list[str] = []

    def rejected(pages: int, *, partial: bool = False) -> NativeExtractionRejected:
        # A partial count stopped early and is a lower bound.
        examples = ", ".join(unusable[:5]) + (", ..." if len(unusable) > 5 else "")
        return NativeExtractionRejected(
            f"unusable_pages_{len(unusable)}{'+' if partial else ''}_of_{pages}: {examples}"
        )

    markdown_pages: list[str] = []
    pages = {page.page_no: page for page in result.pages}
    for number in range(1, count + 1):
        stats: dict[str, Any] = {"page_no": number}
        page_stats.append(stats)
        reason, markdown = assess_page(
            document, pages.get(number), pdf, number, furniture_by_page.get(number, Counter()), stats
        )
        if reason is not None:
            stats["unusable"] = reason
            unusable.append(f"page_{number}:{reason}")
            # The nonblank page count cannot exceed the page count, so stop
            # once the outcome is certain.
            if len(unusable) >= MIN_UNUSABLE_PAGE_FRACTION * count:
                raise rejected(count, partial=True)
        markdown_pages.append(f"{{{number - 1}}}--------\n\n{markdown}")

    nonblank = sum(not stats.get("blank") for stats in page_stats)
    if not nonblank:
        return ""
    if len(unusable) >= MIN_UNUSABLE_PAGE_FRACTION * nonblank:
        raise rejected(nonblank)
    return "\n\n".join(markdown_pages)


def assess_and_render(result: ConversionResult, pdf: pdfium.PdfDocument) -> tuple[dict[str, Any], str]:
    """Use native extraction unless the document is mostly scanned or garbled.

    Structural problems with Docling's result reject the document. Otherwise a
    nonblank page is unusable when it looks scanned or its native text is
    garbled, and the document goes to Marker when at least
    MIN_UNUSABLE_PAGE_FRACTION of nonblank pages are unusable. Mixed documents,
    searchable scans, and picture-heavy documents use Docling without OCR.

    Retention compares normalized alphanumeric character counts, tolerating
    whitespace, ligatures, and formatting changes. Low retention is reported
    as a page warning. None of this establishes correct reading order, tables,
    or completeness of text embedded in images.
    """
    page_stats: list[dict[str, Any]] = []
    try:
        markdown = render_pages(result, pdf, page_stats)
        reason = None
    except NativeExtractionRejected as exc:
        markdown, reason = "", str(exc)
    return {
        "fallback_reason": reason,
        "unusable_pages": [stats["page_no"] for stats in page_stats if "unusable" in stats],
        "warning_pages": [stats["page_no"] for stats in page_stats if "warning" in stats],
        "pages": page_stats,
    }, markdown
