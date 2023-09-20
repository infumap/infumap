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

import { Component, Show, onCleanup } from "solid-js";
import { GRID_SIZE } from "../../../constants";
import { server } from "../../../server";
import { asPageItem, PageItem } from "../../../items/page-item";
import { useDesktopStore } from "../../../store/DesktopStoreProvider";
import { InfuButton } from "../../library/InfuButton";
import { InfuTextInput } from "../../library/InfuTextInput";
import { InfuColorSelector } from "../../library/InfuColorSelector";
import { ARRANGE_ALGO_GRID, ARRANGE_ALGO_LIST, ARRANGE_ALGO_SPATIAL_STRETCH, arrange } from "../../../layout/arrange";
import { panic } from "../../../util/lang";
import { itemState } from "../../../store/ItemState";
import { PermissionFlags } from "../../../items/base/permission-flags-item";


export const EditPage: Component<{pageItem: PageItem, linkedTo: boolean}> = (props: { pageItem: PageItem, linkedTo: boolean }) => {
  const desktopStore = useDesktopStore();
  let checkElement_public: HTMLInputElement | undefined;

  const screenAspect = (): number => {
    let aspect = desktopStore.desktopBoundsPx().w / desktopStore.desktopBoundsPx().h;
    return Math.round(aspect * 1000.0) / 1000.0;
  }

  const pageId = props.pageItem.id;
  let deleted = false;

  const handleBlockWidthChange = (v: string) => {
    if (!deleted) {
      asPageItem(itemState.get(pageId)!).innerSpatialWidthGr = parseInt(v) * GRID_SIZE;
      arrange(desktopStore);
    }
  };

  const handleNaturalAspectChange = async (v: string) => {
    if (!deleted) {
      asPageItem(itemState.get(pageId)!).naturalAspect = parseFloat(v);
      arrange(desktopStore);
    }
  };

  const handleGridNumberOfColumnsChange = (v: string) => {
    if (!deleted) {
      asPageItem(itemState.get(pageId)!).gridNumberOfColumns = parseInt(v);
      arrange(desktopStore);
    }
  }

  const handleTitleInput = (v: string) => {
    asPageItem(itemState.get(pageId)!).title = v;
    arrange(desktopStore);
  };

  const deletePage = async () => {
    deleted = true;
    await server.deleteItem(pageId); // throws on failure.
    itemState.delete(pageId);
    desktopStore.setEditDialogInfo(null);
    arrange(desktopStore);
  }

  const setAspectToMatchScreen = async () => {
    asPageItem(itemState.get(pageId)!).naturalAspect = screenAspect();
    desktopStore.setEditDialogInfo({
      desktopBoundsPx: desktopStore.editDialogInfo()!.desktopBoundsPx,
      item: itemState.get(pageId)!
    });
    arrange(desktopStore);
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
    asPageItem(itemState.get(pageId)!).arrangeAlgorithm = t;
    arrange(desktopStore);
  }

  const changeOrderChildrenBy = async () => {
    const orderByTitle = checkElement_ord?.checked;
    if (orderByTitle) {
      asPageItem(itemState.get(pageId)!).orderChildrenBy = "title[ASC]";
    } else {
      asPageItem(itemState.get(pageId)!).orderChildrenBy = "";
    }
    itemState.sortChildren(pageId);
    arrange(desktopStore);
  }

  onCleanup(() => {
    if (!deleted) {
      server.updateItem(itemState.get(pageId)!);
    }
  });

  const changePermissions = async () => {
    if (checkElement_public!.checked) {
      asPageItem(itemState.get(pageId)!).permissionFlags |= PermissionFlags.Public;
    } else {
      asPageItem(itemState.get(pageId)!).permissionFlags &= ~PermissionFlags.Public;
    }
    arrange(desktopStore);
  }

  return (
    <div class="m-1">
      <div class="text-slate-800 text-sm">Title <InfuTextInput value={props.pageItem.title} onInput={handleTitleInput} focus={true} /></div>
      <div class="text-slate-800 text-sm">Inner block width <InfuTextInput value={(props.pageItem.innerSpatialWidthGr / GRID_SIZE).toString()} onChangeOrCleanup={handleBlockWidthChange} /></div>
      <div class="text-slate-800 text-sm">Natural Aspect <InfuTextInput value={props.pageItem.naturalAspect.toString()} onChangeOrCleanup={handleNaturalAspectChange} /></div>
      <InfuButton text={screenAspect().toString()} onClick={setAspectToMatchScreen} />
      <InfuColorSelector item={props.pageItem} />
      <Show when={!props.linkedTo}>
        <div><InfuButton text="delete" onClick={deletePage} /></div>
      </Show>
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
      <div>
        <input id="heading" name="heading" type="checkbox" ref={checkElement_public} checked={(props.pageItem.permissionFlags & PermissionFlags.Public) == PermissionFlags.Public ? true : false} onClick={changePermissions} />
        <label for="heading">public</label>
      </div>
    </div>
  );
}
