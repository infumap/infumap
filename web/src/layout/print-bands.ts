/*
  Copyright (C) The Infumap Authors
  This file is part of Infumap.

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU Affero General Public License as
  published by the Free Software Foundation, either version 3 of the
  License, or (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU Affero General Public License for more details.

  You should have received a copy of the GNU Affero General Public License
  along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/*
  Printed pages are laid out as a vertical sequence of bands. Each band is a normal-flow block of the arranged height
  that renders a horizontal strip of the page's child area, so the browser can paginate between bands while the
  items themselves keep their arranged (absolute) positions. Page breaks only ever fall between bands.
*/

import { LINE_HEIGHT_PX, NATURAL_BLOCK_SIZE_PX, NOTE_PADDING_PX, PAGE_DOCUMENT_LEFT_MARGIN_BL, PAGE_DOCUMENT_RIGHT_MARGIN_BL, PAGE_DOCUMENT_TOP_MARGIN_PX } from "../constants";
import { asNoteItem, isNote } from "../items/note-item";
import { ArrangeAlgorithm, PageFns, PageItem, asPageItem, isPage } from "../items/page-item";
import { VisualElementSignal } from "../util/signals";
import { noteHeadingLevel } from "./document-spacing";
import { documentLineHeightPxForNote } from "./text";
import { VisualElement } from "./visual-element";


/** Notes with at least this many lines may break across sheets (between lines). Shorter notes are kept together. */
const NOTE_SLICE_MIN_LINES = 6;

/** Lines kept together at the start and end of a note that breaks across sheets. */
const NOTE_ORPHAN_WIDOW_LINES = 2;

export type PrintBandContent =
  { kind: "title" } |
  { kind: "items", ves: Array<VisualElementSignal> };

export interface PrintBand {
  /** Top of the strip in the page's child area. */
  yPx: number,
  hPx: number,
  /** Space between the previous band's strip and this one. */
  marginTopPx: number,
  content: PrintBandContent,
  /** The strip is part of a taller item, so whatever lies outside it is clipped. */
  clip: boolean,
  breakInside: "avoid" | "auto",
  breakAfter: "avoid" | "auto",
}

export interface PrintLayout {
  bands: Array<PrintBand>,
  /** Left edge of the printed content in the page's child area (screen-only margins are dropped). */
  contentLeftPx: number,
  contentWidthPx: number,
}

/**
 * Whether the page has a print-specific layout. Pages without one print as displayed.
 */
export function pageHasPrintLayout(page: PageItem): boolean {
  return page.arrangeAlgorithm == ArrangeAlgorithm.Document;
}

/**
 * The print layout of a page, or null if the page has no print-specific layout.
 */
export function printLayout(pageVe: VisualElement, childVes: Array<VisualElementSignal>): PrintLayout | null {
  if (!isPage(pageVe.displayItem) || !pageHasPrintLayout(asPageItem(pageVe.displayItem))) { return null; }
  return documentPrintLayout(pageVe, childVes);
}

function documentPrintLayout(pageVe: VisualElement, childVes: Array<VisualElementSignal>): PrintLayout | null {
  const page = asPageItem(pageVe.displayItem);
  const childAreaBoundsPx = pageVe.childAreaBoundsPx;
  if (childAreaBoundsPx == null) { return null; }
  const totalWidthBl = page.docWidthBl + PAGE_DOCUMENT_LEFT_MARGIN_BL + PAGE_DOCUMENT_RIGHT_MARGIN_BL;
  const scale = childAreaBoundsPx.w / (totalWidthBl * NATURAL_BLOCK_SIZE_PX.w);

  const strips: Array<Omit<PrintBand, "marginTopPx">> = [];

  if (PageFns.showDocumentTitleInDocument(page)) {
    strips.push({
      yPx: PAGE_DOCUMENT_TOP_MARGIN_PX * scale,
      hPx: PageFns.calcDocumentTitleHeightBl(page) * NATURAL_BLOCK_SIZE_PX.h * scale,
      content: { kind: "title" },
      clip: false,
      breakInside: "avoid",
      breakAfter: "avoid",
    });
  }

  for (const ves of childVes) {
    const ve = ves.get();
    const boundsPx = ve.boundsPx;
    const lineStripsMaybe = noteLineStripsMaybe(ve, scale);
    if (lineStripsMaybe != null) {
      for (const lineStrip of lineStripsMaybe) {
        strips.push({ ...lineStrip, content: { kind: "items", ves: [ves] } });
      }
      continue;
    }
    strips.push({
      yPx: boundsPx.y,
      hPx: boundsPx.h,
      content: { kind: "items", ves: [ves] },
      clip: false,
      breakInside: "avoid",
      breakAfter: noteHeadingLevel(ve.displayItem) != null ? "avoid" : "auto",
    });
  }

  const bands: Array<PrintBand> = [];
  let prevBottomPx: number | null = null;
  for (const strip of strips) {
    bands.push({ ...strip, marginTopPx: prevBottomPx == null ? 0 : strip.yPx - prevBottomPx });
    prevBottomPx = strip.yPx + strip.hPx;
  }

  return {
    bands,
    contentLeftPx: PAGE_DOCUMENT_LEFT_MARGIN_BL * NATURAL_BLOCK_SIZE_PX.w * scale,
    contentWidthPx: page.docWidthBl * NATURAL_BLOCK_SIZE_PX.w * scale,
  };
}

/**
 * Splits a tall document note into one clipped strip per line of text, so a sheet break can only fall between lines.
 * A single strip can't be used: content pushed past a sheet break makes the note taller than its arranged height.
 * Returns null if the note should be kept in one piece.
 */
function noteLineStripsMaybe(ve: VisualElement, scale: number): Array<Omit<PrintBand, "marginTopPx" | "content">> | null {
  if (!isNote(ve.displayItem)) { return null; }
  const flags = asNoteItem(ve.displayItem).flags;
  const boundsPx = ve.boundsPx;
  // Matches the position of the title span in Note.tsx.
  const textTopPx = (NOTE_PADDING_PX - LINE_HEIGHT_PX / 4) * scale;
  const lineHeightPx = documentLineHeightPxForNote(flags) * scale;
  const lineCount = Math.max(1, Math.round((boundsPx.h - textTopPx) / lineHeightPx));
  if (lineCount < NOTE_SLICE_MIN_LINES) { return null; }

  const strips: Array<Omit<PrintBand, "marginTopPx" | "content">> = [];
  for (let i = 0; i < lineCount; ++i) {
    const topPx = i == 0 ? 0 : textTopPx + i * lineHeightPx;
    const bottomPx = i == lineCount - 1 ? boundsPx.h : textTopPx + (i + 1) * lineHeightPx;
    const keepWithNext = i < NOTE_ORPHAN_WIDOW_LINES - 1 || i >= lineCount - NOTE_ORPHAN_WIDOW_LINES;
    strips.push({
      yPx: boundsPx.y + topPx,
      hPx: bottomPx - topPx,
      clip: true,
      breakInside: "avoid",
      breakAfter: keepWithNext && i < lineCount - 1 ? "avoid" : "auto",
    });
  }
  return strips;
}
