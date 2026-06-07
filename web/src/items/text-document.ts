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

import { arrangeNow, requestArrange } from "../layout/arrange";
import { switchToPage } from "../layout/navigation";
import { GRID_SIZE } from "../constants";
import { RelationshipToParent } from "../layout/relationship-to-parent";
import {
  noteFlagsWithIndentLevel,
  noteHasListStyle,
  noteIndentLevelFromFlags,
  PageFlags,
  NoteFlags,
  TableFlags,
} from "./base/flags-item";
import { Item, ItemType } from "./base/item";
import { ItemFns } from "./base/item-polymorphism";
import { titleWithCopySuffix } from "./base/titled-item";
import { PlaceholderFns } from "./placeholder-item";
import { NoteFns, NoteInlineMark, NoteInlineMarkFlags, NoteItem, NoteUrl, normalizeNoteInlineMarks, normalizeNoteUrls } from "./note-item";
import { DividerFns } from "./divider-item";
import { ArrangeAlgorithm, PageFns, PageItem, asPageItem, isPage } from "./page-item";
import { TableFns } from "./table-item";
import type { TextItem } from "./text-item";
import { itemState } from "../store/ItemState";
import { StoreContextModel } from "../store/StoreProvider";
import { TransientMessageType } from "../store/StoreProvider_Overlay";
import { server, serverOrRemote } from "../server";
import { newOrdering, newOrderingAtEnd } from "../util/ordering";
import { EMPTY_UID, Uid } from "../util/uid";
import { fetchRemoteFileText, openRemoteFileInNewTab } from "../util/remoteFile";

type TextDocumentInlineText = {
  title: string,
  inlineMarks: Array<NoteInlineMark>,
  urls: Array<NoteUrl>,
};

type TextDocumentTextBlock = {
  kind: "paragraph" | "heading",
  title: string,
  inlineMarks: Array<NoteInlineMark>,
  urls: Array<NoteUrl>,
  headingLevel: number | null,
  noteFlags: NoteFlags,
  start: number,
  end: number,
  ordinal: number,
};

type TextDocumentTableRow = {
  cells: Array<TextDocumentInlineText>,
  start: number,
  end: number,
  ordinal: number,
};

type TextDocumentTableBlock = {
  kind: "table",
  columns: Array<string>,
  rows: Array<TextDocumentTableRow>,
  start: number,
  end: number,
  ordinal: number,
};

type TextDocumentDividerBlock = {
  kind: "divider",
  start: number,
  end: number,
  ordinal: number,
};

type TextDocumentBlock = TextDocumentTextBlock | TextDocumentTableBlock | TextDocumentDividerBlock;

type TextLine = {
  text: string,
  start: number,
  end: number,
  nextStart: number,
};

type MarkdownCodeFenceInfo = {
  tickCount: number,
};

type MarkdownCodeBlockParse = {
  block: TextDocumentTextBlock,
  endIndex: number,
};

type MarkdownFrontMatterTableParse = {
  block: TextDocumentTableBlock,
  endIndex: number,
};

type MarkdownFrontMatterRawRow = {
  key: string,
  valueParts: Array<string>,
  valueMode: "scalar" | "list" | "block",
  start: number,
  end: number,
};

type TextDocumentGeneratedItems = {
  rootChildren: Array<Item>,
  tableChildrenByTableId: { [id: string]: Array<Item> },
  attachmentsByParentId: { [id: string]: Array<Item> },
  allItems: Array<Item>,
};

const readonlyCapabilities = { edit: false, move: false };
const readonlyCopyableCapabilities = { edit: false, move: false, copy: true };
const virtualSourceTextIdByPageId = new Map<Uid, Uid>();
const textContentPromises = new Map<string, Promise<string>>();
const MAX_GENERATED_TABLE_HEIGHT_BL = 12;

type RawInlineMarkSpan = {
  start: number,
  end: number,
  flags: number,
};

type InlineDelimiter = {
  marker: string,
  len: number,
  flags: number,
  outputStart: number,
};

const CHATGPT_ARTIFACT_START = "\uE200";
const CHATGPT_ARTIFACT_SEPARATOR = "\uE202";
const CHATGPT_ARTIFACT_END = "\uE201";
const CHATGPT_ARTIFACT_BODY_RE = /^(?:cite|finance)\uE202turn\d+[a-z]+\d+(?:\uE202turn\d+[a-z]+\d+)*$/;
const CHATGPT_ARTIFACT_TRIM_BEFORE = ",.;:!?)]}\"'";
const MARKDOWN_ASCII_EQUIVALENTS: { [char: string]: string } = {
  "\u2013": "-",
  "\u2014": "--",
  "\u2018": "'",
  "\u2019": "'",
  "\u201C": "\"",
  "\u201D": "\"",
  "\uE200": "",
  "\uE201": "",
  "\uE202": "",
};

function integerColumnWidthsGr(totalWidthGr: number, columnCount: number): Array<number> {
  const safeColumnCount = Math.max(1, columnCount);
  const integerTotalWidthGr = Math.max(1, Math.round(totalWidthGr));
  const baseWidthGr = Math.floor(integerTotalWidthGr / safeColumnCount);
  const remainderGr = integerTotalWidthGr - baseWidthGr * safeColumnCount;
  return Array.from({ length: safeColumnCount }, (_, i) => baseWidthGr + (i < remainderGr ? 1 : 0));
}

function setTransientMessage(store: StoreContextModel, text: string, type: TransientMessageType): void {
  store.overlay.toolbarTransientMessage.set({ text, type });
  setTimeout(() => { store.overlay.toolbarTransientMessage.set(null); }, 1500);
}

function stableUid(input: string): Uid {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  let h3 = 0x85ebca6b;
  let h4 = 0xc2b2ae35;
  for (let i = 0; i < input.length; ++i) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca6b);
    h3 = Math.imul(h3 ^ c, 0xc2b2ae35);
    h4 = Math.imul(h4 ^ c, 0x27d4eb2d);
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  return `${hex(h1)}${hex(h2)}${hex(h3)}${hex(h4)}`;
}

function sourceKey(textItem: TextItem): string {
  return `${textItem.origin ?? ""}|${textItem.id}`;
}

function textDocumentUrl(textItem: TextItem): string {
  if (textItem.origin == null) {
    return `/${textItem.id}`;
  }
  return `/remote/${encodeURIComponent(textItem.origin)}/${textItem.id}`;
}

function pushTextDocumentUrlIfNeeded(store: StoreContextModel, textItem: TextItem): void {
  const url = textDocumentUrl(textItem);
  if (window.location.pathname != url) {
    window.history.pushState(null, "", url);
  }
  store.currentUrlPath.set(url);
}

async function fetchLocalFileText(itemId: string): Promise<string> {
  const response = await fetch(`/files/${itemId}`, { method: "GET" });
  if (!response.ok || response.status !== 200) {
    throw new Error(`Text file fetch failed: ${response.status}`);
  }
  return response.text();
}

export async function fetchTextItemContent(textItem: TextItem): Promise<string> {
  const key = sourceKey(textItem);
  const existing = textContentPromises.get(key);
  if (existing) { return existing; }

  const promise = (textItem.origin == null
    ? fetchLocalFileText(textItem.id)
    : fetchRemoteFileText(textItem.origin, textItem.id))
    .catch((e) => {
      textContentPromises.delete(key);
      throw e;
    });
  textContentPromises.set(key, promise);
  return promise;
}

function linesWithOffsets(text: string): Array<TextLine> {
  const result: Array<TextLine> = [];
  let start = 0;
  while (start < text.length) {
    let end = start;
    while (end < text.length && text[end] != "\n" && text[end] != "\r") {
      end += 1;
    }
    let nextStart = end;
    if (nextStart < text.length) {
      nextStart += text[nextStart] == "\r" && text[nextStart + 1] == "\n" ? 2 : 1;
    }
    result.push({ text: text.substring(start, end), start, end, nextStart });
    start = nextStart;
  }
  return result;
}

function headingInfo(line: string): { level: number, title: string } | null {
  const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line.trim());
  if (!match) { return null; }
  return {
    level: Math.min(match[1].length, 4),
    title: match[2].trim(),
  };
}

type MarkdownListKind = "bullet" | "numbered";

type MarkdownListContainer = {
  bodyColumn: number,
};

type MarkdownListMarkerInfo = {
  kind: MarkdownListKind,
  title: string,
  bodyColumn: number,
  indentLevel: number,
};

type MarkdownListContinuationInfo = {
  title: string,
  indentLevel: number,
};

function markdownColumnAfterChar(column: number, c: string): number {
  return c == "\t" ? column + (4 - (column % 4)) : column + 1;
}

function markdownLeadingWhitespaceInfo(line: string): { index: number, column: number } {
  let index = 0;
  let column = 0;
  while (index < line.length && (line[index] == " " || line[index] == "\t")) {
    column = markdownColumnAfterChar(column, line[index]);
    index += 1;
  }
  return { index, column };
}

function markdownColumnAfterText(text: string, start: number, end: number, column: number): number {
  for (let i = start; i < end; ++i) {
    column = markdownColumnAfterChar(column, text[i]);
  }
  return column;
}

function markdownListIndentLevel(markerColumn: number, stack: Array<MarkdownListContainer>): number | null {
  for (let level = stack.length - 1; level >= 0; --level) {
    if (markerColumn >= stack[level].bodyColumn && markerColumn <= stack[level].bodyColumn + 3) {
      return Math.min(level + 1, 3);
    }
  }
  return markerColumn <= 3 ? 0 : null;
}

function markdownListMarkerInfo(line: string, stack: Array<MarkdownListContainer>): MarkdownListMarkerInfo | null {
  const leading = markdownLeadingWhitespaceInfo(line);
  if (leading.index >= line.length) { return null; }

  let kind: MarkdownListKind | null = null;
  let markerEnd = leading.index;
  if ("-+*".includes(line[leading.index])) {
    kind = "bullet";
    markerEnd += 1;
  } else {
    const orderedMatch = /^(\d{1,9})([.)])/.exec(line.substring(leading.index));
    if (orderedMatch != null) {
      kind = "numbered";
      markerEnd += orderedMatch[0].length;
    }
  }
  if (kind == null || markerEnd >= line.length || (line[markerEnd] != " " && line[markerEnd] != "\t")) {
    return null;
  }

  let contentIndex = markerEnd;
  let contentColumn = markdownColumnAfterText(line, leading.index, markerEnd, leading.column);
  const markerWidth = contentColumn - leading.column;
  while (contentIndex < line.length && (line[contentIndex] == " " || line[contentIndex] == "\t")) {
    contentColumn = markdownColumnAfterChar(contentColumn, line[contentIndex]);
    contentIndex += 1;
  }

  const paddingWidth = contentColumn - leading.column - markerWidth;
  if (paddingWidth < 1 || paddingWidth > 4) { return null; }

  const title = line.substring(contentIndex).trim();
  if (title == "") { return null; }

  const indentLevel = markdownListIndentLevel(leading.column, stack);
  if (indentLevel == null) { return null; }

  return {
    kind,
    title,
    bodyColumn: contentColumn,
    indentLevel,
  };
}

function markdownListContinuationInfo(line: string, stack: Array<MarkdownListContainer>): MarkdownListContinuationInfo | null {
  if (stack.length == 0) { return null; }

  const title = line.trim();
  if (title == "") { return null; }

  const leading = markdownLeadingWhitespaceInfo(line);
  for (let level = stack.length - 1; level >= 0; --level) {
    if (leading.column >= stack[level].bodyColumn) {
      return { title, indentLevel: level };
    }
  }

  return null;
}

function noteFlagsForHeadingLevel(level: number | null): NoteFlags {
  if (level == 1) { return NoteFlags.Heading1; }
  if (level == 2) { return NoteFlags.Heading2; }
  if (level == 3) { return NoteFlags.Heading3; }
  if (level != null && level >= 4) { return NoteFlags.Heading4; }
  return NoteFlags.None;
}

function isAsciiAlnum(c: string | undefined): boolean {
  return c != null && /^[A-Za-z0-9]$/.test(c);
}

function markdownDelimiterInfo(text: string, pos: number): { marker: string, len: number, flags: number } | null {
  const marker = text[pos];
  if (marker != "*" && marker != "_") { return null; }
  if (marker == "_" && isAsciiAlnum(text[pos - 1]) && isAsciiAlnum(text[pos + 1])) {
    return null;
  }

  let runLen = 0;
  while (text[pos + runLen] == marker) {
    runLen += 1;
  }

  const len = runLen >= 3 ? 3 : runLen >= 2 ? 2 : 1;
  const flags = len == 3
    ? NoteInlineMarkFlags.Bold | NoteInlineMarkFlags.Italic
    : len == 2
      ? NoteInlineMarkFlags.Bold
      : NoteInlineMarkFlags.Italic;
  return { marker, len, flags };
}

function matchingInlineDelimiterIndex(stack: Array<InlineDelimiter>, marker: string, len: number): number {
  for (let i = stack.length - 1; i >= 0; --i) {
    if (stack[i].marker == marker && stack[i].len == len) {
      return i;
    }
  }
  return -1;
}

function chatGptMarkdownArtifactEnd(text: string, pos: number): number | null {
  if (text[pos] != CHATGPT_ARTIFACT_START) { return null; }

  const end = text.indexOf(CHATGPT_ARTIFACT_END, pos + 1);
  if (end < 0) { return null; }

  const body = text.substring(pos + 1, end);
  if (
    body.includes(CHATGPT_ARTIFACT_START) ||
    body.includes("\n") ||
    body.includes("\r") ||
    !body.includes(CHATGPT_ARTIFACT_SEPARATOR) ||
    !CHATGPT_ARTIFACT_BODY_RE.test(body)
  ) {
    return null;
  }

  return end + 1;
}

function normalizeMarkdownDocumentText(text: string): string {
  let result = "";
  for (let i = 0; i < text.length;) {
    const artifactEnd = chatGptMarkdownArtifactEnd(text, i);
    if (artifactEnd != null) {
      i = artifactEnd;
      continue;
    }

    const c = text[i];
    result += MARKDOWN_ASCII_EQUIVALENTS[c] ?? c;
    i += 1;
  }
  return result;
}

function outputInlineLength(output: Array<string>): number {
  return output.reduce((sum, part) => sum + part.length, 0);
}

function outputEndsInlineWhitespace(output: Array<string>): boolean {
  for (let i = output.length - 1; i >= 0; --i) {
    const part = output[i];
    if (part.length == 0) { continue; }
    const c = part[part.length - 1];
    return c == " " || c == "\t";
  }
  return false;
}

function trimTrailingInlineWhitespace(output: Array<string>, rawSpans: Array<RawInlineMarkSpan>): void {
  let changed = false;
  while (output.length > 0) {
    const part = output[output.length - 1];
    const trimmed = part.replace(/[ \t]+$/, "");
    if (trimmed.length == part.length) { break; }
    changed = true;
    if (trimmed.length == 0) {
      output.pop();
    } else {
      output[output.length - 1] = trimmed;
      break;
    }
  }

  if (!changed) { return; }
  const textLen = outputInlineLength(output);
  for (const span of rawSpans) {
    if (span.end > textLen) {
      span.end = Math.max(span.start, textLen);
    }
  }
}

function trimTrailingInlineUrls(rawUrls: Array<NoteUrl>, textLen: number): void {
  for (const url of rawUrls) {
    if (url.end > textLen) {
      url.end = Math.max(url.start, textLen);
    }
  }
}

function shouldTrimBeforeChatGptArtifactNextChar(c: string | undefined): boolean {
  return c == null || CHATGPT_ARTIFACT_TRIM_BEFORE.includes(c);
}

function skipMarkdownCodeSpan(text: string, pos: number): number {
  let tickLen = 0;
  while (text[pos + tickLen] == "`") {
    tickLen += 1;
  }

  const marker = "`".repeat(tickLen);
  const end = text.indexOf(marker, pos + tickLen);
  return end < 0 ? pos + 1 : end + tickLen;
}

function findMarkdownLinkLabelEnd(text: string, pos: number): number | null {
  if (text[pos] != "[") { return null; }
  let depth = 0;
  for (let i = pos; i < text.length; ++i) {
    const c = text[i];
    if (c == "\\" && i + 1 < text.length) {
      i += 1;
      continue;
    }
    if (c == "`") {
      i = skipMarkdownCodeSpan(text, i) - 1;
      continue;
    }
    if (c == "[") {
      depth += 1;
      continue;
    }
    if (c == "]") {
      depth -= 1;
      if (depth == 0) { return i; }
    }
  }
  return null;
}

function findMarkdownLinkDestinationEnd(text: string, pos: number): number | null {
  if (text[pos] != "(") { return null; }
  let depth = 0;
  for (let i = pos + 1; i < text.length; ++i) {
    const c = text[i];
    if (c == "\\" && i + 1 < text.length) {
      i += 1;
      continue;
    }
    if (c == "(") {
      depth += 1;
      continue;
    }
    if (c == ")") {
      if (depth == 0) { return i; }
      depth -= 1;
    }
  }
  return null;
}

function unescapeMarkdownLinkDestination(value: string): string {
  return value.replace(/\\([\\()[\]<>])/g, "$1");
}

function markdownLinkDestination(rawDestination: string): string | null {
  const trimmed = rawDestination.trim();
  if (trimmed == "") { return null; }

  const angleWrapped = /^<([^<>\r\n]*)>(?:\s+.*)?$/.exec(trimmed);
  if (angleWrapped != null) {
    const url = angleWrapped[1].trim();
    return url == "" ? null : unescapeMarkdownLinkDestination(url);
  }

  const token = /^[^\s]+/.exec(trimmed)?.[0] ?? "";
  const url = unescapeMarkdownLinkDestination(token).trim();
  return url == "" ? null : url;
}

function markdownLinkAt(text: string, pos: number): { label: string, url: string, end: number } | null {
  const labelEnd = findMarkdownLinkLabelEnd(text, pos);
  if (labelEnd == null || text[labelEnd + 1] != "(") { return null; }

  const destinationEnd = findMarkdownLinkDestinationEnd(text, labelEnd + 1);
  if (destinationEnd == null) { return null; }

  const url = markdownLinkDestination(text.substring(labelEnd + 2, destinationEnd));
  if (url == null) { return null; }

  return {
    label: text.substring(pos + 1, labelEnd),
    url,
    end: destinationEnd + 1,
  };
}

function markdownAutolinkAt(text: string, pos: number): { title: string, url: string, end: number } | null {
  if (text[pos] != "<") { return null; }
  const end = text.indexOf(">", pos + 1);
  if (end < 0) { return null; }

  const value = text.substring(pos + 1, end);
  if (!/^https?:\/\/[^\s<>]+$/i.test(value)) { return null; }
  return { title: normalizeMarkdownDocumentText(value), url: value, end: end + 1 };
}

function flattenedInlineMarks(rawSpans: Array<RawInlineMarkSpan>, text: string): Array<NoteInlineMark> {
  if (rawSpans.length == 0 || text == "") { return []; }

  const boundaries = new Set<number>([0, text.length]);
  for (const span of rawSpans) {
    if (span.start < span.end) {
      boundaries.add(span.start);
      boundaries.add(span.end);
    }
  }

  const sortedBoundaries = Array.from(boundaries).sort((a, b) => a - b);
  const result: Array<NoteInlineMark> = [];
  for (let i = 0; i < sortedBoundaries.length - 1; ++i) {
    const start = sortedBoundaries[i];
    const end = sortedBoundaries[i + 1];
    if (start == end) { continue; }

    let flags = 0;
    for (const span of rawSpans) {
      if (span.start <= start && span.end >= end) {
        flags |= span.flags;
      }
    }
    if (flags != 0) {
      result.push({ start, end, flags });
    }
  }

  return normalizeNoteInlineMarks(result, text);
}

function copyMarkdownCodeSpan(text: string, pos: number, output: Array<string>): number {
  let tickLen = 0;
  while (text[pos + tickLen] == "`") {
    tickLen += 1;
  }

  const marker = "`".repeat(tickLen);
  const end = text.indexOf(marker, pos + tickLen);
  if (end < 0) {
    output.push(text[pos]);
    return pos + 1;
  }

  output.push(normalizeMarkdownDocumentText(text.substring(pos + tickLen, end)));
  return end + tickLen;
}

function parseMarkdownInline(text: string): TextDocumentInlineText {
  const output: Array<string> = [];
  const stack: Array<InlineDelimiter> = [];
  const rawSpans: Array<RawInlineMarkSpan> = [];
  const rawUrls: Array<NoteUrl> = [];

  for (let i = 0; i < text.length;) {
    const c = text[i];

    if (c == "\\" && i + 1 < text.length && "*_`\\[]()<>".includes(text[i + 1])) {
      output.push(text[i + 1]);
      i += 2;
      continue;
    }

    if (c == "`") {
      i = copyMarkdownCodeSpan(text, i, output);
      continue;
    }

    const artifactEnd = chatGptMarkdownArtifactEnd(text, i);
    if (artifactEnd != null) {
      const next = text[artifactEnd];
      const shouldSkipFollowingWhitespace = outputInlineLength(output) == 0 || outputEndsInlineWhitespace(output);
      if (shouldTrimBeforeChatGptArtifactNextChar(next)) {
        trimTrailingInlineWhitespace(output, rawSpans);
        trimTrailingInlineUrls(rawUrls, outputInlineLength(output));
      }
      i = artifactEnd;
      if (shouldSkipFollowingWhitespace) {
        while (text[i] == " " || text[i] == "\t") {
          i += 1;
        }
      }
      continue;
    }

    const link = c == "[" ? markdownLinkAt(text, i) : null;
    if (link != null) {
      const parsedLabel = parseMarkdownInline(link.label);
      const start = outputInlineLength(output);
      const end = start + parsedLabel.title.length;
      if (start < end) {
        output.push(parsedLabel.title);
        rawSpans.push(...parsedLabel.inlineMarks.map(mark => ({
          start: mark.start + start,
          end: mark.end + start,
          flags: mark.flags,
        })));
        rawUrls.push({ start, end, url: link.url });
      }
      i = link.end;
      continue;
    }

    const autolink = c == "<" ? markdownAutolinkAt(text, i) : null;
    if (autolink != null) {
      const start = outputInlineLength(output);
      const end = start + autolink.title.length;
      output.push(autolink.title);
      rawUrls.push({ start, end, url: autolink.url });
      i = autolink.end;
      continue;
    }

    const delimiter = markdownDelimiterInfo(text, i);
    if (delimiter != null) {
      const matchingIndex = matchingInlineDelimiterIndex(stack, delimiter.marker, delimiter.len);
      if (matchingIndex >= 0) {
        const opener = stack.splice(matchingIndex, 1)[0];
        const start = opener.outputStart;
        const end = output.join("").length;
        if (start < end) {
          rawSpans.push({ start, end, flags: opener.flags });
        }
      } else {
        stack.push({ ...delimiter, outputStart: output.join("").length });
      }
      i += delimiter.len;
      continue;
    }

    output.push(MARKDOWN_ASCII_EQUIVALENTS[c] ?? c);
    i += 1;
  }

  if (stack.length != 0) {
    return { title: normalizeMarkdownDocumentText(text), inlineMarks: [], urls: [] };
  }

  const title = output.join("");
  return { title, inlineMarks: flattenedInlineMarks(rawSpans, title), urls: normalizeNoteUrls(rawUrls, title) };
}

function splitMarkdownTableRow(line: string): Array<string> | null {
  let body = line.trim();
  if (body == "") { return null; }

  if (body.startsWith("|")) {
    body = body.substring(1);
  }
  if (body.endsWith("|") && (body.length < 2 || body[body.length - 2] != "\\")) {
    body = body.substring(0, body.length - 1);
  }

  const cells: Array<string> = [];
  let cell = "";
  let sawSeparator = false;
  for (let i = 0; i < body.length; ++i) {
    const c = body[i];
    if (c == "\\" && body[i + 1] == "|") {
      cell += "|";
      i += 1;
      continue;
    }
    if (c == "|") {
      cells.push(cell.trim());
      cell = "";
      sawSeparator = true;
      continue;
    }
    cell += c;
  }
  cells.push(cell.trim());

  if (!sawSeparator || cells.length < 2) { return null; }
  return cells;
}

function isMarkdownTableSeparatorCell(cell: string): boolean {
  return /^:?-{3,}:?$/.test(cell.trim());
}

function isMarkdownTableSeparatorRow(cells: Array<string>): boolean {
  return cells.length >= 2 && cells.every(isMarkdownTableSeparatorCell);
}

function normalizeMarkdownTableCells(cells: Array<string>, columnCount: number): Array<string> {
  const result = cells.slice(0, columnCount);
  while (result.length < columnCount) {
    result.push("");
  }
  return result;
}

function normalizeMarkdownTableInlineCells(cells: Array<string>, columnCount: number): Array<TextDocumentInlineText> {
  return normalizeMarkdownTableCells(cells, columnCount).map(parseMarkdownInline);
}

function plainInlineText(title: string): TextDocumentInlineText {
  return { title: normalizeMarkdownDocumentText(title), inlineMarks: [], urls: [] };
}

function parseMarkdownTableAt(lines: Array<TextLine>, index: number): TextDocumentTableBlock | null {
  if (index + 1 >= lines.length) { return null; }

  const headerCells = splitMarkdownTableRow(lines[index].text);
  const separatorCells = splitMarkdownTableRow(lines[index + 1].text);
  if (headerCells == null || separatorCells == null) { return null; }
  if (separatorCells.length < headerCells.length || !isMarkdownTableSeparatorRow(separatorCells)) { return null; }

  const columnCount = headerCells.length;
  const rows: Array<TextDocumentTableRow> = [];
  let end = lines[index + 1].end;
  let rowIndex = index + 2;
  while (rowIndex < lines.length) {
    const rowCells = splitMarkdownTableRow(lines[rowIndex].text);
    if (rowCells == null || isMarkdownTableSeparatorRow(rowCells)) { break; }
    rows.push({
      cells: normalizeMarkdownTableInlineCells(rowCells, columnCount),
      start: lines[rowIndex].start,
      end: lines[rowIndex].end,
      ordinal: rows.length,
    });
    end = lines[rowIndex].end;
    rowIndex += 1;
  }

  return {
    kind: "table",
    columns: normalizeMarkdownTableCells(headerCells, columnCount).map(cell => parseMarkdownInline(cell).title),
    rows,
    start: lines[index].start,
    end,
    ordinal: 0,
  };
}

function isMarkdownDividerLine(line: string): boolean {
  const trimmed = line.trim();
  return /^(-\s*){3,}$/.test(trimmed) ||
    /^(_\s*){3,}$/.test(trimmed) ||
    /^(\*\s*){3,}$/.test(trimmed);
}

function isMarkdownFrontMatterDelimiterLine(line: string, allowBom: boolean): boolean {
  const normalized = allowBom ? line.replace(/^\uFEFF/, "") : line;
  return normalized.trim() == "---";
}

function normalizeMarkdownFrontMatterScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed == "null" || trimmed == "~") { return ""; }

  if (trimmed.length >= 2 && trimmed[0] == "\"" && trimmed[trimmed.length - 1] == "\"") {
    const unescaped = trimmed.substring(1, trimmed.length - 1).replace(/\\(["\\/bfnrt])/g, (_, escaped: string) => {
      if (escaped == "b") { return "\b"; }
      if (escaped == "f") { return "\f"; }
      if (escaped == "n") { return "\n"; }
      if (escaped == "r") { return "\r"; }
      if (escaped == "t") { return "\t"; }
      return escaped;
    });
    return unescaped.replace(/[\r\n]+/g, " ");
  }

  if (trimmed.length >= 2 && trimmed[0] == "'" && trimmed[trimmed.length - 1] == "'") {
    return trimmed.substring(1, trimmed.length - 1).replace(/''/g, "'");
  }

  return trimmed;
}

function splitMarkdownFrontMatterInlineArray(value: string): Array<string> | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) { return null; }

  const body = trimmed.substring(1, trimmed.length - 1).trim();
  if (body == "") { return []; }

  const parts: Array<string> = [];
  let part = "";
  let quote: string | null = null;
  for (let i = 0; i < body.length; ++i) {
    const c = body[i];
    if (quote != null) {
      part += c;
      if (c == "\\" && quote == "\"" && i + 1 < body.length) {
        i += 1;
        part += body[i];
        continue;
      }
      if (c == quote) {
        quote = null;
      }
      continue;
    }

    if (c == "\"" || c == "'") {
      quote = c;
      part += c;
      continue;
    }
    if (c == ",") {
      parts.push(normalizeMarkdownFrontMatterScalar(part));
      part = "";
      continue;
    }
    part += c;
  }
  parts.push(normalizeMarkdownFrontMatterScalar(part));

  return parts;
}

function markdownFrontMatterValueParts(value: string): Array<string> {
  const inlineArray = splitMarkdownFrontMatterInlineArray(value);
  if (inlineArray != null) { return inlineArray; }
  return [normalizeMarkdownFrontMatterScalar(value)];
}

function markdownFrontMatterRowValue(row: MarkdownFrontMatterRawRow): string {
  const separator = row.valueMode == "list" ? ", " : " ";
  return row.valueParts.filter(part => part.trim() != "").join(separator);
}

function appendMarkdownFrontMatterRowValue(row: MarkdownFrontMatterRawRow, value: string, line: TextLine, mode: "list" | "block"): void {
  row.valueParts.push(...markdownFrontMatterValueParts(value));
  if (row.valueMode != "block") {
    row.valueMode = mode;
  }
  row.end = line.end;
}

function parseMarkdownFrontMatterAt(lines: Array<TextLine>, index: number): MarkdownFrontMatterTableParse | null {
  if (index != 0 || lines.length < 3 || !isMarkdownFrontMatterDelimiterLine(lines[index].text, true)) {
    return null;
  }

  let endIndex = -1;
  for (let i = index + 1; i < lines.length; ++i) {
    if (isMarkdownFrontMatterDelimiterLine(lines[i].text, false)) {
      endIndex = i;
      break;
    }
  }
  if (endIndex < 0) { return null; }

  const rawRows: Array<MarkdownFrontMatterRawRow> = [];
  let currentRow: MarkdownFrontMatterRawRow | null = null;
  for (let i = index + 1; i < endIndex; ++i) {
    const line = lines[i];
    const trimmed = line.text.trim();
    if (trimmed == "" || trimmed.startsWith("#")) { continue; }

    if (line.text[0] != " " && line.text[0] != "\t") {
      const keyMatch = /^([^:\s][^:]*):(?:[ \t]*(.*))?$/.exec(line.text);
      if (keyMatch == null) { return null; }

      const key = normalizeMarkdownFrontMatterScalar(keyMatch[1]);
      if (key == "") { return null; }

      const value = keyMatch[2] ?? "";
      const isBlockScalar = /^[>|][-+]?$/.test(value.trim());
      currentRow = {
        key,
        valueParts: isBlockScalar ? [] : markdownFrontMatterValueParts(value),
        valueMode: isBlockScalar ? "block" : "scalar",
        start: line.start,
        end: line.end,
      };
      rawRows.push(currentRow);
      continue;
    }

    if (currentRow == null) { return null; }

    const listMatch = /^[ \t]+-[ \t]*(.*)$/.exec(line.text);
    if (listMatch != null) {
      appendMarkdownFrontMatterRowValue(currentRow, listMatch[1], line, "list");
      continue;
    }

    appendMarkdownFrontMatterRowValue(currentRow, trimmed, line, "block");
  }

  if (rawRows.length == 0) { return null; }

  const rows = rawRows.map((row, ordinal) => ({
    cells: [
      plainInlineText(row.key),
      parseMarkdownInline(markdownFrontMatterRowValue(row)),
    ],
    start: row.start,
    end: row.end,
    ordinal,
  }));

  return {
    block: {
      kind: "table",
      columns: ["key", "value"],
      rows,
      start: lines[index].start,
      end: lines[endIndex].end,
      ordinal: 0,
    },
    endIndex,
  };
}

function markdownCodeFenceInfo(line: string): MarkdownCodeFenceInfo | null {
  const match = /^ {0,3}(`{3,})[^`]*$/.exec(line);
  if (match == null) { return null; }
  return { tickCount: match[1].length };
}

function isMarkdownCodeFenceClose(line: string, openingTickCount: number): boolean {
  const match = /^ {0,3}(`{3,})[ \t]*$/.exec(line);
  return match != null && match[1].length >= openingTickCount;
}

function parseMarkdownCodeBlockAt(lines: Array<TextLine>, index: number): MarkdownCodeBlockParse | null {
  const fence = markdownCodeFenceInfo(lines[index].text);
  if (fence == null) { return null; }

  const codeLines: Array<string> = [];
  let end = lines[index].end;
  let endIndex = index;
  for (let i = index + 1; i < lines.length; ++i) {
    end = lines[i].end;
    endIndex = i;
    if (isMarkdownCodeFenceClose(lines[i].text, fence.tickCount)) {
      break;
    }
    codeLines.push(lines[i].text);
  }

  return {
    block: {
      kind: "paragraph",
      title: normalizeMarkdownDocumentText(codeLines.join("\n")),
      inlineMarks: [],
      urls: [],
      headingLevel: null,
      noteFlags: NoteFlags.Code,
      start: lines[index].start,
      end,
      ordinal: 0,
    },
    endIndex,
  };
}

function isMarkdownTextItem(textItem: TextItem): boolean {
  const mimeType = (textItem.mimeType ?? "").toLowerCase();
  const title = textItem.title.toLowerCase();
  return mimeType == "text/markdown" ||
    mimeType == "text/x-markdown" ||
    title.endsWith(".md") ||
    title.endsWith(".markdown");
}

function markdownInlineForParagraphLines(lines: Array<TextLine>): TextDocumentInlineText {
  const titleParts: Array<string> = [];
  const inlineMarks: Array<NoteInlineMark> = [];
  const urls: Array<NoteUrl> = [];
  let offset = 0;

  for (const line of lines) {
    const trimmed = line.text.trim();
    if (trimmed == "") { continue; }
    const parsed = parseMarkdownInline(trimmed);
    if (titleParts.length > 0) {
      titleParts.push(" ");
      offset += 1;
    }
    titleParts.push(parsed.title);
    inlineMarks.push(...parsed.inlineMarks.map(mark => ({
      start: mark.start + offset,
      end: mark.end + offset,
      flags: mark.flags,
    })));
    urls.push(...parsed.urls.map(url => ({
      start: url.start + offset,
      end: url.end + offset,
      url: url.url,
    })));
    offset += parsed.title.length;
  }

  const title = titleParts.join("");
  return { title, inlineMarks: normalizeNoteInlineMarks(inlineMarks, title), urls: normalizeNoteUrls(urls, title) };
}

function appendMarkdownInlineTextBlock(block: TextDocumentTextBlock, parsed: TextDocumentInlineText): void {
  if (parsed.title == "") { return; }

  const separator = block.title == "" ? "" : " ";
  const offset = block.title.length + separator.length;
  block.title += `${separator}${parsed.title}`;
  block.inlineMarks = normalizeNoteInlineMarks([
    ...block.inlineMarks,
    ...parsed.inlineMarks.map(mark => ({
      start: mark.start + offset,
      end: mark.end + offset,
      flags: mark.flags,
    })),
  ], block.title);
  block.urls = normalizeNoteUrls([
    ...block.urls,
    ...parsed.urls.map(url => ({
      start: url.start + offset,
      end: url.end + offset,
      url: url.url,
    })),
  ], block.title);
}

function lastMarkdownListTextBlock(blocks: Array<TextDocumentBlock>): TextDocumentTextBlock | null {
  const block = blocks[blocks.length - 1];
  if (block == null || block.kind != "paragraph" || !noteHasListStyle(block.noteFlags)) {
    return null;
  }
  return block;
}

function parseTextDocumentBlocks(text: string, parseMarkdown: boolean): Array<TextDocumentBlock> {
  const lines = linesWithOffsets(text);
  const blocks: Array<TextDocumentBlock> = [];
  let paragraphLines: Array<TextLine> = [];
  let listStack: Array<MarkdownListContainer> = [];

  const flushParagraph = () => {
    if (paragraphLines.length == 0) { return; }
    const parsed = parseMarkdown
      ? markdownInlineForParagraphLines(paragraphLines)
      : {
        title: paragraphLines.map(line => line.text.trim()).filter(line => line != "").join(" "),
        inlineMarks: [],
        urls: [],
      };
    if (parsed.title != "") {
      blocks.push({
        kind: "paragraph",
        title: parsed.title,
        inlineMarks: parsed.inlineMarks,
        urls: parsed.urls,
        headingLevel: null,
        noteFlags: NoteFlags.None,
        start: paragraphLines[0].start,
        end: paragraphLines[paragraphLines.length - 1].end,
        ordinal: blocks.length,
      });
    }
    paragraphLines = [];
  };

  for (let i = 0; i < lines.length; ++i) {
    const line = lines[i];

    const frontMatter = parseMarkdown ? parseMarkdownFrontMatterAt(lines, i) : null;
    if (frontMatter != null) {
      flushParagraph();
      listStack = [];
      frontMatter.block.ordinal = blocks.length;
      blocks.push(frontMatter.block);
      i = frontMatter.endIndex;
      continue;
    }

    if (line.text.trim() == "") {
      flushParagraph();
      continue;
    }

    const codeBlock = parseMarkdown ? parseMarkdownCodeBlockAt(lines, i) : null;
    if (codeBlock != null) {
      flushParagraph();
      listStack = [];
      codeBlock.block.ordinal = blocks.length;
      blocks.push(codeBlock.block);
      i = codeBlock.endIndex;
      continue;
    }

    const table = parseMarkdown ? parseMarkdownTableAt(lines, i) : null;
    if (table != null) {
      flushParagraph();
      listStack = [];
      table.ordinal = blocks.length;
      blocks.push(table);
      i += table.rows.length + 1;
      continue;
    }

    if (parseMarkdown && isMarkdownDividerLine(line.text)) {
      flushParagraph();
      listStack = [];
      blocks.push({
        kind: "divider",
        start: line.start,
        end: line.end,
        ordinal: blocks.length,
      });
      continue;
    }

    const listMarker = parseMarkdown ? markdownListMarkerInfo(line.text, listStack) : null;
    if (listMarker != null) {
      flushParagraph();
      const parsed = parseMarkdownInline(listMarker.title);
      const listFlag = listMarker.kind == "bullet" ? NoteFlags.Bullet1 : NoteFlags.Numbered;
      blocks.push({
        kind: "paragraph",
        title: parsed.title,
        inlineMarks: parsed.inlineMarks,
        urls: parsed.urls,
        headingLevel: null,
        noteFlags: noteFlagsWithIndentLevel(listFlag, listMarker.indentLevel),
        start: line.start,
        end: line.end,
        ordinal: blocks.length,
      });
      listStack = listStack.slice(0, listMarker.indentLevel);
      listStack[listMarker.indentLevel] = { bodyColumn: listMarker.bodyColumn };
      continue;
    }

    const listContinuation = parseMarkdown && paragraphLines.length == 0
      ? markdownListContinuationInfo(line.text, listStack)
      : null;
    const lastListBlock = listContinuation != null ? lastMarkdownListTextBlock(blocks) : null;
    if (
      listContinuation != null &&
      lastListBlock != null &&
      noteIndentLevelFromFlags(lastListBlock.noteFlags) == listContinuation.indentLevel
    ) {
      appendMarkdownInlineTextBlock(lastListBlock, parseMarkdownInline(listContinuation.title));
      lastListBlock.end = line.end;
      continue;
    }

    const heading = headingInfo(line.text);
    if (heading != null) {
      flushParagraph();
      listStack = [];
      const parsed = parseMarkdown
        ? parseMarkdownInline(heading.title)
        : { title: heading.title, inlineMarks: [], urls: [] };
      blocks.push({
        kind: "heading",
        title: parsed.title,
        inlineMarks: parsed.inlineMarks,
        urls: parsed.urls,
        headingLevel: heading.level,
        noteFlags: noteFlagsForHeadingLevel(heading.level),
        start: line.start,
        end: line.end,
        ordinal: blocks.length,
      });
      continue;
    }

    listStack = [];
    paragraphLines.push(line);
  }
  flushParagraph();

  return blocks;
}

function applyTextItemDocumentOptions(page: PageItem, textItem: TextItem): void {
  if (textItem.documentWidthBl != null) {
    page.docWidthBl = textItem.documentWidthBl;
  }
  if (textItem.documentShowTitle === true) {
    page.flags &= ~PageFlags.HideDocumentTitle;
  } else {
    page.flags |= PageFlags.HideDocumentTitle;
  }
}

function createTextDocumentPage(
  textItem: TextItem,
  virtual: boolean,
  overrides: {
    ownerId?: Uid,
    parentId?: Uid,
    relationshipToParent?: string,
    ordering?: Uint8Array,
  } = {},
): PageItem {
  const page = PageFns.create(
    overrides.ownerId ?? textItem.ownerId,
    overrides.parentId ?? textItem.parentId ?? EMPTY_UID,
    overrides.relationshipToParent ?? textItem.relationshipToParent,
    textItem.title,
    overrides.ordering ?? (virtual ? textItem.ordering : newOrdering()),
  );
  page.id = virtual
    ? stableUid(`text-document-page:${textItem.id}`)
    : page.id;
  page.capabilities = virtual ? readonlyCapabilities : null;
  page.arrangeAlgorithm = ArrangeAlgorithm.Document;
  page.childrenLoaded = true;
  page.orderChildrenBy = "";
  page.flags &= ~PageFlags.HideDocumentTitle;
  page.spatialPositionGr = textItem.spatialPositionGr;
  page.spatialWidthGr = textItem.spatialWidthGr;
  applyTextItemDocumentOptions(page, textItem);
  return page;
}

function createNoteForBlock(
  textItem: TextItem,
  ownerId: Uid,
  pageId: Uid,
  block: TextDocumentTextBlock,
  ordering: Uint8Array,
  virtual: boolean,
): NoteItem {
  const note = NoteFns.create(ownerId, pageId, RelationshipToParent.Child, block.title, ordering);
  note.inlineMarks = block.inlineMarks;
  note.urls = block.urls;
  if (virtual) {
    note.id = stableUid(`text-document-block:${textItem.id}:${block.kind}:${block.start}:${block.end}:${block.ordinal}`);
    note.capabilities = readonlyCopyableCapabilities;
  }
  note.flags = block.noteFlags;
  return note;
}

function createNoteForTableRow(
  textItem: TextItem,
  ownerId: Uid,
  tableId: Uid,
  block: TextDocumentTableBlock,
  row: TextDocumentTableRow,
  ordering: Uint8Array,
  virtual: boolean,
): NoteItem {
  const firstCell = row.cells[0] ?? { title: "", inlineMarks: [], urls: [] };
  const note = NoteFns.create(ownerId, tableId, RelationshipToParent.Child, firstCell.title, ordering);
  note.inlineMarks = firstCell.inlineMarks;
  note.urls = firstCell.urls;
  if (virtual) {
    note.id = stableUid(`text-document-table-row:${textItem.id}:${block.start}:${row.start}:${row.end}:${row.ordinal}`);
    note.capabilities = readonlyCopyableCapabilities;
  }
  return note;
}

function createNoteForTableCell(
  textItem: TextItem,
  ownerId: Uid,
  rowId: Uid,
  block: TextDocumentTableBlock,
  row: TextDocumentTableRow,
  cellIndex: number,
  cell: TextDocumentInlineText,
  ordering: Uint8Array,
  virtual: boolean,
): NoteItem {
  const note = NoteFns.create(ownerId, rowId, RelationshipToParent.Attachment, cell.title, ordering);
  note.inlineMarks = cell.inlineMarks;
  note.urls = cell.urls;
  if (virtual) {
    note.id = stableUid(`text-document-table-cell:${textItem.id}:${block.start}:${row.start}:${row.end}:${row.ordinal}:${cellIndex}`);
    note.capabilities = readonlyCopyableCapabilities;
  }
  return note;
}

function createDividerForBlock(
  textItem: TextItem,
  ownerId: Uid,
  pageId: Uid,
  pageWidthBl: number,
  block: TextDocumentDividerBlock,
  ordering: Uint8Array,
  virtual: boolean,
): Item {
  const divider = DividerFns.create(ownerId, pageId, RelationshipToParent.Child, ordering, "horizontal");
  if (virtual) {
    divider.id = stableUid(`text-document-divider:${textItem.id}:${block.start}:${block.end}:${block.ordinal}`);
    divider.capabilities = readonlyCopyableCapabilities;
  }
  divider.spatialWidthGr = Math.max(1, pageWidthBl) * GRID_SIZE;
  divider.spatialHeightGr = GRID_SIZE;
  return divider;
}

function createPlaceholderForTableCell(
  textItem: TextItem,
  ownerId: Uid,
  rowId: Uid,
  block: TextDocumentTableBlock,
  row: TextDocumentTableRow,
  cellIndex: number,
  ordering: Uint8Array,
  virtual: boolean,
): Item {
  const placeholder = PlaceholderFns.create(ownerId, rowId, RelationshipToParent.Attachment, ordering);
  if (virtual) {
    placeholder.id = stableUid(`text-document-table-cell-placeholder:${textItem.id}:${block.start}:${row.start}:${row.end}:${row.ordinal}:${cellIndex}`);
    placeholder.capabilities = readonlyCapabilities;
  }
  return placeholder;
}

function lastNonEmptyAttachmentCellIndex(row: TextDocumentTableRow): number {
  for (let i = row.cells.length - 1; i >= 1; --i) {
    if (row.cells[i].title.trim() != "") { return i; }
  }
  return 0;
}

function createTableForBlock(
  textItem: TextItem,
  ownerId: Uid,
  pageId: Uid,
  pageWidthBl: number,
  block: TextDocumentTableBlock,
  ordering: Uint8Array,
  virtual: boolean,
): Item {
  const table = TableFns.create(ownerId, pageId, RelationshipToParent.Child, "", ordering);
  if (virtual) {
    table.id = stableUid(`text-document-table:${textItem.id}:${block.start}:${block.end}:${block.ordinal}`);
    table.capabilities = readonlyCopyableCapabilities;
  }
  const tableWidthGr = Math.max(1, pageWidthBl) * GRID_SIZE;
  const columnWidthsGr = integerColumnWidthsGr(tableWidthGr, block.columns.length);
  table.tableColumns = block.columns.map((name, i) => ({ name, widthGr: columnWidthsGr[i] }));
  table.numberOfVisibleColumns = table.tableColumns.length;
  table.flags |= TableFlags.ShowColHeader | TableFlags.HideTitle;
  table.spatialWidthGr = tableWidthGr;
  table.spatialHeightGr = Math.max(3, Math.min(block.rows.length + 1, MAX_GENERATED_TABLE_HEIGHT_BL)) * GRID_SIZE;
  table.childrenLoaded = true;
  return table;
}

function createTextDocumentItems(
  textItem: TextItem,
  ownerId: Uid,
  page: PageItem,
  blocks: Array<TextDocumentBlock>,
  virtual: boolean,
): TextDocumentGeneratedItems {
  const result: TextDocumentGeneratedItems = {
    rootChildren: [],
    tableChildrenByTableId: {},
    attachmentsByParentId: {},
    allItems: [],
  };
  const rootOrderings: Array<Uint8Array> = [];
  for (const block of blocks) {
    const ordering = newOrderingAtEnd(rootOrderings);
    rootOrderings.push(ordering);

    if (block.kind == "divider") {
      const divider = createDividerForBlock(textItem, ownerId, page.id, page.docWidthBl, block, ordering, virtual);
      result.rootChildren.push(divider);
      result.allItems.push(divider);
      continue;
    }

    if (block.kind != "table") {
      const note = createNoteForBlock(textItem, ownerId, page.id, block, ordering, virtual);
      result.rootChildren.push(note);
      result.allItems.push(note);
      continue;
    }

    const table = createTableForBlock(textItem, ownerId, page.id, page.docWidthBl, block, ordering, virtual);
    result.rootChildren.push(table);
    result.allItems.push(table);

    const tableChildren: Array<Item> = [];
    result.tableChildrenByTableId[table.id] = tableChildren;
    const rowOrderings: Array<Uint8Array> = [];
    for (const row of block.rows) {
      const rowOrdering = newOrderingAtEnd(rowOrderings);
      rowOrderings.push(rowOrdering);
      const rowNote = createNoteForTableRow(textItem, ownerId, table.id, block, row, rowOrdering, virtual);
      tableChildren.push(rowNote);
      result.allItems.push(rowNote);

      const attachmentItems: Array<Item> = [];
      result.attachmentsByParentId[rowNote.id] = attachmentItems;
      const attachmentOrderings: Array<Uint8Array> = [];
      const lastCellIndex = lastNonEmptyAttachmentCellIndex(row);
      for (let cellIndex = 1; cellIndex <= lastCellIndex; ++cellIndex) {
        const attachmentOrdering = newOrderingAtEnd(attachmentOrderings);
        attachmentOrderings.push(attachmentOrdering);
        const cell = row.cells[cellIndex] ?? { title: "", inlineMarks: [], urls: [] };
        const attachment = cell.title.trim() == ""
          ? createPlaceholderForTableCell(textItem, ownerId, rowNote.id, block, row, cellIndex, attachmentOrdering, virtual)
          : createNoteForTableCell(textItem, ownerId, rowNote.id, block, row, cellIndex, cell, attachmentOrdering, virtual);
        attachmentItems.push(attachment);
        result.allItems.push(attachment);
      }
    }
  }
  return result;
}

function toVirtualServerObject(item: Item): object {
  const result = ItemFns.toObject(item) as any;
  if (item.capabilities != null) {
    result.capabilities = item.capabilities;
  }
  return result;
}

function toVirtualServerObjects(items: Array<Item>): Array<object> {
  return items.map(toVirtualServerObject);
}

function toVirtualServerObjectMap(itemsByParentId: { [id: string]: Array<Item> }): { [id: string]: Array<object> } {
  const result: { [id: string]: Array<object> } = {};
  for (const parentId of Object.keys(itemsByParentId)) {
    result[parentId] = toVirtualServerObjects(itemsByParentId[parentId]);
  }
  return result;
}

function upsertVirtualProjection(textItem: TextItem, blocks: Array<TextDocumentBlock>): PageItem {
  const page = createTextDocumentPage(textItem, true);
  const storedPage = asPageItem(itemState.upsertItemFromServerObject(toVirtualServerObject(page), null));
  storedPage.childrenLoaded = true;
  storedPage.computed_children = [];
  storedPage.computed_attachments = [];
  storedPage.capabilities = readonlyCapabilities;
  virtualSourceTextIdByPageId.set(storedPage.id, textItem.id);

  const generated = createTextDocumentItems(textItem, textItem.ownerId, storedPage, blocks, true);
  const attachmentServerObjectsByParentId = toVirtualServerObjectMap(generated.attachmentsByParentId);
  itemState.applyContainerSnapshotFromServerObjects(storedPage.id, toVirtualServerObjects(generated.rootChildren), {}, null);
  for (const tableId of Object.keys(generated.tableChildrenByTableId)) {
    itemState.applyContainerSnapshotFromServerObjects(
      tableId,
      toVirtualServerObjects(generated.tableChildrenByTableId[tableId]),
      attachmentServerObjectsByParentId,
      null,
    );
    const table = itemState.getAsContainerItem(tableId);
    if (table != null) {
      table.childrenLoaded = true;
    }
  }
  storedPage.childrenLoaded = true;
  return storedPage;
}

export function createPendingTextDocumentPage(
  textItem: TextItem,
  ownerId: Uid,
  parentId: Uid,
  ordering: Uint8Array,
): PageItem {
  const page = createTextDocumentPage(textItem, false, {
    ownerId,
    parentId,
    relationshipToParent: RelationshipToParent.Child,
    ordering,
  });
  page.title = titleWithCopySuffix(page.title);
  page.capabilities = null;
  page.childrenLoaded = true;
  page.computed_children = [];
  page.computed_attachments = [];
  return page;
}

export async function createMaterializedTextDocumentItems(textItem: TextItem, page: PageItem): Promise<Array<Item>> {
  const text = await fetchTextItemContent(textItem);
  const blocks = parseTextDocumentBlocks(text, isMarkdownTextItem(textItem));
  return createTextDocumentItems(textItem, page.ownerId, page, blocks, false).allItems;
}

export function isVirtualTextDocumentPage(pageId: Uid): boolean {
  return virtualSourceTextIdByPageId.has(pageId);
}

export function sourceTextItemForVirtualTextDocumentPage(pageId: Uid): TextItem | null {
  const sourceTextId = virtualSourceTextIdByPageId.get(pageId);
  if (sourceTextId == null) { return null; }
  const source = itemState.get(sourceTextId);
  if (source == null || source.itemType != ItemType.Text) { return null; }
  return source as TextItem;
}

export function openTextItemFileInNewTab(store: StoreContextModel, textItem: TextItem): void {
  if (textItem.origin == null) {
    window.open('/files/' + textItem.id, '_blank', 'noopener');
    return;
  }
  void openRemoteFileInNewTab(textItem.origin, textItem.id)
    .catch((e) => {
      console.error(`Could not open remote text file '${textItem.id}' from '${textItem.origin}':`, e);
      setTransientMessage(store, "could not open text file", TransientMessageType.Error);
    });
}

export function persistVirtualTextDocumentPageOptions(store: StoreContextModel, page: PageItem): void {
  const source = sourceTextItemForVirtualTextDocumentPage(page.id);
  if (source == null) { return; }
  source.documentWidthBl = page.docWidthBl;
  source.documentShowTitle = !(page.flags & PageFlags.HideDocumentTitle);
  void serverOrRemote.updateItem(source, store.general.networkStatus)
    .catch((e) => {
      console.error("Failed to persist text document page options:", e);
      setTransientMessage(store, "could not save text document settings", TransientMessageType.Error);
    });
}

export async function openTextDocumentProjection(store: StoreContextModel, textItem: TextItem): Promise<void> {
  try {
    const text = await fetchTextItemContent(textItem);
    const page = upsertVirtualProjection(textItem, parseTextDocumentBlocks(text, isMarkdownTextItem(textItem)));
    const pageVeid = { itemId: page.id, linkIdMaybe: null };
    if (store.history.currentPageVeid()?.itemId != page.id) {
      pushTextDocumentUrlIfNeeded(store, textItem);
      store.history.pushPageVeid(pageVeid);
    } else {
      pushTextDocumentUrlIfNeeded(store, textItem);
      store.history.setFocus(store.history.currentPagePath()!);
    }
    store.overlay.setTextEditInfo(store.history, null, true);
    arrangeNow(store, "text-document-open");
  } catch (e) {
    console.error("Failed to open text document projection:", e);
    setTransientMessage(store, "could not open text document", TransientMessageType.Error);
  }
}

export async function materializeTextDocumentPage(store: StoreContextModel, textItem: TextItem): Promise<Uid | null> {
  const ordering = textItem.relationshipToParent == RelationshipToParent.Child
    ? itemState.newOrderingDirectlyAfterChild(textItem.parentId, textItem.id)
    : textItem.relationshipToParent == RelationshipToParent.Attachment
      ? itemState.newOrderingAtEndOfAttachments(textItem.parentId)
      : newOrdering();
  const page = createTextDocumentPage(textItem, false);
  page.relationshipToParent = textItem.relationshipToParent;
  page.parentId = textItem.parentId;
  page.ordering = ordering;
  page.capabilities = null;

  itemState.add(page);
  const generatedItems = await createMaterializedTextDocumentItems(textItem, page);
  for (const item of generatedItems) {
    itemState.add(item);
  }
  requestArrange(store, "text-document-materialize-local");

  try {
    await server.addItem(page, null, store.general.networkStatus);
    for (const item of generatedItems) {
      await server.addItem(item, null, store.general.networkStatus);
    }
    requestArrange(store, "text-document-materialize-complete");
    return page.id;
  } catch (e) {
    console.error("Failed to materialize text document:", e);
    for (const item of generatedItems.reverse()) {
      itemState.delete(item.id);
    }
    itemState.delete(page.id);
    requestArrange(store, "text-document-materialize-rollback");
    throw e;
  }
}

export async function materializeTextDocumentPageAndOpen(store: StoreContextModel, textItem: TextItem): Promise<Uid | null> {
  try {
    const pageId = await materializeTextDocumentPage(store, textItem);
    if (pageId != null && isPage(itemState.get(pageId))) {
      switchToPage(store, { itemId: pageId, linkIdMaybe: null }, true, false, false);
      setTransientMessage(store, "document page created", TransientMessageType.Info);
    }
    return pageId;
  } catch (e) {
    console.error("Failed to create document page from text item:", e);
    setTransientMessage(store, "could not create document page", TransientMessageType.Error);
    return null;
  }
}

export async function materializeVirtualTextDocumentPage(store: StoreContextModel, virtualPageId: Uid): Promise<Uid | null> {
  const virtualPage = itemState.get(virtualPageId);
  if (virtualPage != null && isPage(virtualPage)) {
    persistVirtualTextDocumentPageOptions(store, asPageItem(virtualPage));
  }
  const source = sourceTextItemForVirtualTextDocumentPage(virtualPageId);
  if (source == null) { return null; }
  return materializeTextDocumentPageAndOpen(store, source);
}
