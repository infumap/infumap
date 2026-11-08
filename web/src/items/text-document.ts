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
import { PageFlags, TableFlags, CompositeFlags } from "./base/flags-item";
import { asAttachmentsItem, isAttachmentsItem } from "./base/attachments-item";
import { asContainerItem, isContainer } from "./base/container-item";
import { CompositeFns, isComposite, asCompositeItem } from "./composite-item";
import { queryChatOutcomeText } from "./chat";
import { markChildrenLoadAsInitiatedOrComplete } from "../layout/load";
import { Item, ItemType } from "./base/item";
import { ItemFns } from "./base/item-polymorphism";
import { titleWithCopySuffix } from "./base/titled-item";
import { PlaceholderFns } from "./placeholder-item";
import { ItemIconMode, NoteFns, NoteItem } from "./note-item";
import {
  parseTextDocumentBlocks,
  type TextDocumentBlock,
  type TextDocumentDividerBlock,
  type TextDocumentInlineText,
  type TextDocumentLinkIconHint,
  type TextDocumentTableBlock,
  type TextDocumentTableRow,
  type TextDocumentTextBlock,
} from "./markdown-blocks";
import { DividerFns } from "./divider-item";
import { ArrangeAlgorithm, DEFAULT_DOCUMENT_WIDTH_BL, PageFns, PageItem, asPageItem, isPage } from "./page-item";
import { TableFns, TableItem } from "./table-item";
import { TableColumn } from "./base/tabular-item";
import { asTextItem, isText, type ChatAttachmentSource, type TextItem } from "./text-item";
import { createChatAttachmentItem } from "./chat-attachment";
import { base64ArrayBuffer } from "../util/base64ArrayBuffer";
import { itemState } from "../store/ItemState";
import { StoreContextModel } from "../store/StoreProvider";
import { TransientMessageType } from "../store/StoreProvider_Overlay";
import { server, serverOrRemote, type LoadChatResponse } from "../server";
import { newOrdering, newOrderingAtEnd } from "../util/ordering";
import { EMPTY_UID, Uid, newUid } from "../util/uid";
import { fetchRemoteFileText, openRemoteFileInNewTab } from "../util/remoteFile";

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
const MARKDOWN_DOCUMENT_PAGE_COLOR_INDEX = 6;
const MIN_GENERATED_TABLE_COLUMN_WIDTH_BL = 3;
const GENERATED_TABLE_TEXT_SCORE_CAP = 120;
const GENERATED_TABLE_LONG_WORD_SCORE_CAP = 40;
const MARKDOWN_LINK_ICON_EMOJI = "\u{1f517}";

function integerColumnWidthsGr(totalWidthGr: number, columnCount: number): Array<number> {
  const safeColumnCount = Math.max(1, columnCount);
  const integerTotalWidthGr = Math.max(1, Math.round(totalWidthGr));
  const baseWidthGr = Math.floor(integerTotalWidthGr / safeColumnCount);
  const remainderGr = integerTotalWidthGr - baseWidthGr * safeColumnCount;
  return Array.from({ length: safeColumnCount }, (_, i) => baseWidthGr + (i < remainderGr ? 1 : 0));
}

function weightedIntegerColumnWidthsGr(totalWidthGr: number, weights: Array<number>, minWidthGr: number): Array<number> {
  if (weights.length == 0) { return []; }

  const integerTotalWidthGr = Math.max(1, Math.round(totalWidthGr));
  const safeWeights = weights.map(w => Number.isFinite(w) && w > 0 ? w : 1);
  const totalWeight = safeWeights.reduce((sum, w) => sum + w, 0);
  if (totalWeight <= 0) { return integerColumnWidthsGr(integerTotalWidthGr, weights.length); }

  const integerMinWidthGr = Math.max(0, Math.round(minWidthGr));
  const effectiveMinWidthGr = Math.min(integerMinWidthGr, Math.floor(integerTotalWidthGr / weights.length));
  const remainingWidthGr = integerTotalWidthGr - effectiveMinWidthGr * weights.length;
  const exactWidthsGr = safeWeights.map(w => effectiveMinWidthGr + remainingWidthGr * w / totalWeight);
  const integerWidthsGr = exactWidthsGr.map(Math.floor);
  const remainderGr = integerTotalWidthGr - integerWidthsGr.reduce((sum, w) => sum + w, 0);
  const fractionalOrder = exactWidthsGr
    .map((widthGr, i) => ({ i, fraction: widthGr - Math.floor(widthGr) }))
    .sort((a, b) => b.fraction - a.fraction || a.i - b.i);
  for (let i = 0; i < remainderGr; ++i) {
    integerWidthsGr[fractionalOrder[i % fractionalOrder.length].i] += 1;
  }

  return integerWidthsGr;
}

function setTransientMessage(store: StoreContextModel, text: string, type: TransientMessageType): void {
  store.overlay.toolbarTransientMessage.set({ text, type });
  setTimeout(() => { store.overlay.toolbarTransientMessage.set(null); }, 1500);
}

function markClientOnly(item: Item): void {
  item.clientOnly = true;
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
  if (textItem.chatAttachmentSource != null) {
    return chatAttachmentSourceKey(textItem.chatAttachmentSource);
  }
  return `${textItem.origin ?? ""}|${textItem.id}`;
}

/** Keyed by the attachment, not the item, so items showing the same attachment share its text. */
function chatAttachmentSourceKey(source: ChatAttachmentSource): string {
  const chatId = "queryItemId" in source.chat ? source.chat.queryItemId : source.chat.chatItemId;
  return `chat-attachment|${chatId}|${source.attachmentId}`;
}

export function textDocumentUrl(textItem: TextItem): string {
  if (textItem.origin == null) {
    return `/${textItem.id}`;
  }
  return `/remote/${encodeURIComponent(textItem.origin)}/${textItem.id}`;
}

async function fetchLocalFileText(itemId: string): Promise<string> {
  const response = await fetch(`/files/${itemId}`, { method: "GET" });
  if (!response.ok || response.status !== 200) {
    throw new Error(`Text file fetch failed: ${response.status}`);
  }
  return response.text();
}

export async function fetchTextItemContent(textItem: TextItem): Promise<string> {
  if (textItem.clientText != null) { return textItem.clientText; }
  const key = sourceKey(textItem);
  const existing = textContentPromises.get(key);
  if (existing) { return existing; }

  const attachment = textItem.chatAttachmentSource;
  const promise = (attachment != null
    ? server.loadChatAttachment(attachment.chat, attachment.attachmentId)
    : textItem.origin == null
      ? fetchLocalFileText(textItem.id)
      : fetchRemoteFileText(textItem.origin, textItem.id))
    .catch((e) => {
      textContentPromises.delete(key);
      throw e;
    });
  textContentPromises.set(key, promise);
  return promise;
}

/** Makes a chat attachment's text available before the server has it, as for a message just sent. */
export function seedChatAttachmentContent(source: ChatAttachmentSource, text: string): void {
  textContentPromises.set(chatAttachmentSourceKey(source), Promise.resolve(text));
}

/**
 * The base64 content to add an item with, if it is a text item whose text is only in the client: a copy of a chat
 * attachment, or an item with `clientText`. It becomes an ordinary text item with its own content; otherwise null. The
 * copy no longer refers to the chat afterwards.
 */
export async function clientTextCopyData(item: Item): Promise<string | null> {
  if (!isText(item)) { return null; }
  const textItem = asTextItem(item);
  if (textItem.chatAttachmentSource == null && textItem.clientText == null) { return null; }
  const text = await fetchTextItemContent(textItem);
  delete textItem.chatAttachmentSource;
  delete textItem.clientText;
  // Copied, because base64ArrayBuffer encodes the whole buffer.
  return base64ArrayBuffer(new TextEncoder().encode(text).slice().buffer);
}

/** The MIME type of a persisted chat, set by the server when a chat is moved out of the Queries page. */
export const CHAT_TRANSCRIPT_MIME_TYPE = "application/x-infumap-chat";

/** A persisted chat: its content is a chat transcript, shown as the chat it was, not as text. */
export function isChatTextItem(textItem: TextItem): boolean {
  return textItem.mimeType == CHAT_TRANSCRIPT_MIME_TYPE;
}

export function isMarkdownTextItem(textItem: TextItem): boolean {
  const mimeType = (textItem.mimeType ?? "").toLowerCase();
  const title = textItem.title.toLowerCase();
  return mimeType == "text/markdown" ||
    title.endsWith(".md") ||
    title.endsWith(".markdown");
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
  if (virtual) {
    markClientOnly(page);
    page.capabilities = readonlyCapabilities;
    if (isMarkdownTextItem(textItem) || isChatTextItem(textItem)) { page.backgroundColorIndex = MARKDOWN_DOCUMENT_PAGE_COLOR_INDEX; }
  } else {
    page.capabilities = null;
  }
  page.arrangeAlgorithm = ArrangeAlgorithm.Document;
  page.childrenLoaded = true;
  page.orderChildrenBy = "";
  page.flags &= ~PageFlags.HideDocumentTitle;
  page.spatialPositionGr = textItem.spatialPositionGr;
  page.spatialWidthGr = textItem.spatialWidthGr;
  applyTextItemDocumentOptions(page, textItem);
  return page;
}

function applyMarkdownLinkIconHint(
  note: NoteItem,
  text: { linkIconHints: Array<TextDocumentLinkIconHint> },
): void {
  if (!text.linkIconHints.some(hint => hint.start == 0 && hint.start < hint.end)) { return; }
  note.emoji = MARKDOWN_LINK_ICON_EMOJI;
  note.iconMode = ItemIconMode.Symbol;
}

function createNoteForBlock(
  virtualSource: TextItem | null,
  ownerId: Uid,
  pageId: Uid,
  block: TextDocumentTextBlock,
  ordering: Uint8Array,
): NoteItem {
  const note = NoteFns.create(ownerId, pageId, RelationshipToParent.Child, block.title, ordering);
  note.inlineMarks = block.inlineMarks;
  note.urls = block.urls;
  applyMarkdownLinkIconHint(note, block);
  if (virtualSource != null) {
    markClientOnly(note);
    note.id = stableUid(`text-document-block:${virtualSource.id}:${block.kind}:${block.start}:${block.end}:${block.ordinal}`);
    note.capabilities = readonlyCopyableCapabilities;
  }
  note.flags = block.noteFlags;
  return note;
}

function tableColumnForBlock(block: TextDocumentTableBlock, index: number, widthGr: number): TableColumn {
  const column: TableColumn = { name: block.columns[index], widthGr };
  const alignment = block.alignments[index];
  if (alignment == "center" || alignment == "right") { column.align = alignment; }
  return column;
}

function createNoteForTableRow(
  virtualSource: TextItem | null,
  ownerId: Uid,
  tableId: Uid,
  block: TextDocumentTableBlock,
  row: TextDocumentTableRow,
  ordering: Uint8Array,
): NoteItem {
  const firstCell = row.cells[0] ?? { title: "", inlineMarks: [], urls: [], linkIconHints: [] };
  const note = NoteFns.create(ownerId, tableId, RelationshipToParent.Child, firstCell.title, ordering);
  note.inlineMarks = firstCell.inlineMarks;
  note.urls = firstCell.urls;
  applyMarkdownLinkIconHint(note, firstCell);
  if (virtualSource != null) {
    markClientOnly(note);
    note.id = stableUid(`text-document-table-row:${virtualSource.id}:${block.start}:${row.start}:${row.end}:${row.ordinal}`);
    note.capabilities = readonlyCopyableCapabilities;
  }
  return note;
}

function createNoteForTableCell(
  virtualSource: TextItem | null,
  ownerId: Uid,
  rowId: Uid,
  block: TextDocumentTableBlock,
  row: TextDocumentTableRow,
  cellIndex: number,
  cell: TextDocumentInlineText,
  ordering: Uint8Array,
): NoteItem {
  const note = NoteFns.create(ownerId, rowId, RelationshipToParent.Attachment, cell.title, ordering);
  note.inlineMarks = cell.inlineMarks;
  note.urls = cell.urls;
  applyMarkdownLinkIconHint(note, cell);
  if (virtualSource != null) {
    markClientOnly(note);
    note.id = stableUid(`text-document-table-cell:${virtualSource.id}:${block.start}:${row.start}:${row.end}:${row.ordinal}:${cellIndex}`);
    note.capabilities = readonlyCopyableCapabilities;
  }
  return note;
}

function createDividerForBlock(
  virtualSource: TextItem | null,
  ownerId: Uid,
  pageId: Uid,
  pageWidthBl: number,
  block: TextDocumentDividerBlock,
  ordering: Uint8Array,
): Item {
  const divider = DividerFns.create(ownerId, pageId, RelationshipToParent.Child, ordering, "horizontal");
  if (virtualSource != null) {
    markClientOnly(divider);
    divider.id = stableUid(`text-document-divider:${virtualSource.id}:${block.start}:${block.end}:${block.ordinal}`);
    divider.capabilities = readonlyCopyableCapabilities;
  }
  divider.spatialWidthGr = Math.max(1, pageWidthBl) * GRID_SIZE;
  divider.spatialHeightGr = GRID_SIZE;
  return divider;
}

function createPlaceholderForTableCell(
  virtualSource: TextItem | null,
  ownerId: Uid,
  rowId: Uid,
  block: TextDocumentTableBlock,
  row: TextDocumentTableRow,
  cellIndex: number,
  ordering: Uint8Array,
): Item {
  const placeholder = PlaceholderFns.create(ownerId, rowId, RelationshipToParent.Attachment, ordering);
  if (virtualSource != null) {
    markClientOnly(placeholder);
    placeholder.id = stableUid(`text-document-table-cell-placeholder:${virtualSource.id}:${block.start}:${row.start}:${row.end}:${row.ordinal}:${cellIndex}`);
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

function generatedTableWidthGr(documentWidthBl: number): number {
  const widthBl = Number.isFinite(documentWidthBl)
    ? Math.max(1, documentWidthBl)
    : DEFAULT_DOCUMENT_WIDTH_BL;
  return Math.max(1, Math.round(widthBl * GRID_SIZE));
}

function tableCellTextWidthScore(text: string): number {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized == "") { return 0; }

  const longestWordLength = normalized
    .split(/\s+/g)
    .reduce((longest, word) => Math.max(longest, word.length), 0);
  const cappedTextLength = Math.min(normalized.length, GENERATED_TABLE_TEXT_SCORE_CAP);
  const cappedLongestWordLength = Math.min(longestWordLength, GENERATED_TABLE_LONG_WORD_SCORE_CAP);
  return cappedTextLength * 0.7 + cappedLongestWordLength * 1.3;
}

function tableColumnTextWeight(block: TextDocumentTableBlock, columnIndex: number): number {
  const scores = [tableCellTextWidthScore(block.columns[columnIndex] ?? "")];
  for (const row of block.rows) {
    scores.push(tableCellTextWidthScore(row.cells[columnIndex]?.title ?? ""));
  }

  const nonEmptyScores = scores.filter(score => score > 0);
  if (nonEmptyScores.length == 0) { return 1; }

  const maxScore = Math.max(...nonEmptyScores);
  const averageScore = nonEmptyScores.reduce((sum, score) => sum + score, 0) / nonEmptyScores.length;
  return Math.pow(maxScore * 0.75 + averageScore * 0.25, 0.8);
}

function generatedTableColumnWidthsGr(totalWidthGr: number, block: TextDocumentTableBlock): Array<number> {
  const weights = block.columns.map((_, i) => tableColumnTextWeight(block, i));
  return weightedIntegerColumnWidthsGr(
    totalWidthGr,
    weights,
    MIN_GENERATED_TABLE_COLUMN_WIDTH_BL * GRID_SIZE,
  );
}

function createTableForBlock(
  virtualSource: TextItem | null,
  ownerId: Uid,
  parentId: Uid,
  tableWidthGr: number,
  block: TextDocumentTableBlock,
  ordering: Uint8Array,
): TableItem {
  const table = TableFns.create(ownerId, parentId, RelationshipToParent.Child, "", ordering);
  if (virtualSource != null) {
    markClientOnly(table);
    table.id = stableUid(`text-document-table:${virtualSource.id}:${block.start}:${block.end}:${block.ordinal}`);
    table.capabilities = readonlyCopyableCapabilities;
  }
  const columnWidthsGr = generatedTableColumnWidthsGr(tableWidthGr, block);
  table.tableColumns = block.columns.map((_, i) => tableColumnForBlock(block, i, columnWidthsGr[i]));
  table.numberOfVisibleColumns = table.tableColumns.length;
  table.flags |= TableFlags.ShowColHeader | TableFlags.HideTitle | TableFlags.WrapRows;
  table.spatialWidthGr = tableWidthGr;
  // Sized to its rows once they are created (TableFns.fitGeneratedTableHeight).
  table.childrenLoaded = true;
  return table;
}

/** A table for a markdown table block: a row note per row, with the cells after the first as its attachments. */
function createTableItemsForBlock(
  virtualSource: TextItem | null,
  ownerId: Uid,
  parentId: Uid,
  tableWidthGr: number,
  block: TextDocumentTableBlock,
  ordering: Uint8Array,
): { table: TableItem, rows: Array<{ item: Item, attachments: Array<Item> }> } {
  const table = createTableForBlock(virtualSource, ownerId, parentId, tableWidthGr, block, ordering);
  const rows: Array<{ item: Item, attachments: Array<Item> }> = [];
  const rowOrderings: Array<Uint8Array> = [];
  for (const row of block.rows) {
    const rowOrdering = newOrderingAtEnd(rowOrderings);
    rowOrderings.push(rowOrdering);
    const rowNote = createNoteForTableRow(virtualSource, ownerId, table.id, block, row, rowOrdering);

    const attachments: Array<Item> = [];
    const attachmentOrderings: Array<Uint8Array> = [];
    const lastCellIndex = lastNonEmptyAttachmentCellIndex(row);
    for (let cellIndex = 1; cellIndex <= lastCellIndex; ++cellIndex) {
      const attachmentOrdering = newOrderingAtEnd(attachmentOrderings);
      attachmentOrderings.push(attachmentOrdering);
      const cell = row.cells[cellIndex] ?? { title: "", inlineMarks: [], urls: [], linkIconHints: [] };
      attachments.push(cell.title.trim() == ""
        ? createPlaceholderForTableCell(virtualSource, ownerId, rowNote.id, block, row, cellIndex, attachmentOrdering)
        : createNoteForTableCell(virtualSource, ownerId, rowNote.id, block, row, cellIndex, cell, attachmentOrdering));
    }
    rows.push({ item: rowNote, attachments });
  }
  TableFns.fitGeneratedTableHeight(table, rows);
  return { table, rows };
}

/**
 * The items of a new table for a markdown table block, tableWidthGr wide and as tall as its rows, up to a limit. The
 * table comes first, and each row before its attachments.
 */
export function createMarkdownTableItems(
  ownerId: Uid,
  parentId: Uid,
  tableWidthGr: number,
  block: TextDocumentTableBlock,
  ordering: Uint8Array,
): Array<Item> {
  const { table, rows } = createTableItemsForBlock(null, ownerId, parentId, tableWidthGr, block, ordering);
  return [table, ...rows.flatMap(row => [row.item, ...row.attachments])];
}

function createTextDocumentItems(
  virtualSource: TextItem | null,
  ownerId: Uid,
  page: PageItem,
  blocks: Array<TextDocumentBlock>,
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
      const divider = createDividerForBlock(virtualSource, ownerId, page.id, page.docWidthBl, block, ordering);
      result.rootChildren.push(divider);
      result.allItems.push(divider);
      continue;
    }

    if (block.kind != "table") {
      const note = createNoteForBlock(virtualSource, ownerId, page.id, block, ordering);
      result.rootChildren.push(note);
      result.allItems.push(note);
      continue;
    }

    const { table, rows } = createTableItemsForBlock(
      virtualSource, ownerId, page.id, generatedTableWidthGr(page.docWidthBl), block, ordering);
    result.rootChildren.push(table);
    result.allItems.push(table);
    result.tableChildrenByTableId[table.id] = rows.map(row => row.item);
    for (const row of rows) {
      result.allItems.push(row.item, ...row.attachments);
      result.attachmentsByParentId[row.item.id] = row.attachments;
    }
  }
  return result;
}

function toVirtualServerObject(item: Item): object {
  const result = ItemFns.toObject(item) as any;
  if (item.clientOnly === true) {
    result.clientOnly = true;
  }
  if (isText(item) && asTextItem(item).chatAttachmentSource != null) {
    result.chatAttachmentSource = asTextItem(item).chatAttachmentSource;
  }
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

function upsertVirtualPageShell(textItem: TextItem): PageItem {
  const page = createTextDocumentPage(textItem, true);
  const storedPage = asPageItem(itemState.upsertItemFromServerObject(toVirtualServerObject(page), null));
  storedPage.childrenLoaded = true;
  storedPage.computed_children = [];
  storedPage.computed_attachments = [];
  storedPage.capabilities = readonlyCapabilities;
  virtualSourceTextIdByPageId.set(storedPage.id, textItem.id);
  return storedPage;
}

function upsertVirtualProjection(textItem: TextItem, blocks: Array<TextDocumentBlock>): PageItem {
  const storedPage = upsertVirtualPageShell(textItem);

  const generated = createTextDocumentItems(textItem, textItem.ownerId, storedPage, blocks);
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

interface ChatDocumentGeneratedItems {
  rootChildren: Array<Item>,
  childrenByParentId: { [id: string]: Array<Item> },
  attachmentsByParentId: { [id: string]: Array<Item> },
  /** Parents before their children and attachments. */
  allItems: Array<Item>,
}

/**
 * The items of a persisted chat's document page, laid out as the chat window shows a chat: per turn, a "You" composite
 * with the user's text, then the assistant's items, or a note saying how an unsuccessful turn ended. Text only: the
 * turn dropdowns are not shown. A virtual page's items have ids that are stable across loads, so a reload replaces
 * them rather than adding more.
 */
function createChatDocumentItems(
  textItem: TextItem,
  ownerId: Uid,
  page: PageItem,
  chat: LoadChatResponse,
  virtual: boolean,
): ChatDocumentGeneratedItems {
  const result: ChatDocumentGeneratedItems = { rootChildren: [], childrenByParentId: {}, attachmentsByParentId: {}, allItems: [] };
  const rootOrderings: Array<Uint8Array> = [];
  const idFor = (key: string): Uid => virtual ? stableUid(`text-document-chat:${textItem.id}:${key}`) : newUid();
  const addRoot = (item: Item): void => {
    item.parentId = page.id;
    item.relationshipToParent = RelationshipToParent.Child;
    item.ordering = newOrderingAtEnd(rootOrderings);
    rootOrderings.push(item.ordering);
    result.rootChildren.push(item);
  };
  const add = (item: Item): void => {
    if (virtual) {
      markClientOnly(item);
      item.capabilities = readonlyCapabilities;
    } else {
      item.capabilities = null;
    }
    if (isContainer(item)) {
      asContainerItem(item).computed_children = [];
      asContainerItem(item).childrenLoaded = true;
    }
    if (isAttachmentsItem(item)) {
      asAttachmentsItem(item).computed_attachments = [];
    }
    if (item.parentId != page.id) {
      const byParent = item.relationshipToParent == RelationshipToParent.Attachment
        ? result.attachmentsByParentId
        : result.childrenByParentId;
      byParent[item.parentId] = [...(byParent[item.parentId] ?? []), item];
    }
    result.allItems.push(item);
  };

  // A turn can be copied out by shift-dragging it, with its content, as in the chat window.
  const makeCopyable = (item: Item): void => {
    if (virtual) { item.capabilities = readonlyCopyableCapabilities; }
  };

  chat.turns.forEach((turn, turnIndex) => {
    const composite = CompositeFns.create(ownerId, page.id, RelationshipToParent.Child, newOrdering());
    composite.id = idFor(`${turnIndex}:you`);
    composite.title = "You";
    composite.flags |= CompositeFlags.ShowTitle;
    addRoot(composite);
    add(composite);
    makeCopyable(composite);
    // The attachments, then the text, as the message was sent.
    const childOrderings: Array<Uint8Array> = [];
    const nextChildOrdering = (): Uint8Array => {
      const ordering = newOrderingAtEnd(childOrderings);
      childOrderings.push(ordering);
      return ordering;
    };
    turn.attachments.forEach((attachment, attachmentIndex) => {
      const attachmentItem = createChatAttachmentItem(
        ownerId, composite.id, nextChildOrdering(), attachment, { chatItemId: textItem.id });
      attachmentItem.id = idFor(`${turnIndex}:attachment:${attachmentIndex}`);
      add(attachmentItem);
      makeCopyable(attachmentItem);
    });
    if (turn.text != "") {
      const note = NoteFns.create(ownerId, composite.id, RelationshipToParent.Child, turn.text, nextChildOrdering());
      note.id = idFor(`${turnIndex}:you-text`);
      add(note);
    }

    if (turn.status == "completed" && turn.items != null && turn.items.length > 0) {
      const returned = turn.items.map(itemObject => ItemFns.fromObject(itemObject, null));
      const idMap = new Map(returned.map((item, index) => [item.id, idFor(`${turnIndex}:assistant:${index}`)]));
      const childrenOf = new Map<Uid, Array<Item>>();
      const roots: Array<Item> = [];
      for (const item of returned) {
        const parentId = item.parentId == null ? null : idMap.get(item.parentId) ?? null;
        item.id = idMap.get(item.id)!;
        if (parentId == null) {
          roots.push(item);
        } else {
          item.parentId = parentId;
          childrenOf.set(parentId, [...(childrenOf.get(parentId) ?? []), item]);
        }
      }
      const visit = (item: Item): void => {
        add(item);
        for (const child of childrenOf.get(item.id) ?? []) {
          visit(child);
        }
      };
      for (const root of roots) {
        addRoot(root);
        if (isComposite(root)) {
          asCompositeItem(root).flags |= CompositeFlags.ShowTitle;
        }
        visit(root);
        makeCopyable(root);
      }
    } else {
      const outcome = queryChatOutcomeText(turn.status, turn.error);
      if (outcome != null) {
        const outcomeNote = NoteFns.create(ownerId, page.id, RelationshipToParent.Child, outcome, newOrdering());
        outcomeNote.id = idFor(`${turnIndex}:outcome`);
        addRoot(outcomeNote);
        add(outcomeNote);
      }
    }
  });
  return result;
}

function upsertVirtualChatProjection(textItem: TextItem, chat: LoadChatResponse): PageItem {
  const storedPage = upsertVirtualPageShell(textItem);
  const generated = createChatDocumentItems(textItem, textItem.ownerId, storedPage, chat, true);
  const attachmentServerObjectsByParentId = toVirtualServerObjectMap(generated.attachmentsByParentId);
  itemState.applyContainerSnapshotFromServerObjects(
    storedPage.id,
    toVirtualServerObjects(generated.rootChildren),
    attachmentServerObjectsByParentId,
    null,
  );
  for (const item of generated.allItems) {
    if (!isContainer(item)) { continue; }
    itemState.applyContainerSnapshotFromServerObjects(
      item.id,
      toVirtualServerObjects(generated.childrenByParentId[item.id] ?? []),
      attachmentServerObjectsByParentId,
      null,
    );
    const container = itemState.getAsContainerItem(item.id);
    if (container != null) {
      container.childrenLoaded = true;
      markChildrenLoadAsInitiatedOrComplete(container.id);
    }
  }
  storedPage.childrenLoaded = true;
  return storedPage;
}

/** Builds the virtual document page for a text item from its content: a chat for a persisted chat, else its text. */
async function projectVirtualTextDocument(store: StoreContextModel, textItem: TextItem): Promise<() => PageItem> {
  if (isChatTextItem(textItem)) {
    const chat = await server.loadPersistedChat(textItem.id);
    return () => upsertVirtualChatProjection(textItem, chat);
  }
  const text = await fetchTextItemContent(textItem);
  return () => upsertVirtualProjection(textItem, parseTextDocumentBlocks(text, isMarkdownTextItem(textItem)));
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
  page.backgroundColorIndex = 0;
  page.childrenLoaded = true;
  page.computed_children = [];
  page.computed_attachments = [];
  return page;
}

export async function createMaterializedTextDocumentItems(
  store: StoreContextModel,
  textItem: TextItem,
  page: PageItem,
): Promise<Array<Item>> {
  if (isChatTextItem(textItem)) {
    const chat = await server.loadPersistedChat(textItem.id);
    return createChatDocumentItems(textItem, page.ownerId, page, chat, false).allItems;
  }
  const text = await fetchTextItemContent(textItem);
  const blocks = parseTextDocumentBlocks(text, isMarkdownTextItem(textItem));
  return createTextDocumentItems(null, page.ownerId, page, blocks).allItems;
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

export function isMarkdownTextDocumentPage(pageId: Uid): boolean {
  const source = sourceTextItemForVirtualTextDocumentPage(pageId);
  return source != null && isMarkdownTextItem(source);
}

export function openTextItemFileInNewTab(store: StoreContextModel, textItem: TextItem): void {
  if (textItem.chatAttachmentSource != null) {
    // A chat attachment is not a file on the server: open its text from here.
    void fetchTextItemContent(textItem)
      .then(text => {
        const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
        window.open(url, "_blank", "noopener");
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      })
      .catch(e => {
        console.error(`Could not open chat attachment '${textItem.chatAttachmentSource?.attachmentId}':`, e);
        setTransientMessage(store, "could not open the attachment", TransientMessageType.Error);
      });
    return;
  }
  if (textItem.origin == null) {
    // Use a different URL for chats so an earlier cached attachment response is not reused.
    const url = '/files/' + textItem.id + (isChatTextItem(textItem) ? '?view=chat' : '');
    window.open(url, '_blank', 'noopener');
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
  void serverOrRemote.updateItem(source)
    .catch((e) => {
      console.error("Failed to persist text document page options:", e);
      setTransientMessage(store, "could not save text document settings", TransientMessageType.Error);
    });
}

export async function prepareTextDocumentProjection(store: StoreContextModel, textItem: TextItem, navigationRequestId: number): Promise<PageItem | null> {
  const project = await projectVirtualTextDocument(store, textItem);
  if (!store.history.isNavigationRequestCurrent(navigationRequestId)) { return null; }
  return project();
}

const pendingVirtualPageTextIds = new Set<Uid>();
const failedVirtualPageTextIds = new Set<Uid>();

/**
 * The virtual document page for textItem, if it exists and is current (its content may not be loaded yet).
 */
function currentVirtualTextDocumentPageMaybe(textItem: TextItem): PageItem | null {
  const pageId = stableUid(`text-document-page:${textItem.id}`);
  if (virtualSourceTextIdByPageId.get(pageId) != textItem.id) { return null; }
  const page = itemState.get(pageId);
  if (page == null || !isPage(page) || asPageItem(page).title != textItem.title) { return null; }
  return asPageItem(page);
}

/**
 * The virtual document page for textItem, for use where arrange needs the page but can't await it.
 * Analogous to a page whose children are not loaded yet: if necessary the page is created synchronously
 * (so it can be rendered immediately), and its content is projected in the background, requesting an
 * arrange when done.
 */
export function virtualTextDocumentPage(store: StoreContextModel, textItem: TextItem): PageItem {
  let page = currentVirtualTextDocumentPageMaybe(textItem);
  if (page == null) {
    const shell = createTextDocumentPage(textItem, true);
    page = asPageItem(itemState.upsertItemFromServerObject(toVirtualServerObject(shell), null));
    page.capabilities = readonlyCapabilities;
    page.childrenLoaded = false;
    virtualSourceTextIdByPageId.set(page.id, textItem.id);
  }
  if (!page.childrenLoaded) {
    loadVirtualTextDocumentPageContentMaybe(store, textItem);
  }
  return page;
}

function loadVirtualTextDocumentPageContentMaybe(store: StoreContextModel, textItem: TextItem): void {
  if (pendingVirtualPageTextIds.has(textItem.id) || failedVirtualPageTextIds.has(textItem.id)) { return; }
  pendingVirtualPageTextIds.add(textItem.id);
  projectVirtualTextDocument(store, textItem)
    .then(project => {
      project();
      requestArrange(store, "text-document-virtual-page-ready");
    })
    .catch(e => {
      failedVirtualPageTextIds.add(textItem.id);
      console.error("Failed to project text document:", e);
    })
    .finally(() => {
      pendingVirtualPageTextIds.delete(textItem.id);
    });
}

export async function openTextDocumentProjection(store: StoreContextModel, textItem: TextItem, updateHistory: boolean = true, clearHistory: boolean = false): Promise<void> {
  const navigationRequestId = store.history.beginNavigationRequest();
  let navigationApplied = false;
  try {
    const page = await prepareTextDocumentProjection(store, textItem, navigationRequestId);
    if (page == null) { return; }
    const pageVeid = { itemId: page.id, linkIdMaybe: null };
    navigationApplied = true;
    if (clearHistory) {
      store.history.setHistoryToSinglePage(pageVeid, undefined, textItem.id);
    } else if (store.history.currentPageVeid()?.itemId != page.id) {
      store.history.pushPageVeid(pageVeid, undefined, textItem.id);
    } else {
      store.history.setFocus(store.history.currentPagePath()!);
    }
    const url = textDocumentUrl(textItem);
    store.history.writeBrowserEntry(url, updateHistory && window.location.pathname != url ? "push" : "restore");
    store.currentUrlPath.set(updateHistory ? url : window.location.pathname);
    store.overlay.setTextEditInfo(store.history, null, true);
    arrangeNow(store, "text-document-open");
  } catch (e) {
    if (!navigationApplied && !store.history.isNavigationRequestCurrent(navigationRequestId)) { return; }
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
  // Directly after the text item, so in its band if it is pinned.
  page.pinnedTo = textItem.relationshipToParent == RelationshipToParent.Child ? textItem.pinnedTo : null;
  page.capabilities = null;

  itemState.add(page);
  const generatedItems = await createMaterializedTextDocumentItems(store, textItem, page);
  for (const item of generatedItems) {
    itemState.add(item);
  }
  requestArrange(store, "text-document-materialize-local");

  try {
    await server.addItem(page, null);
    for (const item of generatedItems) {
      await server.addItem(item, await clientTextCopyData(item));
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
  store.history.beginNavigationRequest();
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
