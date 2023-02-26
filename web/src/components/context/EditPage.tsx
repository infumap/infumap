/*
  Copyright (C) 2022 The Infumap Authors
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
import { GRID_SIZE } from "../../constants";
import { server } from "../../server";
import { asPageItem, PageItem } from "../../store/desktop/items/page-item";
import { useDesktopStore } from "../../store/desktop/DesktopStoreProvider";
import { useUserStore } from "../../store/UserStoreProvider";
import { InfuButton } from "../library/InfuButton";
import { InfuTextInput } from "../library/InfuTextInput";
import { ColorSelector } from "./ColorSelector";


export const EditPage: Component<{pageItem: PageItem}> = (props: {pageItem: PageItem}) => {
  const userStore = useUserStore();
  const desktopStore = useDesktopStore();

  let pageId = () => props.pageItem.id;

  const handleBlockWidthChange = (v: string) => {
    desktopStore.updateItem(pageId(), item => asPageItem(item).innerSpatialWidthGr = parseInt(v) * GRID_SIZE);
    server.updateItem(userStore.getUser(), desktopStore.getItem(pageId())!);
  };
  const handleNaturalAspectChange = (v: string) => {
    desktopStore.updateItem(pageId(), item => asPageItem(item).naturalAspect = parseFloat(v));
    server.updateItem(userStore.getUser(), desktopStore.getItem(pageId())!);
  };
  const handleTitleChange = (v: string) => { desktopStore.updateItem(pageId(), item => asPageItem(item).title = v); };
  const handleTitleChanged = (v: string) => { server.updateItem(userStore.getUser(), desktopStore.getItem(pageId())!); }

  const deletePage = async () => {
    await server.deleteItem(userStore.getUser(), pageId());
  }

  return (
    <div class="m-1">
      <div class="text-slate-800 text-sm">Title <InfuTextInput value={props.pageItem.title} onIncrementalChange={handleTitleChange} onChange={handleTitleChanged} /></div>
      <div class="text-slate-800 text-sm">Inner block width <InfuTextInput value={(props.pageItem.innerSpatialWidthGr / GRID_SIZE).toString()} onChange={handleBlockWidthChange} /></div>
      <div class="text-slate-800 text-sm">Natural Aspect <InfuTextInput value={props.pageItem.naturalAspect.toString()} onChange={handleNaturalAspectChange} /></div>
      <ColorSelector item={props.pageItem} />
      <div><InfuButton text="delete" onClick={deletePage} /></div>
    </div>
  );
}
