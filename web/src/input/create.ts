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

import { initialEditDialogBounds } from "../components/overlay/edit/EditDialog";
import { GRID_SIZE } from "../constants";
import { asAttachmentsItem } from "../items/base/attachments-item";
import { PositionalItem } from "../items/base/positional-item";
import { ExpressionFns } from "../items/expression-item";
import { LinkFns, asLinkItem, isLink } from "../items/link-item";
import { NoteFns } from "../items/note-item";
import { PageFns, asPageItem, isPage } from "../items/page-item";
import { PasswordFns } from "../items/password-item";
import { PlaceholderFns, isPlaceholder } from "../items/placeholder-item";
import { RatingFns } from "../items/rating-item";
import { TableFns, asTableItem, isTable } from "../items/table-item";
import { arrange } from "../layout/arrange";
import { RelationshipToParent } from "../layout/relationship-to-parent";
import { VesCache } from "../layout/ves-cache";
import { VeFns, VisualElementFlags } from "../layout/visual-element";
import { server } from "../server";
import { itemState } from "../store/ItemState";
import { StoreContextModel } from "../store/StoreProvider";
import { CursorPosition } from "../store/StoreProvider_Overlay";
import { Vector, isInside } from "../util/geometry";
import { panic } from "../util/lang";
import { EMPTY_UID, Uid } from "../util/uid";
import { HitInfo } from "./hit";


function createNewItem(store: StoreContextModel, type: string, parentId: Uid, ordering: Uint8Array, relationship: string): PositionalItem {
  let newItem = null;
  if (type == "rating") {
    newItem = RatingFns.create(store.user.getUser().userId, parentId, 3, relationship, ordering)
  } else if (type == "table") {
    newItem = TableFns.create(store.user.getUser().userId, parentId, relationship, "", ordering);
  } else if (type == "note") {
    newItem = NoteFns.create(store.user.getUser().userId, parentId, relationship, "", ordering);
  } else if (type == "page") {
    newItem = PageFns.create(store.user.getUser().userId, parentId, relationship, "", ordering);
  } else if (type == "link")  {
    newItem = LinkFns.create(store.user.getUser().userId, parentId, relationship, ordering, EMPTY_UID);
  } else if (type == "password")  {
    newItem = PasswordFns.create(store.user.getUser().userId, parentId, relationship, "", ordering);
  } else if (type == "expression") {
    newItem = ExpressionFns.create(store.user.getUser().userId, parentId, relationship, "", ordering);
  } else {
    panic("AddItem.createNewItem: unexpected item type.");
  }
  return newItem;
}

export const newItemInContext = (store: StoreContextModel, type: string, hitInfo: HitInfo, desktopPosPx: Vector) => {
  const overElementVe = hitInfo.overElementVes.get();
  const overPositionableVe = hitInfo.overPositionableVe;

  let newItem;
  let newItemPath;

  if (isPlaceholder(overElementVe.displayItem)) {
    newItem = createNewItem(
      store,
      type,
      overElementVe.displayItem.parentId,
      overElementVe.displayItem.ordering,
      overElementVe.displayItem.relationshipToParent);

    itemState.delete(overElementVe.displayItem.id);
    server.deleteItem(overElementVe.displayItem.id);
    itemState.add(newItem);
    server.addItem(newItem, null);

    store.overlay.contextMenuInfo.set(null);
    arrange(store);

    newItemPath = VeFns.addVeidToPath({ itemId: newItem.id, linkIdMaybe: null}, overElementVe.parentPath! );
  }

  else if (isPage(overElementVe.displayItem) && (overElementVe.flags & VisualElementFlags.ShowChildren)) {
    newItem = createNewItem(
      store,
      type,
      overElementVe.displayItem.id,
      itemState.newOrderingAtEndOfChildren(overElementVe.displayItem.id),
      RelationshipToParent.Child);

    if (hitInfo.overPositionGr != null) {
      newItem.spatialPositionGr = hitInfo.overPositionGr!;
    } else {
      console.warn("hitInfo.overPositionGr is not set");
    }

    const naturalAspect = (store.desktopMainAreaBoundsPx().w / store.desktopMainAreaBoundsPx().h);
    if (isPage(newItem)) {
      const page = asPageItem(newItem);
      asPageItem(newItem).naturalAspect = Math.round(naturalAspect * 1000) / 1000;
      page.popupPositionGr = {
        x: Math.round((page.innerSpatialWidthGr / 2) / GRID_SIZE) * GRID_SIZE,
        y: Math.round((page.innerSpatialWidthGr / page.naturalAspect) * 0.4 / GRID_SIZE) * GRID_SIZE
      };
      const widthCandidate1Gr = Math.floor((page.innerSpatialWidthGr / 2.0) / GRID_SIZE) * GRID_SIZE;
      const parentInnerHeightGr = page.innerSpatialWidthGr / naturalAspect;
      const heightCandidate = Math.floor((parentInnerHeightGr / 2.0) / GRID_SIZE) * GRID_SIZE;
      const widthCandidate2Gr = Math.floor(heightCandidate * page.naturalAspect / GRID_SIZE) * GRID_SIZE;
      asPageItem(newItem).popupWidthGr = Math.min(widthCandidate1Gr, widthCandidate2Gr);
    }

    server.addItem(newItem, null);
    itemState.add(newItem);

    store.overlay.contextMenuInfo.set(null);
    arrange(store);

    newItemPath = VeFns.addVeidToPath({ itemId: newItem.id, linkIdMaybe: null}, VeFns.veToPath(overElementVe));
  }

  else if (isTable(overElementVe.displayItem)) {
    if (isInside(desktopPosPx, overElementVe.childAreaBoundsPx!)) {
      const { insertRow, attachmentPos } = TableFns.tableModifiableColRow(store, overElementVe, desktopPosPx);
      const tableItem = asTableItem(overElementVe.displayItem);

      if (attachmentPos == -1 || insertRow >= tableItem.computed_children.length) {
        newItem = createNewItem(
          store,
          type,
          overElementVe.displayItem.id,
          itemState.newOrderingAtEndOfChildren(overElementVe.displayItem.parentId), // must be the case that it is at the end.
          RelationshipToParent.Child);
        server.addItem(newItem, null);
        itemState.add(newItem);
        store.overlay.contextMenuInfo.set(null);
        arrange(store);
        newItemPath = VeFns.addVeidToPath({ itemId: newItem.id, linkIdMaybe: null}, VeFns.veToPath(overElementVe));

      } else {
        const childId = tableItem.computed_children[insertRow];
        const child = asAttachmentsItem(itemState.get(childId)!);
        const displayedChild = asAttachmentsItem(isLink(child)
          ? itemState.get(LinkFns.getLinkToId(asLinkItem(child)))!
          : child);

        const numPlaceholdersToCreate = attachmentPos > displayedChild.computed_attachments.length ? attachmentPos - displayedChild.computed_attachments.length : 0;
        for (let i=0; i<numPlaceholdersToCreate; ++i) {
          const placeholderItem = PlaceholderFns.create(displayedChild.ownerId, displayedChild.id, RelationshipToParent.Attachment, itemState.newOrderingAtEndOfAttachments(displayedChild.id));
          itemState.add(placeholderItem);
          server.addItem(placeholderItem, null);
        }

        newItem = createNewItem(
          store,
          type,
          displayedChild.id,
          itemState.newOrderingAtEndOfAttachments(childId),
          RelationshipToParent.Attachment);

        server.addItem(newItem, null);
        itemState.add(newItem);
        store.overlay.contextMenuInfo.set(null);
        arrange(store);

        newItemPath = VeFns.addVeidToPath({ itemId: newItem.id, linkIdMaybe: null}, VeFns.addVeidToPath(VeFns.veidFromId(childId), VeFns.veToPath(overElementVe)));
      }
    }

    else {
      // not inside child area: create item in the page containing the table.
      const parentVe = VesCache.get(overElementVe.parentPath!)!.get();
      newItem = createNewItem(
        store,
        type,
        parentVe.displayItem.id,
        itemState.newOrderingAtEndOfChildren(overElementVe.displayItem.parentId),
        RelationshipToParent.Child);

      const page = asPageItem(overPositionableVe!.displayItem);
      const propX = (desktopPosPx.x - overPositionableVe!.boundsPx.x) / overPositionableVe!.boundsPx.w;
      const propY = (desktopPosPx.y - overPositionableVe!.boundsPx.y) / overPositionableVe!.boundsPx.h;
      newItem.spatialPositionGr = {
        x: Math.floor(page.innerSpatialWidthGr / GRID_SIZE * propX * 2.0) / 2.0 * GRID_SIZE,
        y: Math.floor(page.innerSpatialWidthGr / GRID_SIZE / page.naturalAspect * propY * 2.0) / 2.0 * GRID_SIZE
      };

      server.addItem(newItem, null);
      itemState.add(newItem);

      store.overlay.contextMenuInfo.set(null);
      arrange(store);

      newItemPath = VeFns.addVeidToPath({ itemId: newItem.id, linkIdMaybe: null}, VeFns.veToPath(parentVe));
    }
  }

  else {
    panic("cannot create item in context here.");
  }


  if (type == "note") {
    store.overlay.noteEditOverlayInfo.set({ itemPath: newItemPath, initialCursorPosition: CursorPosition.Start });
  } else if (type == "rating") {
    // noop.
  } else {
    store.overlay.editDialogInfo.set({
      desktopBoundsPx: initialEditDialogBounds(store),
      item: newItem
    });
  }
}