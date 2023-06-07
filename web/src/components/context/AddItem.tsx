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
import { Item } from "../../items/base/item";
import { arrange } from "../../layout/arrange";
import { newRatingItem } from "../../items/rating-item";


type ContexMenuProps = {
  desktopPosPx: Vector,
  contextItem: Item
};

export const AddItem: Component<ContexMenuProps> = (props: ContexMenuProps) => {
  const userStore = useUserStore();
  const desktopStore = useDesktopStore();

  const newPageInContext = () => {
    if (isPage(props.contextItem)) {
      let newPage = newPageItem(
        userStore.getUser().userId,
        props.contextItem?.id!,
        Child,
        "",
        desktopStore.newOrderingAtEndOfChildren(props.contextItem?.id!));
      newPage.spatialPositionGr = calcBlockPositionGr(desktopStore, asPageItem(props.contextItem!), props.desktopPosPx);
      server.addItem(newPage, null);
      desktopStore.addItem(newPage);
      desktopStore.setContextMenuInfo(null);
      desktopStore.setEditDialogInfo({
        desktopBoundsPx: { x:0, y:0, w:0, h:0 },
        item: newPage
      });
      arrange(desktopStore);
    }
  };

  const newNoteInContext = () => {
    if (isPage(props.contextItem)) {
      let newNote = newNoteItem(
        userStore.getUser().userId,
        props.contextItem?.id!,
        Child,
        "",
        desktopStore.newOrderingAtEndOfChildren(props.contextItem?.id!));
      newNote.spatialPositionGr = calcBlockPositionGr(desktopStore, asPageItem(props.contextItem!), props.desktopPosPx);
      desktopStore.addItem(newNote);
      server.addItem(newNote, null);
      desktopStore.setContextMenuInfo(null);
      desktopStore.setEditDialogInfo({
        desktopBoundsPx: { x:0, y:0, w:0, h:0 },
        item: newNote
      });
      arrange(desktopStore);
    }
  };

  const newTableInContext = () => {
    if (isPage(props.contextItem)) {
      let newTable = newTableItem(
        userStore.getUser().userId,
        props.contextItem?.id!,
        Child,
        "",
        desktopStore.newOrderingAtEndOfChildren(props.contextItem?.id!));
      newTable.spatialPositionGr = calcBlockPositionGr(desktopStore, asPageItem(props.contextItem!), props.desktopPosPx);
      server.addItem(newTable, null);
      desktopStore.addItem(newTable);
      desktopStore.setContextMenuInfo(null);
      desktopStore.setEditDialogInfo({
        desktopBoundsPx: { x:0, y:0, w:0, h:0 },
        item: newTable
      });
      arrange(desktopStore);
    }
  };

  const newRatingInContext = () => {
    if (isPage(props.contextItem)) {
      let newRating = newRatingItem(
        userStore.getUser().userId,
        props.contextItem?.id!,
        3,
        Child,
        desktopStore.newOrderingAtEndOfChildren(props.contextItem?.id!));
      newRating.spatialPositionGr = calcBlockPositionGr(desktopStore, asPageItem(props.contextItem!), props.desktopPosPx);
      desktopStore.addItem(newRating);
      server.addItem(newRating, null);
      desktopStore.setContextMenuInfo(null);
      desktopStore.setEditDialogInfo({
        desktopBoundsPx: { x:0, y:0, w:0, h:0 },
        item: newRating
      });
      arrange(desktopStore);
    }
  };

  return (
    <div class="border rounded w-[250px] h-[55px] bg-slate-50 mb-1">
      <div class="text-slate-800 text-sm ml-1">Add new item here</div>
      <ToolbarIcon icon="folder" margin={18} clickHandler={newPageInContext} />
      <ToolbarIcon icon="table" margin={4} clickHandler={newTableInContext} />
      <ToolbarIcon icon="sticky-note" margin={8} clickHandler={newNoteInContext} />
      <ToolbarIcon icon="star" margin={4} clickHandler={newRatingInContext} />
    </div>
  );
}
