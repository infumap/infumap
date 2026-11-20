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

import { itemCanEdit } from "../items/base/capabilities-item";
import { asPageItem, isPage } from "../items/page-item";
import type { PageItem } from "../items/page-item";
import { titleEditableSourceForVirtualTextDocumentPage } from "../items/text-document";
import { VeFns } from "../layout/visual-element";
import { itemState } from "../store/ItemState";
import { StoreContextModel } from "../store/StoreProvider";
import { trimNewline } from "../util/string";
import { SOLO_ITEM_HOLDER_PAGE_UID } from "../util/uid";


const TOOLBAR_TITLE_DIV_ID_REGEX = /^toolbarTitleDiv-(\d+)$/;

function toolbarTitleDivIndex(element: Element | null): number | null {
  if (!(element instanceof HTMLElement)) { return null; }
  const match = element.id.match(TOOLBAR_TITLE_DIV_ID_REGEX);
  if (!match) { return null; }
  return Number.parseInt(match[1], 10);
}

function toolbarTitlePageItem(store: StoreContextModel, element: Element | null): PageItem | null {
  const idx = toolbarTitleDivIndex(element);
  if (idx == null) { return null; }

  const titlePath = store.topTitledPages.get()[idx];
  if (!titlePath) { return null; }

  const titleItem = itemState.get(VeFns.itemIdFromPath(titlePath));
  if (!titleItem || !isPage(titleItem)) { return null; }
  return asPageItem(titleItem);
}

/**
 * Whether the title of a page in the toolbar can be edited. A text item (including a kept chat or research run) shown
 * as a document page is shown as a read-only virtual page, but its title is the text item's and can be edited.
 */
export function toolbarTitleCanEdit(pageItem: PageItem): boolean {
  if (pageItem.id == SOLO_ITEM_HOLDER_PAGE_UID) { return false; }
  return itemCanEdit(pageItem) || titleEditableSourceForVirtualTextDocumentPage(pageItem.id) != null;
}

/**
 * The title shown in a toolbar title div. Emptying the div (select all, then delete) leaves only a <br>, whose
 * innerText is "\n".
 */
function toolbarTitleDivText(element: HTMLElement): string {
  return trimNewline(element.innerText);
}

/**
 * Makes a toolbar title div show title, unless it already does. The div is edited in place by the browser, so it is not
 * rendered as a Solid text child: Solid only rewrites text when the title differs from the value it last rendered, and
 * then only by setting firstChild.data. After an edit that leaves just a <br> (emptying the title), or when the slot
 * goes to another page with the same title as the last rendered one, the div would keep showing stale text, and the
 * next commit would save that text to whichever page is now in the slot.
 */
export function syncToolbarTitleDivText(element: HTMLElement, title: string): void {
  if (toolbarTitleDivText(element) != title) {
    element.textContent = title;
  }
}

export function commitActiveToolbarTitleEdit(store: StoreContextModel, immediately: boolean = true): boolean {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement) || !activeElement.isContentEditable) {
    return false;
  }

  const pageItem = toolbarTitlePageItem(store, activeElement);
  if (!pageItem || !toolbarTitleCanEdit(pageItem)) {
    return false;
  }

  const newTitle = toolbarTitleDivText(activeElement);
  // The virtual page's title is kept equal to its text item's: a mismatch makes it be projected again.
  const itemToSave = titleEditableSourceForVirtualTextDocumentPage(pageItem.id) ?? pageItem;
  if (itemToSave.title != newTitle) {
    pageItem.title = newTitle;
    itemToSave.title = newTitle;
    itemState.sortParentChildrenIfSorted(itemToSave);
    store.textEdit.saveItem(itemToSave, immediately);
  } else if (immediately) {
    void store.textEdit.flush();
  }
  return true;
}
