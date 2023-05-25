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

import { Component, onCleanup } from "solid-js";
import { GRID_SIZE } from "../../constants";
import { server } from "../../server";
import { asPageItem, PageItem } from "../../store/desktop/items/page-item";
import { useDesktopStore } from "../../store/desktop/DesktopStoreProvider";
import { InfuButton } from "../library/InfuButton";
import { InfuTextInput } from "../library/InfuTextInput";
import { ColorSelector } from "./ColorSelector";
import { useGeneralStore } from "../../store/GeneralStoreProvider";
import { arrange, rearrangeVisualElementsWithId } from "../../store/desktop/layout/arrange";


export const EditPage: Component<{pageItem: PageItem}> = (props: {pageItem: PageItem}) => {
  const desktopStore = useDesktopStore();
  const generalStore = useGeneralStore();

  const screenAspect = (): number => {
    let aspect = desktopStore.desktopBoundsPx().w / desktopStore.desktopBoundsPx().h;
    return Math.round(aspect * 1000.0) / 1000.0;
  }

  const pageId = props.pageItem.id;
  let deleted = false;

  const handleBlockWidthChange = (v: string) => {
    if (!deleted) {
      asPageItem(desktopStore.getItem(pageId)!).innerSpatialWidthGr.set(parseInt(v) * GRID_SIZE);
      rearrangeVisualElementsWithId(desktopStore, pageId, true);
    }
  };

  const handleNaturalAspectChange = async (v: string) => {
    if (!deleted) {
      asPageItem(desktopStore.getItem(pageId)!).naturalAspect.set(parseFloat(v));
      rearrangeVisualElementsWithId(desktopStore, pageId, true);
    }
  };

  const handleGridNumberOfColumnsChange = (v: string) => {
    if (!deleted) {
      desktopStore.updateItem(pageId, item => asPageItem(item).gridNumberOfColumns.set(parseInt(v)));
      rearrangeVisualElementsWithId(desktopStore, pageId, true);
    }
  }

  const handleTitleInput = (v: string) => {
    desktopStore.updateItem(pageId, item => asPageItem(item).title = v);
    rearrangeVisualElementsWithId(desktopStore, pageId, true);
  };

  const deletePage = async () => {
    deleted = true;
    await server.deleteItem(pageId); // throws on failure.
    desktopStore.deleteItem(pageId);
    generalStore.setEditDialogInfo(null);
    arrange(desktopStore);
  }

  const setAspectToMatchScreen = async () => {
    asPageItem(desktopStore.getItem(pageId)!).naturalAspect.set(screenAspect());
    rearrangeVisualElementsWithId(desktopStore, pageId, true);
  }

  let checkElement: HTMLInputElement | undefined;

  const changeArrangeAlgo = async () => {
    desktopStore.updateItem(pageId, item => asPageItem(item).arrangeAlgorithm = (checkElement?.checked ? "grid" : "spatial-stretch"));
    rearrangeVisualElementsWithId(desktopStore, pageId, true);
  }

  onCleanup(() => {
    if (!deleted) {
      server.updateItem(desktopStore.getItem(pageId)!);
    }
  });

  return (
    <div class="m-1">
      <div class="text-slate-800 text-sm">Title <InfuTextInput value={props.pageItem.title} onInput={handleTitleInput} focus={true} /></div>
      <div class="text-slate-800 text-sm">Inner block width <InfuTextInput value={(props.pageItem.innerSpatialWidthGr.get() / GRID_SIZE).toString()} onChangeOrCleanup={handleBlockWidthChange} /></div>
      <div class="text-slate-800 text-sm">Natural Aspect <InfuTextInput value={props.pageItem.naturalAspect.get().toString()} onChangeOrCleanup={handleNaturalAspectChange} /></div>
      <InfuButton text={screenAspect().toString()} onClick={setAspectToMatchScreen} />
      <ColorSelector item={props.pageItem} />
      <div><InfuButton text="delete" onClick={deletePage} /></div>
      <div>is grid: <input ref={checkElement} type="checkbox" checked={props.pageItem.arrangeAlgorithm == "grid"} onClick={changeArrangeAlgo} /></div>
      <div class="text-slate-800 text-sm"> <InfuTextInput value={props.pageItem.gridNumberOfColumns.get().toString()} onChangeOrCleanup={handleGridNumberOfColumnsChange} /></div>
    </div>
  );
}
