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
import { useDesktopStore } from "../../store/DesktopStoreProvider";
import { Vector } from "../../util/geometry";
import { server } from "../../server";
import { useUserStore } from "../../store/UserStoreProvider";
import { TableFns } from "../../items/table-item";
import { RatingFns } from "../../items/rating-item";
import { initialEditDialogBounds } from "./edit/EditDialog";
import { panic } from "../../util/lang";
import { HitInfo } from "../../mouse/hit";
import { LinkFns } from "../../items/link-item";
import { EMPTY_UID, Uid } from "../../util/uid";
import { itemState } from "../../store/ItemState";
import { PasswordFns } from "../../items/password-item";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { InfuIconButton } from "../library/InfuIconButton";
import { RelationshipToParent } from "../../layout/relationship-to-parent";
import { arrange } from "../../layout/arrange";
import { MOUSE_LEFT } from "../../mouse/mouse_down";
import { PositionalItem } from "../../items/base/positional-item";


type ContexMenuProps = {
  desktopPosPx: Vector,
  hitInfo: HitInfo
};

export const AddItem: Component<ContexMenuProps> = (props: ContexMenuProps) => {
  const userStore = useUserStore();
  const desktopStore = useDesktopStore();

  const newPageInContext = () => newItemInContext("page");
  const newNoteInContext = () => newItemInContext("note");
  const newTableInContext = () => newItemInContext("table");
  const newRatingInContext = () => newItemInContext("rating");
  const newLinkInContext = () => newItemInContext("link");
  const newPasswordInContext = () => newItemInContext("password");

  function createNewItem(type: string, parentId: Uid, ordering: Uint8Array, relationship: string): PositionalItem {
    let newItem = null;
    if (type == "rating") {
      newItem = RatingFns.create(userStore.getUser().userId, parentId, 3, relationship, ordering)
    } else if (type == "table") {
      newItem = TableFns.create(userStore.getUser().userId, parentId, relationship, "", ordering);
    } else if (type == "note") {
      newItem = NoteFns.create(userStore.getUser().userId, parentId, relationship, "", ordering);
    } else if (type == "page") {
      newItem = PageFns.create(userStore.getUser().userId, parentId, relationship, "", ordering);
    } else if (type == "link")  {
      newItem = LinkFns.create(userStore.getUser().userId, parentId, relationship, ordering, EMPTY_UID);
    } else if (type == "password")  {
      newItem = PasswordFns.create(userStore.getUser().userId, parentId, relationship, "", ordering);
    } else {
      panic();
    }
    return newItem;
  }

  const newItemInContext = (type: string) => {
    const overElementVe = props.hitInfo.overElementVes.get();
    const newItem = createNewItem(
      type,
      overElementVe.displayItem.id,
      itemState.newOrderingAtEndOfChildren(overElementVe.displayItem.id),
      RelationshipToParent.Child);

    if (isPage(overElementVe.displayItem) && (overElementVe.flags & VisualElementFlags.ShowChildren)) {
      newItem.spatialPositionGr = PageFns.calcBlockPositionGr(desktopStore, asPageItem(overElementVe.displayItem), props.desktopPosPx);
      server.addItem(newItem, null);
      itemState.add(newItem);
      desktopStore.setContextMenuInfo(null);
      arrange(desktopStore);

      if (type == "note") {
        const noteItemPath = VeFns.addVeidToPath({ itemId: newItem.id, linkIdMaybe: null}, VeFns.veToPath(overElementVe));
        desktopStore.setTextEditOverlayInfo({ noteItemPath: noteItemPath });
      } else if (type == "rating") {
        // noop.
      } else {
        desktopStore.setEditDialogInfo({
          desktopBoundsPx: initialEditDialogBounds(desktopStore),
          item: newItem
        });
      }
      return;
    }

    panic();
  }

  return (
    <div class="border rounded w-[250px] h-[55px] bg-slate-50 mb-1">
      <div class="text-slate-800 text-sm ml-1">Add new item here</div>
      <InfuIconButton icon="folder" highlighted={false} clickHandler={newPageInContext} />
      <InfuIconButton icon="table" highlighted={false} clickHandler={newTableInContext} />
      <InfuIconButton icon="sticky-note" highlighted={false} clickHandler={newNoteInContext} />
      <InfuIconButton icon="star" highlighted={false} clickHandler={newRatingInContext} />
      <InfuIconButton icon="link" highlighted={false} clickHandler={newLinkInContext} />
      <InfuIconButton icon="eye-slash" highlighted={false} clickHandler={newPasswordInContext} />
    </div>
  );
}


export const ContextMenu: Component = () => {
  const desktopStore = useDesktopStore();

  // Prevent mouse down events bubbling up, which would trigger the handler that hides the context menu.
  let mouseDownListener = (ev: MouseEvent) => {
    if (ev.button == MOUSE_LEFT) {
      ev.stopPropagation();
    }
  }

  const posPx = () => desktopStore.contextMenuInfo()!.posPx;
  const hitInfo = () => desktopStore.contextMenuInfo()!.hitInfo;

  return (
    <div class="absolute"
         style={`left: ${posPx().x}px; top: ${posPx().y}px`}
         onMouseDown={mouseDownListener}>
      <AddItem desktopPosPx={posPx()} hitInfo={hitInfo()} />
    </div>
  );
}
