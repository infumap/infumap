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
import { initialEditDialogBounds } from "../edit/EditDialog";
import { panic } from "../../util/lang";
import { HitInfo } from "../../mouse/hit";
import { LinkFns } from "../../items/link-item";
import { EMPTY_UID } from "../../util/uid";
import { itemState } from "../../store/ItemState";
import { PasswordFns } from "../../items/password-item";
import { VisualElementFlags } from "../../layout/visual-element";
import { InfuIconButton } from "../library/InfuIconButton";
import { RelationshipToParent } from "../../layout/relationship-to-parent";
import { arrange } from "../../layout/arrange";


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

  const newItemInContext = (type: string) => {
    const overElementVe = props.hitInfo.overElementVes.get();
    if (overElementVe.flags & VisualElementFlags.InsideTable) {
      const attachmentNumber = props.hitInfo.overElementVes.get();
      console.log(attachmentNumber);
      panic();
    } else if (isPage(overElementVe.displayItem) && (overElementVe.flags & VisualElementFlags.ShowChildren)) {

    } else {
      console.log("unsupported add position");
    }

    let newItem = null;
    if (type == "rating") {
      newItem = RatingFns.create(
        userStore.getUser().userId,
        overElementVe.displayItem.id,
        3,
        RelationshipToParent.Child,
        itemState.newOrderingAtEndOfChildren(overElementVe.displayItem.id))
    } else if (type == "table") {
      newItem = TableFns.create(
        userStore.getUser().userId,
        overElementVe.displayItem.id,
        RelationshipToParent.Child,
        "",
        itemState.newOrderingAtEndOfChildren(overElementVe.displayItem.id));
    } else if (type == "note") {
      newItem = NoteFns.create(
        userStore.getUser().userId,
        overElementVe.displayItem.id,
        RelationshipToParent.Child,
        "",
        itemState.newOrderingAtEndOfChildren(overElementVe.displayItem.id));
    } else if (type == "page") {
      newItem = PageFns.create(
        userStore.getUser().userId,
        overElementVe.displayItem.id!,
        RelationshipToParent.Child,
        "",
        itemState.newOrderingAtEndOfChildren(overElementVe.displayItem.id));
    } else if (type == "link")  {
      newItem = LinkFns.create(userStore.getUser().userId,
        overElementVe.displayItem.id!,
        RelationshipToParent.Child,
        itemState.newOrderingAtEndOfChildren(overElementVe.displayItem.id),
        EMPTY_UID);
    } else if (type == "password")  {
      newItem = PasswordFns.create(userStore.getUser().userId,
        overElementVe.displayItem.id!,
        RelationshipToParent.Child,
        "",
        itemState.newOrderingAtEndOfChildren(overElementVe.displayItem.id));
    } else {
      panic();
    }

    if (isPage(overElementVe.displayItem) && (overElementVe.flags & VisualElementFlags.ShowChildren)) {
      newItem.spatialPositionGr = PageFns.calcBlockPositionGr(desktopStore, asPageItem(overElementVe.displayItem), props.desktopPosPx);
      server.addItem(newItem, null);
      itemState.add(newItem);
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
      <InfuIconButton icon="folder" clickHandler={newPageInContext} />
      <InfuIconButton icon="table" clickHandler={newTableInContext} />
      <InfuIconButton icon="sticky-note" clickHandler={newNoteInContext} />
      <InfuIconButton icon="star" clickHandler={newRatingInContext} />
      <InfuIconButton icon="link" clickHandler={newLinkInContext} />
      <InfuIconButton icon="eye-slash" clickHandler={newPasswordInContext} />
    </div>
  );
}
