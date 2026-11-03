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

import { NoteFlags, NOTE_INDENT_MAX_LEVEL, noteFlagsWithIndentLevel } from "../items/base/flags-item";
import type { TextDocumentBlock, TextDocumentInlineText, TextDocumentTableBlock } from "../items/markdown-blocks";
import {
  NoteInlineMark, NoteInlineMarkFlags, NoteUrl, normalizeNoteInlineMarks, normalizeNoteUrls, safeNoteLinkUrl,
} from "../items/note-item";


/**
 * Pasted html is only used if it has one of these. Without them it says no more than the plain text, and some html is
 * worse: a code editor's has a div per line, and a plain text page's is one pre, whose plain text may be markdown.
 * Google Docs wraps everything in a b (with font-weight: normal), so its html is always used.
 */
const STRUCTURE_SELECTOR = "h1, h2, h3, h4, h5, h6, li, table, hr, a[href], b, strong, i, em";
const SKIPPED_ELEMENTS = new Set([
  "head", "script", "style", "template", "noscript", "svg", "img", "picture", "video", "audio", "canvas", "iframe",
  "object", "button", "input", "select", "textarea",
]);
const BLOCK_ELEMENTS = new Set([
  "p", "div", "blockquote", "section", "article", "header", "footer", "main", "nav", "aside", "figure", "figcaption",
  "dl", "dt", "dd", "address", "details", "summary", "center", "caption", "table", "thead", "tbody", "tfoot", "tr",
  "td", "th",
]);
const HEADING_FLAGS = new Map<string, NoteFlags>([
  ["h1", NoteFlags.Heading1], ["h2", NoteFlags.Heading2], ["h3", NoteFlags.Heading3],
  ["h4", NoteFlags.Heading4], ["h5", NoteFlags.Heading4], ["h6", NoteFlags.Heading4],
]);

/**
 * "blocks": each block element is a paragraph. "listItem": paragraphs within a list item join it, as the lines of one
 * would in markdown, though a nested list is its own. "inline": everything joins, for a table cell.
 */
type Mode = "blocks" | "listItem" | "inline";

type Context = {
  mode: Mode,
  inlineFlags: number,
  url: string | null,
  blockFlags: number,
  listDepth: number,
  listFlag: NoteFlags,
};

type Paragraph = {
  title: string,
  inlineMarks: Array<NoteInlineMark>,
  urls: Array<NoteUrl>,
  blockFlags: number,
};


/**
 * The blocks of html pasted into a note, from a web page, Google Docs etc., or null if it has no structure that its
 * plain text doesn't (see STRUCTURE_SELECTOR). Kept: headings, bullet and numbered lists with nesting, code blocks,
 * dividers, tables, and bold, italic and links. Images are skipped: their data can't be fetched (see upload.ts).
 */
export function parsePastedHtmlBlocks(html: string): Array<TextDocumentBlock> | null {
  // An inert document: nothing in it is loaded or run.
  const body = new DOMParser().parseFromString(html, "text/html").body;
  if (body == null || body.querySelector(STRUCTURE_SELECTOR) == null) { return null; }
  const blocks = new HtmlBlocks().parse(body);
  return blocks.length == 0 ? null : blocks;
}

class HtmlBlocks {
  private blocks: Array<TextDocumentBlock> = [];
  private paragraph: Paragraph | null = null;

  parse(body: HTMLElement): Array<TextDocumentBlock> {
    const context: Context = { mode: "blocks", inlineFlags: 0, url: null, blockFlags: NoteFlags.None, listDepth: 0, listFlag: NoteFlags.Bullet1 };
    this.walkChildren(body, context);
    this.flush();
    return this.blocks;
  }

  /** The text of el, as one line, for a table cell. */
  inlineText(el: Element, context: Context): TextDocumentInlineText {
    this.walkChildren(el, { ...context, mode: "inline" });
    const paragraph = this.takeParagraph();
    return paragraph == null
      ? { title: "", inlineMarks: [], urls: [], linkIconHints: [] }
      : { title: paragraph.title, inlineMarks: paragraph.inlineMarks, urls: paragraph.urls, linkIconHints: [] };
  }

  private walkChildren(el: Element, context: Context): void {
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType == Node.TEXT_NODE) {
        this.appendText(child.textContent ?? "", context);
      } else if (child instanceof Element) {
        this.walkElement(child, context);
      }
    }
  }

  private walkElement(el: Element, parentContext: Context): void {
    const tag = el.localName;
    const style = el.getAttribute("style")?.toLowerCase() ?? "";
    if (SKIPPED_ELEMENTS.has(tag) || /display\s*:\s*none/.test(style)) { return; }
    const context = { ...parentContext, inlineFlags: inlineFlagsFor(tag, style, parentContext.inlineFlags) };
    if (tag == "a") {
      context.url = safeNoteLinkUrl(el.getAttribute("href")) ?? parentContext.url;
    }

    if (context.mode == "inline") {
      if (tag == "br" || BLOCK_ELEMENTS.has(tag) || tag == "li" || HEADING_FLAGS.has(tag)) {
        this.appendText(" ", context);
      }
      this.walkChildren(el, context);
      return;
    }

    if (tag == "br") {
      if (context.mode == "listItem") { this.appendText(" ", context); } else { this.flush(); }
      return;
    }
    if (tag == "hr") {
      this.flush();
      this.blocks.push({ kind: "divider", start: 0, end: 0, ordinal: this.blocks.length });
      return;
    }
    if (tag == "pre") {
      this.flush();
      const code = (el.textContent ?? "").replace(/\r\n?/g, "\n").replace(/\n+$/, "");
      if (code.trim() != "") {
        this.pushTextBlock({ title: code, inlineMarks: [], urls: [], blockFlags: NoteFlags.Code });
      }
      return;
    }
    if (tag == "table" && el instanceof HTMLTableElement) {
      const table = this.tableBlockMaybe(el, context);
      if (table != null) {
        this.flush();
        this.blocks.push(table);
        return;
      }
    }
    const headingFlag = HEADING_FLAGS.get(tag);
    if (headingFlag != null) {
      this.flush();
      this.walkChildren(el, { ...context, mode: "blocks", blockFlags: headingFlag });
      this.flush();
      return;
    }
    if (tag == "ul" || tag == "ol") {
      this.flush();
      this.walkChildren(el, {
        ...context, mode: "blocks", listDepth: context.listDepth + 1,
        listFlag: tag == "ol" ? NoteFlags.Numbered : NoteFlags.Bullet1,
      });
      this.flush();
      return;
    }
    if (tag == "li") {
      this.flush();
      // Google Docs nests lists by aria-level.
      const ariaLevel = parseInt(el.getAttribute("aria-level") ?? "", 10);
      const level = Number.isFinite(ariaLevel) ? ariaLevel - 1 : context.listDepth - 1;
      const indentLevel = Math.max(0, Math.min(level, NOTE_INDENT_MAX_LEVEL));
      this.walkChildren(el, { ...context, mode: "listItem", blockFlags: noteFlagsWithIndentLevel(context.listFlag, indentLevel) });
      this.flush();
      return;
    }
    if (BLOCK_ELEMENTS.has(tag)) {
      if (context.mode == "listItem") {
        this.appendText(" ", context);
        this.walkChildren(el, context);
        this.appendText(" ", context);
      } else {
        this.flush();
        this.walkChildren(el, context);
        this.flush();
      }
      return;
    }
    this.walkChildren(el, context);
  }

  /**
   * A table of two or more rows and columns, which isn't for layout (with a table in it). Others are read as
   * paragraphs. Its first row names the columns: there is often no th, e.g. in a copy from a spreadsheet.
   */
  private tableBlockMaybe(table: HTMLTableElement, context: Context): TextDocumentTableBlock | null {
    if (table.querySelector("table") != null) { return null; }
    const rows = Array.from(table.rows).map(row => {
      const cells: Array<TextDocumentInlineText> = [];
      for (const cell of Array.from(row.cells)) {
        cells.push(new HtmlBlocks().inlineText(cell, context));
        // Merged cells are spread back out, with the text in the first. Merged rows aren't.
        for (let i = 1; i < Math.min(cell.colSpan, 100); ++i) {
          cells.push({ title: "", inlineMarks: [], urls: [], linkIconHints: [] });
        }
      }
      return cells;
    });
    const columnCount = Math.max(0, ...rows.map(cells => cells.length));
    if (rows.length < 2 || columnCount < 2) { return null; }
    const padded = rows.map(cells => [
      ...cells,
      ...Array.from({ length: columnCount - cells.length }, () => ({ title: "", inlineMarks: [], urls: [], linkIconHints: [] })),
    ]);
    return {
      kind: "table",
      columns: padded[0].map(cell => cell.title),
      alignments: padded[0].map(() => "unspecified" as const),
      rows: padded.slice(1).map((cells, i) => ({ cells, start: 0, end: 0, ordinal: i })),
      start: 0,
      end: 0,
      ordinal: this.blocks.length,
    };
  }

  /** Appends text with its whitespace collapsed, as html shows it. */
  private appendText(raw: string, context: Context): void {
    let text = raw.replace(/[ \t\n\r\f ]+/g, " ");
    if (this.paragraph == null || this.paragraph.title == "" || this.paragraph.title.endsWith(" ")) {
      text = text.replace(/^ /, "");
    }
    if (text == "") { return; }
    if (this.paragraph == null) {
      this.paragraph = { title: "", inlineMarks: [], urls: [], blockFlags: context.blockFlags };
    }
    const start = this.paragraph.title.length;
    this.paragraph.title += text;
    const end = this.paragraph.title.length;
    if (context.inlineFlags != 0) { this.paragraph.inlineMarks.push({ start, end, flags: context.inlineFlags }); }
    if (context.url != null) { this.paragraph.urls.push({ start, end, url: context.url }); }
  }

  private takeParagraph(): Paragraph | null {
    const paragraph = this.paragraph;
    this.paragraph = null;
    if (paragraph == null) { return null; }
    const title = paragraph.title.trimEnd();
    if (title == "") { return null; }
    return {
      title,
      inlineMarks: normalizeNoteInlineMarks(paragraph.inlineMarks.map(mark => ({ ...mark, end: Math.min(mark.end, title.length) })), title),
      urls: normalizeNoteUrls(paragraph.urls.map(url => ({ ...url, end: Math.min(url.end, title.length) })), title),
      blockFlags: paragraph.blockFlags,
    };
  }

  private flush(): void {
    const paragraph = this.takeParagraph();
    if (paragraph != null) { this.pushTextBlock(paragraph); }
  }

  private pushTextBlock(paragraph: Paragraph): void {
    const heading = paragraph.blockFlags & (NoteFlags.Heading1 | NoteFlags.Heading2 | NoteFlags.Heading3 | NoteFlags.Heading4);
    this.blocks.push({
      kind: heading != 0 ? "heading" : "paragraph",
      title: paragraph.title,
      inlineMarks: paragraph.inlineMarks,
      urls: paragraph.urls,
      linkIconHints: [],
      headingLevel: heading == NoteFlags.Heading1 ? 1 : heading == NoteFlags.Heading2 ? 2 : heading == NoteFlags.Heading3 ? 3 : heading != 0 ? 4 : null,
      noteFlags: paragraph.blockFlags,
      start: 0,
      end: 0,
      ordinal: this.blocks.length,
    });
  }
}

/**
 * Bold and italic from tags and inline styles. Google Docs marks them only by style, inside a b whose style turns bold
 * off, so a style overrides the tag.
 */
function inlineFlagsFor(tag: string, style: string, parentFlags: number): number {
  let flags = parentFlags;
  if (tag == "b" || tag == "strong") { flags |= NoteInlineMarkFlags.Bold; }
  if (tag == "i" || tag == "em") { flags |= NoteInlineMarkFlags.Italic; }
  const weight = /font-weight\s*:\s*([a-z0-9]+)/.exec(style)?.[1];
  if (weight != null) {
    const numeric = parseInt(weight, 10);
    const bold = weight == "bold" || weight == "bolder" || (Number.isFinite(numeric) && numeric >= 600);
    flags = bold ? flags | NoteInlineMarkFlags.Bold : flags & ~NoteInlineMarkFlags.Bold;
  }
  const fontStyle = /font-style\s*:\s*([a-z]+)/.exec(style)?.[1];
  if (fontStyle != null) {
    const italic = fontStyle == "italic" || fontStyle == "oblique";
    flags = italic ? flags | NoteInlineMarkFlags.Italic : flags & ~NoteInlineMarkFlags.Italic;
  }
  return flags;
}
