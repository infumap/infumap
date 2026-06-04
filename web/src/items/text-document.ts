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
import { PageFlags, NoteFlags, TableFlags } from "./base/flags-item";
import { Item, ItemType } from "./base/item";
import { PlaceholderFns } from "./placeholder-item";
import { NoteFns, NoteItem } from "./note-item";
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

type TextDocumentTextBlock = {
  kind: "paragraph" | "heading",
  title: string,
  headingLevel: number | null,
  start: number,
  end: number,
  ordinal: number,
};

type TextDocumentTableRow = {
  cells: Array<string>,
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

type TextDocumentBlock = TextDocumentTextBlock | TextDocumentTableBlock;

type TextLine = {
  text: string,
  start: number,
  end: number,
  nextStart: number,
};

type TextDocumentGeneratedItems = {
  rootChildren: Array<Item>,
  tableChildrenByTableId: { [id: string]: Array<Item> },
  attachmentsByParentId: { [id: string]: Array<Item> },
  allItems: Array<Item>,
};

const readonlyCapabilities = { edit: false, move: false };
const virtualSourceTextIdByPageId = new Map<Uid, Uid>();
const textContentPromises = new Map<string, Promise<string>>();
const MAX_GENERATED_TABLE_HEIGHT_BL = 12;

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

function noteFlagsForHeadingLevel(level: number | null): NoteFlags {
  if (level == 1) { return NoteFlags.Heading1; }
  if (level == 2) { return NoteFlags.Heading2; }
  if (level == 3) { return NoteFlags.Heading3; }
  if (level != null && level >= 4) { return NoteFlags.Heading4; }
  return NoteFlags.None;
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
      cells: normalizeMarkdownTableCells(rowCells, columnCount),
      start: lines[rowIndex].start,
      end: lines[rowIndex].end,
      ordinal: rows.length,
    });
    end = lines[rowIndex].end;
    rowIndex += 1;
  }

  return {
    kind: "table",
    columns: normalizeMarkdownTableCells(headerCells, columnCount),
    rows,
    start: lines[index].start,
    end,
    ordinal: 0,
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

function parseTextDocumentBlocks(text: string, parseMarkdownTables: boolean): Array<TextDocumentBlock> {
  const lines = linesWithOffsets(text);
  const blocks: Array<TextDocumentBlock> = [];
  let paragraphLines: Array<TextLine> = [];

  const flushParagraph = () => {
    if (paragraphLines.length == 0) { return; }
    const title = paragraphLines.map(line => line.text.trim()).filter(line => line != "").join(" ");
    if (title != "") {
      blocks.push({
        kind: "paragraph",
        title,
        headingLevel: null,
        start: paragraphLines[0].start,
        end: paragraphLines[paragraphLines.length - 1].end,
        ordinal: blocks.length,
      });
    }
    paragraphLines = [];
  };

  for (let i = 0; i < lines.length; ++i) {
    const line = lines[i];
    if (line.text.trim() == "") {
      flushParagraph();
      continue;
    }

    const table = parseMarkdownTables ? parseMarkdownTableAt(lines, i) : null;
    if (table != null) {
      flushParagraph();
      table.ordinal = blocks.length;
      blocks.push(table);
      i += table.rows.length + 1;
      continue;
    }

    const heading = headingInfo(line.text);
    if (heading != null) {
      flushParagraph();
      blocks.push({
        kind: "heading",
        title: heading.title,
        headingLevel: heading.level,
        start: line.start,
        end: line.end,
        ordinal: blocks.length,
      });
      continue;
    }

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
  if (virtual) {
    note.id = stableUid(`text-document-block:${textItem.id}:${block.kind}:${block.start}:${block.end}:${block.ordinal}`);
    note.capabilities = readonlyCapabilities;
  }
  note.flags = noteFlagsForHeadingLevel(block.headingLevel);
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
  const note = NoteFns.create(ownerId, tableId, RelationshipToParent.Child, row.cells[0] ?? "", ordering);
  if (virtual) {
    note.id = stableUid(`text-document-table-row:${textItem.id}:${block.start}:${row.start}:${row.end}:${row.ordinal}`);
    note.capabilities = readonlyCapabilities;
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
  title: string,
  ordering: Uint8Array,
  virtual: boolean,
): NoteItem {
  const note = NoteFns.create(ownerId, rowId, RelationshipToParent.Attachment, title, ordering);
  if (virtual) {
    note.id = stableUid(`text-document-table-cell:${textItem.id}:${block.start}:${row.start}:${row.end}:${row.ordinal}:${cellIndex}`);
    note.capabilities = readonlyCapabilities;
  }
  return note;
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
    if (row.cells[i].trim() != "") { return i; }
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
    table.capabilities = readonlyCapabilities;
  }
  const tableWidthGr = Math.max(1, pageWidthBl) * GRID_SIZE;
  const columnWidthGr = tableWidthGr / block.columns.length;
  table.tableColumns = block.columns.map(name => ({ name, widthGr: columnWidthGr }));
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
        const cellText = row.cells[cellIndex] ?? "";
        const attachment = cellText.trim() == ""
          ? createPlaceholderForTableCell(textItem, ownerId, rowNote.id, block, row, cellIndex, attachmentOrdering, virtual)
          : createNoteForTableCell(textItem, ownerId, rowNote.id, block, row, cellIndex, cellText, attachmentOrdering, virtual);
        attachmentItems.push(attachment);
        result.allItems.push(attachment);
      }
    }
  }
  return result;
}

function upsertVirtualProjection(textItem: TextItem, blocks: Array<TextDocumentBlock>): PageItem {
  const page = createTextDocumentPage(textItem, true);
  const storedPage = asPageItem(itemState.upsertItemFromServerObject(page, null));
  storedPage.childrenLoaded = true;
  storedPage.computed_children = [];
  storedPage.computed_attachments = [];
  storedPage.capabilities = readonlyCapabilities;
  virtualSourceTextIdByPageId.set(storedPage.id, textItem.id);

  const generated = createTextDocumentItems(textItem, textItem.ownerId, storedPage, blocks, true);
  itemState.applyContainerSnapshotFromServerObjects(storedPage.id, generated.rootChildren, {}, null);
  for (const tableId of Object.keys(generated.tableChildrenByTableId)) {
    itemState.applyContainerSnapshotFromServerObjects(
      tableId,
      generated.tableChildrenByTableId[tableId],
      generated.attachmentsByParentId,
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
