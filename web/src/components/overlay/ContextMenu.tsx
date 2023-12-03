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

import { Component } from "solid-js";
import { NoteFns } from "../../items/note-item";
import { asPageItem, isPage, PageFns } from "../../items/page-item";
import { useStore } from "../../store/StoreProvider";
import { isInside, Vector } from "../../util/geometry";
import { server } from "../../server";
import { asTableItem, isTable, TableFns } from "../../items/table-item";
import { RatingFns } from "../../items/rating-item";
import { initialEditDialogBounds } from "./edit/EditDialog";
import { panic } from "../../util/lang";
import { HitInfo } from "../../input/hit";
import { asLinkItem, isLink, LinkFns } from "../../items/link-item";
import { EMPTY_UID, Uid } from "../../util/uid";
import { itemState } from "../../store/ItemState";
import { PasswordFns } from "../../items/password-item";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { InfuIconButton } from "../library/InfuIconButton";
import { RelationshipToParent } from "../../layout/relationship-to-parent";
import { arrange } from "../../layout/arrange";
import { MOUSE_LEFT } from "../../input/mouse_down";
import { PositionalItem } from "../../items/base/positional-item";
import { isPlaceholder, PlaceholderFns } from "../../items/placeholder-item";
import { VesCache } from "../../layout/ves-cache";
import { GRID_SIZE, Z_INDEX_TEXT_OVERLAY } from "../../constants";
import { asAttachmentsItem } from "../../items/base/attachments-item";


type ContexMenuProps = {
  desktopPosPx: Vector,
  hitInfo: HitInfo
};

export const AddItem: Component<ContexMenuProps> = (props: ContexMenuProps) => {
  const store = useStore();

  const newPageInContext = () => newItemInContext("page");
  const newNoteInContext = () => newItemInContext("note");
  const newTableInContext = () => newItemInContext("table");
  const newRatingInContext = () => newItemInContext("rating");
  const newLinkInContext = () => newItemInContext("link");
  const newPasswordInContext = () => newItemInContext("password");

  function createNewItem(type: string, parentId: Uid, ordering: Uint8Array, relationship: string): PositionalItem {
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
    } else {
      panic("AddItem.createNewItem: unexpected item type.");
    }
    return newItem;
  }

  const newItemInContext = (type: string) => {
    const overElementVe = props.hitInfo.overElementVes.get();
    const overPositionableVe = props.hitInfo.overPositionableVe;

    let newItem;
    let newItemPath;

    if (isPlaceholder(overElementVe.displayItem)) {
      newItem = createNewItem(
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
        type,
        overElementVe.displayItem.id,
        itemState.newOrderingAtEndOfChildren(overElementVe.displayItem.id),
        RelationshipToParent.Child);

      const page = asPageItem(overElementVe.displayItem);
      const propX = (props.desktopPosPx.x - overElementVe.boundsPx.x) / overElementVe.boundsPx.w;
      const propY = (props.desktopPosPx.y - overElementVe.boundsPx.y) / overElementVe.boundsPx.h;
      newItem.spatialPositionGr = {
        x: Math.floor(page.innerSpatialWidthGr / GRID_SIZE * propX * 2.0) / 2.0 * GRID_SIZE,
        y: Math.floor(page.innerSpatialWidthGr / GRID_SIZE / page.naturalAspect * propY * 2.0) / 2.0 * GRID_SIZE
      };
      const naturalAspect = (store.desktopBoundsPx().w / store.desktopBoundsPx().h);
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
      if (isInside(props.desktopPosPx, overElementVe.childAreaBoundsPx!)) {
        const { insertRow, attachmentPos } = TableFns.tableModifiableColRow(store, overElementVe, props.desktopPosPx);
        const tableItem = asTableItem(overElementVe.displayItem);

        if (attachmentPos == -1 || insertRow >= tableItem.computed_children.length) {
          newItem = createNewItem(
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
          type,
          parentVe.displayItem.id,
          itemState.newOrderingAtEndOfChildren(overElementVe.displayItem.parentId),
          RelationshipToParent.Child);

        const page = asPageItem(overPositionableVe!.displayItem);
        const propX = (props.desktopPosPx.x - overPositionableVe!.boundsPx.x) / overPositionableVe!.boundsPx.w;
        const propY = (props.desktopPosPx.y - overPositionableVe!.boundsPx.y) / overPositionableVe!.boundsPx.h;
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
      store.overlay.noteEditOverlayInfo.set({ itemPath: newItemPath });
    } else if (type == "rating") {
      // noop.
    } else {
      store.overlay.editDialogInfo.set({
        desktopBoundsPx: initialEditDialogBounds(store),
        item: newItem
      });
    }
  }

  const noop = () => {}

  return (
    <div class="border rounded w-[110px] h-[205px] bg-slate-50 mb-1">
      <div class="text-sm pt-[3px]"><InfuIconButton icon="fa fa-sticky-note" highlighted={false} clickHandler={newNoteInContext} /> Note</div>
      <div class="text-sm"><InfuIconButton icon="fa fa-folder" highlighted={false} clickHandler={newPageInContext} /> Page</div>
      <div class="text-sm"><InfuIconButton icon="fa fa-table" highlighted={false} clickHandler={newTableInContext} /> Table</div>
      <div class="text-sm"><InfuIconButton icon="fa fa-star" highlighted={false} clickHandler={newRatingInContext} /> Rating</div>
      <div class="text-sm"><InfuIconButton icon="fa fa-link" highlighted={false} clickHandler={newLinkInContext} /> Link</div>
      <div class="text-sm"><InfuIconButton icon="fa fa-eye-slash" highlighted={false} clickHandler={newPasswordInContext} /> Password</div>
      <div class="text-sm text-slate-500"><i class="fa fa-image w-[22px] h-[21px] inline-block text-center ml-[3px] text-[14px] relative" /> Image</div>
      <div class="text-sm text-slate-500"><i class="fa fa-file w-[22px] h-[21px] inline-block text-center ml-[3px] text-[14px] relative" /> File</div>
      <div class="text-sm text-slate-500"><span class="w-[22px] h-[16px] inline-block text-center ml-[3px] relative">∑</span> Expression</div>
    </div>
  );
}


export const ContextMenu: Component = () => {
  const store = useStore();

  // Prevent mouse down events bubbling up, which would trigger the handler that hides the context menu.
  let mouseDownListener = (ev: MouseEvent) => {
    if (ev.button == MOUSE_LEFT) {
      ev.stopPropagation();
    }
  }

  const posPx = () => store.overlay.contextMenuInfo.get()!.posPx;
  const hitInfo = () => store.overlay.contextMenuInfo.get()!.hitInfo;

  return (
    <div class="absolute"
         style={`left: ${posPx().x-10}px; top: ${posPx().y-30}px; ` +
                `z-index: ${Z_INDEX_TEXT_OVERLAY};`}
         onMouseDown={mouseDownListener}>
      <AddItem desktopPosPx={posPx()} hitInfo={hitInfo()} />
    </div>
  );
}
