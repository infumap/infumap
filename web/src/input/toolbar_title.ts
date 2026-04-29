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
import { asTableItem, isTable } from "../items/table-item";
import { RelationshipToParent } from "../layout/relationship-to-parent";
import { VeFns } from "../layout/visual-element";
import { serverOrRemote } from "../server";
import { itemState } from "../store/ItemState";
import { StoreContextModel } from "../store/StoreProvider";


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

export function commitActiveToolbarTitleEdit(store: StoreContextModel): boolean {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement) || !activeElement.isContentEditable) {
    return false;
  }

  const pageItem = toolbarTitlePageItem(store, activeElement);
  if (!pageItem || !itemCanEdit(pageItem)) {
    return false;
  }

  pageItem.title = activeElement.innerText;
  if (pageItem.relationshipToParent == RelationshipToParent.Child) {
    const parentItem = itemState.get(pageItem.parentId);
    if (parentItem && isTable(parentItem) && asTableItem(parentItem).orderChildrenBy != "") {
      itemState.sortChildren(pageItem.parentId);
    }
  }
  serverOrRemote.updateItem(pageItem, store.general.networkStatus);
  return true;
}
