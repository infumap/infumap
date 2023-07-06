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
import { Child } from "../../layout/relationship-to-parent";
import { newNoteItem } from "../../items/note-item";
import { asPageItem, calcBlockPositionGr, isPage, newPageItem } from "../../items/page-item";
import { useDesktopStore } from "../../store/DesktopStoreProvider";
import { Vector } from "../../util/geometry";
import ToolbarIcon from "../ToolbarIcon";
import { server } from "../../server";
import { useUserStore } from "../../store/UserStoreProvider";
import { newTableItem } from "../../items/table-item";
import { arrange } from "../../layout/arrange";
import { newRatingItem } from "../../items/rating-item";
import { initialEditDialogBounds } from "./EditDialog";
import { panic } from "../../util/lang";
import { HitInfo } from "../../mouse/hitInfo";
import { newLinkItem } from "../../items/link-item";
import { EMPTY_UID } from "../../util/uid";


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

  const newItemInContext = (type: string) => {
    const overElementVe = props.hitInfo.overElementVes.get();
    if (overElementVe.isInsideTable) {
      const attachmentNumber = props.hitInfo.overElementVes.get();
      console.log(attachmentNumber);

      panic();
    } else if (isPage(overElementVe.item) && overElementVe.isDragOverPositioning) {

    } else {
      console.log("unsupported add position");
    }

    let newItem = null;
    if (type == "rating") {
      newItem = newRatingItem(
        userStore.getUser().userId,
        overElementVe.item.id,
        3,
        Child,
        desktopStore.newOrderingAtEndOfChildren(overElementVe.item.id))
    } else if (type == "table") {
      newItem = newTableItem(
        userStore.getUser().userId,
        overElementVe.item.id,
        Child,
        "",
        desktopStore.newOrderingAtEndOfChildren(overElementVe.item.id));
    } else if (type == "note") {
      newItem = newNoteItem(
        userStore.getUser().userId,
        overElementVe.item.id,
        Child,
        "",
        desktopStore.newOrderingAtEndOfChildren(overElementVe.item.id));
    } else if (type == "page") {
      newItem = newPageItem(
        userStore.getUser().userId,
        overElementVe.item.id!,
        Child,
        "",
        desktopStore.newOrderingAtEndOfChildren(overElementVe.item.id));
    } else if (type == "link")  {
      newItem = newLinkItem(userStore.getUser().userId,
        overElementVe.item.id!,
        Child,
        desktopStore.newOrderingAtEndOfChildren(overElementVe.item.id),
        EMPTY_UID);
    } else {
      panic();
    }

    if (isPage(overElementVe.item) && overElementVe.isDragOverPositioning) {
      newItem.spatialPositionGr = calcBlockPositionGr(desktopStore, asPageItem(overElementVe.item), props.desktopPosPx);
      server.addItem(newItem, null);
      desktopStore.addItem(newItem);
      desktopStore.setContextMenuInfo(null);
      desktopStore.setEditDialogInfo({
        desktopBoundsPx: initialEditDialogBounds(desktopStore),
        item: newItem
      });
      arrange(desktopStore);
      return;
    }

    panic();
  }

  return (
    <div class="border rounded w-[250px] h-[55px] bg-slate-50 mb-1">
      <div class="text-slate-800 text-sm ml-1">Add new item here</div>
      <ToolbarIcon icon="folder" margin={18} clickHandler={newPageInContext} />
      <ToolbarIcon icon="table" margin={4} clickHandler={newTableInContext} />
      <ToolbarIcon icon="sticky-note" margin={8} clickHandler={newNoteInContext} />
      <ToolbarIcon icon="star" margin={4} clickHandler={newRatingInContext} />
      <ToolbarIcon icon="link" margin={4} clickHandler={newLinkInContext} />
    </div>
  );
}
