/*
  Copyright (C) 2022-2023 The Infumap Authors
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
import { Child } from "../../store/desktop/relationship-to-parent";
import { newNoteItem } from "../../store/desktop/items/note-item";
import { asPageItem, calcBlockPositionGr, isPage, newPageItem } from "../../store/desktop/items/page-item";
import { useDesktopStore } from "../../store/desktop/DesktopStoreProvider";
import { useGeneralStore } from "../../store/GeneralStoreProvider";
import { Vector } from "../../util/geometry";
import ToolbarIcon from "../ToolbarIcon";
import { server } from "../../server";
import { useUserStore } from "../../store/UserStoreProvider";
import { newTableItem } from "../../store/desktop/items/table-item";
import { Item } from "../../store/desktop/items/base/item";


type ContexMenuProps = {
  desktopPosPx: Vector,
  contextItem: Item
};

export const AddItem: Component<ContexMenuProps> = (props: ContexMenuProps) => {
  const userStore = useUserStore();
  const desktopStore = useDesktopStore();
  const generalStore = useGeneralStore();

  const newPageInContext = () => {
    if (isPage(props.contextItem)) {
      let newPage = newPageItem(
        userStore.getUser().userId,
        props.contextItem?.id!,
        Child,
        "my new page",
        desktopStore.newOrderingAtEndOfChildren(props.contextItem?.id!));
      newPage.spatialPositionGr.set(calcBlockPositionGr(desktopStore, asPageItem(props.contextItem!), props.desktopPosPx));
      desktopStore.addItem(newPage);
      server.addItem(newPage, null);
      generalStore.setContextMenuInfo(null);
      generalStore.setEditDialogInfo({
        desktopBoundsPx: { x:0, y:0, w:0, h:0 },
        item: newPage
      });
    }
  };

  const newNoteInContext = () => {
    if (isPage(props.contextItem)) {
      let newNote = newNoteItem(
        userStore.getUser().userId,
        props.contextItem?.id!,
        Child,
        "my new note",
        desktopStore.newOrderingAtEndOfChildren(props.contextItem?.id!));
      newNote.spatialPositionGr.set(calcBlockPositionGr(desktopStore, asPageItem(props.contextItem!), props.desktopPosPx));
      desktopStore.addItem(newNote);
      server.addItem(newNote, null);
      generalStore.setContextMenuInfo(null);
      generalStore.setEditDialogInfo({
        desktopBoundsPx: { x:0, y:0, w:0, h:0 },
        item: newNote
      });
    }
  }

  const newTableInContext = () => {
    if (isPage(props.contextItem)) {
      let newTable = newTableItem(
        userStore.getUser().userId,
        props.contextItem?.id!,
        Child,
        "my new table",
        desktopStore.newOrderingAtEndOfChildren(props.contextItem?.id!));
      newTable.spatialPositionGr.set(calcBlockPositionGr(desktopStore, asPageItem(props.contextItem!), props.desktopPosPx));
      desktopStore.addItem(newTable);
      server.addItem(newTable, null);
      generalStore.setContextMenuInfo(null);
      generalStore.setEditDialogInfo({
        desktopBoundsPx: { x:0, y:0, w:0, h:0 },
        item: newTable
      });
    }
  }

  return (
    <div class="border rounded w-[250px] h-[55px] bg-slate-50 mb-1">
      <div class="text-slate-800 text-sm ml-1">Add new item here</div>
      <ToolbarIcon icon="folder" margin={18} clickHandler={newPageInContext} />
      <ToolbarIcon icon="table" margin={4} clickHandler={newTableInContext} />
      <ToolbarIcon icon="sticky-note" margin={8} clickHandler={newNoteInContext} />
    </div>
  );
}
