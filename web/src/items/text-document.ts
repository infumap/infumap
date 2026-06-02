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
import { RelationshipToParent } from "../layout/relationship-to-parent";
import { PageFlags, NoteFlags } from "./base/flags-item";
import { ItemType } from "./base/item";
import { NoteFns, NoteItem } from "./note-item";
import { ArrangeAlgorithm, PageFns, PageItem, asPageItem, isPage } from "./page-item";
import type { TextItem } from "./text-item";
import { itemState } from "../store/ItemState";
import { StoreContextModel } from "../store/StoreProvider";
import { TransientMessageType } from "../store/StoreProvider_Overlay";
import { server, serverOrRemote } from "../server";
import { newOrdering, newOrderingAtEnd } from "../util/ordering";
import { EMPTY_UID, Uid, isUid } from "../util/uid";
import { fetchRemoteFileText } from "../util/remoteFile";

type TextBlockKind = "paragraph" | "heading";

type TextDocumentBlock = {
  kind: TextBlockKind,
  title: string,
  headingLevel: number | null,
  start: number,
  end: number,
  ordinal: number,
};

type TextLine = {
  text: string,
  start: number,
  end: number,
  nextStart: number,
};

const readonlyCapabilities = { edit: false, move: false };
const virtualSourceTextIdByPageId = new Map<Uid, Uid>();
const textContentPromises = new Map<string, Promise<string>>();

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

function currentResolvablePageUrl(store: StoreContextModel): string {
  const currentUrl = store.currentUrlPath.get() || window.location.pathname;
  const parts = currentUrl.split("/");
  const lastPart = parts[parts.length - 1] ?? "";
  if (lastPart == "" || isUid(lastPart) || (parts.length >= 4 && parts[1] == "remote" && isUid(parts[3]))) {
    return currentUrl;
  }

  const currentPageVeid = store.history.currentPageVeid();
  return currentPageVeid == null ? currentUrl : `/${currentPageVeid.itemId}`;
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

function parseTextDocumentBlocks(text: string): Array<TextDocumentBlock> {
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

  for (const line of lines) {
    if (line.text.trim() == "") {
      flushParagraph();
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
  if (textItem.documentShowTitle === false) {
    page.flags |= PageFlags.HideDocumentTitle;
  } else {
    page.flags &= ~PageFlags.HideDocumentTitle;
  }
}

function createTextDocumentPage(textItem: TextItem, virtual: boolean): PageItem {
  const page = PageFns.create(
    textItem.ownerId,
    textItem.parentId ?? EMPTY_UID,
    textItem.relationshipToParent,
    textItem.title,
    virtual ? textItem.ordering : newOrdering(),
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

function createNoteForBlock(textItem: TextItem, pageId: Uid, block: TextDocumentBlock, ordering: Uint8Array, virtual: boolean): NoteItem {
  const note = NoteFns.create(textItem.ownerId, pageId, RelationshipToParent.Child, block.title, ordering);
  if (virtual) {
    note.id = stableUid(`text-document-block:${textItem.id}:${block.kind}:${block.start}:${block.end}:${block.ordinal}`);
    note.capabilities = readonlyCapabilities;
  }
  note.flags = noteFlagsForHeadingLevel(block.headingLevel);
  return note;
}

function upsertVirtualProjection(textItem: TextItem, blocks: Array<TextDocumentBlock>): PageItem {
  const page = createTextDocumentPage(textItem, true);
  const storedPage = asPageItem(itemState.upsertItemFromServerObject(page, null));
  storedPage.childrenLoaded = true;
  storedPage.computed_children = [];
  storedPage.computed_attachments = [];
  storedPage.capabilities = readonlyCapabilities;
  virtualSourceTextIdByPageId.set(storedPage.id, textItem.id);

  const notes: Array<NoteItem> = [];
  const orderings: Array<Uint8Array> = [];
  for (const block of blocks) {
    const ordering = newOrderingAtEnd(orderings);
    orderings.push(ordering);
    notes.push(createNoteForBlock(textItem, storedPage.id, block, ordering, true));
  }
  itemState.applyContainerSnapshotFromServerObjects(storedPage.id, notes, {}, null);
  storedPage.childrenLoaded = true;
  return storedPage;
}

export function isVirtualTextDocumentPage(pageId: Uid): boolean {
  return virtualSourceTextIdByPageId.has(pageId);
}

function sourceTextItemForVirtualTextDocumentPage(pageId: Uid): TextItem | null {
  const sourceTextId = virtualSourceTextIdByPageId.get(pageId);
  if (sourceTextId == null) { return null; }
  const source = itemState.get(sourceTextId);
  if (source == null || source.itemType != ItemType.Text) { return null; }
  return source as TextItem;
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
    const page = upsertVirtualProjection(textItem, parseTextDocumentBlocks(text));
    const pageVeid = { itemId: page.id, linkIdMaybe: null };
    const currentUrl = currentResolvablePageUrl(store);
    if (store.history.currentPageVeid()?.itemId != page.id) {
      window.history.pushState(null, "", currentUrl);
      store.currentUrlPath.set(currentUrl);
      store.history.pushPageVeid(pageVeid);
    } else {
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
  const text = await fetchTextItemContent(textItem);
  const blocks = parseTextDocumentBlocks(text);

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
  const notes: Array<NoteItem> = [];
  const orderings: Array<Uint8Array> = [];
  for (const block of blocks) {
    const noteOrdering = newOrderingAtEnd(orderings);
    orderings.push(noteOrdering);
    const note = createNoteForBlock(textItem, page.id, block, noteOrdering, false);
    notes.push(note);
    itemState.add(note);
  }
  requestArrange(store, "text-document-materialize-local");

  try {
    await server.addItem(page, null, store.general.networkStatus);
    for (const note of notes) {
      await server.addItem(note, null, store.general.networkStatus);
    }
    requestArrange(store, "text-document-materialize-complete");
    return page.id;
  } catch (e) {
    console.error("Failed to materialize text document:", e);
    for (const note of notes.reverse()) {
      itemState.delete(note.id);
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
