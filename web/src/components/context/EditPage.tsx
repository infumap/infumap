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

import { Component, onCleanup } from "solid-js";
import { GRID_SIZE } from "../../constants";
import { server } from "../../server";
import { asPageItem, PageItem } from "../../items/page-item";
import { useDesktopStore } from "../../store/DesktopStoreProvider";
import { InfuButton } from "../library/InfuButton";
import { InfuTextInput } from "../library/InfuTextInput";
import { ColorSelector } from "./ColorSelector";
import { ARRANGE_ALGO_GRID, ARRANGE_ALGO_LIST, ARRANGE_ALGO_SPATIAL_STRETCH, arrange, rearrangeVisualElementsWithItemId } from "../../layout/arrange";
import { panic } from "../../util/lang";
import { compareOrderings } from "../../util/ordering";


export const EditPage: Component<{pageItem: PageItem}> = (props: {pageItem: PageItem}) => {
  const desktopStore = useDesktopStore();

  const screenAspect = (): number => {
    let aspect = desktopStore.desktopBoundsPx().w / desktopStore.desktopBoundsPx().h;
    return Math.round(aspect * 1000.0) / 1000.0;
  }

  const pageId = props.pageItem.id;
  let deleted = false;

  const handleBlockWidthChange = (v: string) => {
    if (!deleted) {
      asPageItem(desktopStore.getItem(pageId)!).innerSpatialWidthGr = parseInt(v) * GRID_SIZE;
      rearrangeVisualElementsWithItemId(desktopStore, pageId);
    }
  };

  const handleNaturalAspectChange = async (v: string) => {
    if (!deleted) {
      asPageItem(desktopStore.getItem(pageId)!).naturalAspect = parseFloat(v);
      rearrangeVisualElementsWithItemId(desktopStore, pageId);
    }
  };

  const handleGridNumberOfColumnsChange = (v: string) => {
    if (!deleted) {
      asPageItem(desktopStore.getItem(pageId)!).gridNumberOfColumns = parseInt(v);
      rearrangeVisualElementsWithItemId(desktopStore, pageId);
    }
  }

  const handleTitleInput = (v: string) => {
    asPageItem(desktopStore.getItem(pageId)!).title = v;
    rearrangeVisualElementsWithItemId(desktopStore, pageId);
  };

  const deletePage = async () => {
    deleted = true;
    await server.deleteItem(pageId); // throws on failure.
    desktopStore.deleteItem(pageId);
    desktopStore.setEditDialogInfo(null);
    arrange(desktopStore);
  }

  const setAspectToMatchScreen = async () => {
    asPageItem(desktopStore.getItem(pageId)!).naturalAspect = screenAspect();
    desktopStore.setEditDialogInfo({
      desktopBoundsPx: desktopStore.editDialogInfo()!.desktopBoundsPx,
      item: desktopStore.getItem(pageId)!
    });
    rearrangeVisualElementsWithItemId(desktopStore, pageId);
  }

  let checkElement_spatial_stretch: HTMLInputElement | undefined;
  let checkElement_grid: HTMLInputElement | undefined;
  let checkElement_list: HTMLInputElement | undefined;
  let checkElement_ord: HTMLInputElement | undefined;

  const changeArrangeAlgo = async () => {
    let t;
    if (checkElement_spatial_stretch?.checked) {
      t = ARRANGE_ALGO_SPATIAL_STRETCH;
    } else if (checkElement_grid?.checked) {
      t = ARRANGE_ALGO_GRID;
    } else if (checkElement_list?.checked) {
      t = ARRANGE_ALGO_LIST;
    } else {
      panic();
    }
    asPageItem(desktopStore.getItem(pageId)!).arrangeAlgorithm = t;
    rearrangeVisualElementsWithItemId(desktopStore, pageId);
  }

  const changeOrderChildrenBy = async () => {
    const orderByTitle = checkElement_ord?.checked;
    if (orderByTitle) {
      asPageItem(desktopStore.getItem(pageId)!).orderChildrenBy = "title[ASC]";
    } else {
      asPageItem(desktopStore.getItem(pageId)!).orderChildrenBy = "";
    }
    desktopStore.sortChildren(pageId);
    arrange(desktopStore);
  }

  onCleanup(() => {
    if (!deleted) {
      server.updateItem(desktopStore.getItem(pageId)!);
    }
  });

  return (
    <div class="m-1">
      <div class="text-slate-800 text-sm">Title <InfuTextInput value={props.pageItem.title} onInput={handleTitleInput} focus={true} /></div>
      <div class="text-slate-800 text-sm">Inner block width <InfuTextInput value={(props.pageItem.innerSpatialWidthGr / GRID_SIZE).toString()} onChangeOrCleanup={handleBlockWidthChange} /></div>
      <div class="text-slate-800 text-sm">Natural Aspect <InfuTextInput value={props.pageItem.naturalAspect.toString()} onChangeOrCleanup={handleNaturalAspectChange} /></div>
      <InfuButton text={screenAspect().toString()} onClick={setAspectToMatchScreen} />
      <ColorSelector item={props.pageItem} />
      <div><InfuButton text="delete" onClick={deletePage} /></div>
      <div>
        <div>
          <input name="aa" type="radio" ref={checkElement_spatial_stretch} id={ARRANGE_ALGO_SPATIAL_STRETCH} checked={props.pageItem.arrangeAlgorithm == ARRANGE_ALGO_SPATIAL_STRETCH} onClick={changeArrangeAlgo} />
          <label for={ARRANGE_ALGO_SPATIAL_STRETCH}>spatial</label>
        </div>
        <div>
          <input name="aa" type="radio" ref={checkElement_grid} id={ARRANGE_ALGO_GRID} checked={props.pageItem.arrangeAlgorithm == ARRANGE_ALGO_GRID} onClick={changeArrangeAlgo} />
          <label for={ARRANGE_ALGO_GRID}>grid</label>
        </div>
        <div>
          <input name="aa" type="radio" ref={checkElement_list} id={ARRANGE_ALGO_LIST} checked={props.pageItem.arrangeAlgorithm == ARRANGE_ALGO_LIST} onClick={changeArrangeAlgo} />
          <label for={ARRANGE_ALGO_LIST}>list</label>
        </div>
      </div>
      <div>
        <input id="ord" name="ord" type="checkbox" ref={checkElement_ord} checked={props.pageItem.orderChildrenBy == "title[ASC]"} onClick={changeOrderChildrenBy} />
        <label for="ord">order by title</label>
      </div>
      <div class="text-slate-800 text-sm"> <InfuTextInput value={props.pageItem.gridNumberOfColumns.toString()} onChangeOrCleanup={handleGridNumberOfColumnsChange} /></div>
      <div>Num children: {props.pageItem.computed_children.length}</div>
    </div>
  );
}
