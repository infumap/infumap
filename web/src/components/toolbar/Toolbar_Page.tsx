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

import { Component, Show, createEffect } from "solid-js";
import { useStore } from "../../store/StoreProvider";
import { ArrangeAlgorithm, asPageItem } from "../../items/page-item";
import { itemState } from "../../store/ItemState";
import { InfuIconButton } from "../library/InfuIconButton";
import { InfuColorButton } from "../library/InfuColorButton";
import { panic } from "../../util/lang";
import { arrange } from "../../layout/arrange";
import { GRID_SIZE } from "../../constants";
import { server } from "../../server";
import { PermissionFlags } from "../../items/base/permission-flags-item";
import { hexToRGBA } from "../../util/color";
import { Colors } from "../../style";
import { ToolbarOverlayType } from "../../store/StoreProvider_Overlay";


export const Toolbar_Page: Component = () => {
  const store = useStore();

  let divBeforeColroSelect: HTMLInputElement | undefined;
  let widthDiv: HTMLInputElement | undefined;
  let docWidthDiv: HTMLInputElement | undefined;
  let aspectDiv: HTMLInputElement | undefined;
  let numColsDiv: HTMLInputElement | undefined;

  const pageItem = () => asPageItem(itemState.get(store.getToolbarFocus()!.itemId)!);

  const handleChangeAlgorithm = () => {
    let newAA;
    if (pageItem().arrangeAlgorithm == ArrangeAlgorithm.SpatialStretch) { newAA = ArrangeAlgorithm.Grid; }
    else if (pageItem().arrangeAlgorithm == ArrangeAlgorithm.Grid) { newAA = ArrangeAlgorithm.Justified; }
    else if (pageItem().arrangeAlgorithm == ArrangeAlgorithm.Justified) { newAA = ArrangeAlgorithm.List; }
    else if (pageItem().arrangeAlgorithm == ArrangeAlgorithm.List) { newAA = ArrangeAlgorithm.Document; }
    else if (pageItem().arrangeAlgorithm == ArrangeAlgorithm.Document) { newAA = ArrangeAlgorithm.SpatialStretch; }
    else { panic("unexpected arrange algorithm " + pageItem().arrangeAlgorithm); }
    pageItem().arrangeAlgorithm = newAA;
    itemState.sortChildren(pageItem().id);
    arrange(store);
    store.rerenderToolbar();
    server.updateItem(pageItem());
  };

  // force rerender when color selector closes.
  createEffect(() => {
    store.rerenderToolbar();
  });

  const arrangeAlgoText = () => {
    store.rerenderToolbarDependency();
    const aa = pageItem().arrangeAlgorithm;
    if (aa == ArrangeAlgorithm.SpatialStretch) { return "spatial"; }
    if (aa == ArrangeAlgorithm.Document) { return "document"; }
    if (aa == ArrangeAlgorithm.Grid) { return "grid"; }
    if (aa == ArrangeAlgorithm.List) { return "list"; }
    if (aa == ArrangeAlgorithm.Justified) { return "justified"; }
    panic("unexpected arrange algorithm " + aa);
  }

  const isSortedByTitle = () => {
    store.rerenderToolbarDependency();
    return pageItem().orderChildrenBy == "title[ASC]";
  }

  const isPublic= () => {
    store.rerenderToolbarDependency();
    return !(!(pageItem().permissionFlags & PermissionFlags.Public));
  }

  const showOrderByButton = () => {
    store.rerenderToolbarDependency();
    return pageItem().arrangeAlgorithm == ArrangeAlgorithm.List ||
           pageItem().arrangeAlgorithm == ArrangeAlgorithm.Grid ||
           pageItem().arrangeAlgorithm == ArrangeAlgorithm.Justified;
  }

  const showGridButtons = () => {
    store.rerenderToolbarDependency();
    return pageItem().arrangeAlgorithm == ArrangeAlgorithm.Grid;
  }

  const showJustifiedButtons = () => {
    store.rerenderToolbarDependency();
    return pageItem().arrangeAlgorithm == ArrangeAlgorithm.Justified;
  }

  const showDocumentButtons = () => {
    store.rerenderToolbarDependency();
    return pageItem().arrangeAlgorithm == ArrangeAlgorithm.Document;
  }

  const showInnerBlockWidthButton = () => {
    store.rerenderToolbarDependency();
    return pageItem().arrangeAlgorithm == ArrangeAlgorithm.SpatialStretch;
  }

  const showEmptyTrash = () => {
    store.rerenderToolbarDependency();
    if (store.user.getUserMaybe() == null) { return false; }
    return (pageItem().id == store.user.getUser().trashPageId);
  }

  const showMakePublicButton = () => {
    store.rerenderToolbarDependency();
    if (store.user.getUserMaybe() == null) { return false; }
    return (pageItem().id != store.user.getUser().trashPageId && pageItem().id != store.user.getUser().dockPageId);
  }

  const colorNumber = () => {
    store.rerenderToolbarDependency();
    return pageItem().backgroundColorIndex;
  }

  const widthText = () => {
    store.rerenderToolbarDependency();
    return pageItem().innerSpatialWidthGr / GRID_SIZE;
  }

  const docWidthBlText = () => {
    store.rerenderToolbarDependency();
    return pageItem().docWidthBl;
  }

  const aspectText = () => {
    store.rerenderToolbarDependency();
    return Math.round(pageItem().naturalAspect * 1000.0) / 1000.0;
  }

  const cellAspectText = () => {
    store.rerenderToolbarDependency();
    return Math.round(pageItem().gridCellAspect * 1000.0) / 1000.0;
  }

  const justifiedAspectText = () => {
    store.rerenderToolbarDependency();
    return Math.round(pageItem().justifiedRowAspect * 1000.0) / 1000.0;
  }

  const numColsText = () => {
    store.rerenderToolbarDependency();
    return pageItem().gridNumberOfColumns;
  }

  const handleOrderChildrenBy = async () => {
    const orderByTitle = pageItem().orderChildrenBy;
    if (orderByTitle == "") {
      pageItem().orderChildrenBy = "title[ASC]";
    } else {
      pageItem().orderChildrenBy = "";
    }
    itemState.sortChildren(pageItem().id);
    arrange(store);
    server.updateItem(pageItem());
    store.rerenderToolbar();
  }

  const handleChangePermissions = () => {
    if (pageItem().permissionFlags & PermissionFlags.Public) {
      pageItem().permissionFlags &= ~PermissionFlags.Public;
    } else {
      pageItem().permissionFlags |= PermissionFlags.Public;
    }
    arrange(store);
    server.updateItem(pageItem());
    store.rerenderToolbar();
  }

  const emptyTrashHandler = () => {
    server.emptyTrash().then(r => {
      console.log(r);
    })
  };

  const handleColorClick = () => {
    store.overlay.toolbarOverlayInfoMaybe.set(
      { topLeftPx: { x: divBeforeColroSelect!.getBoundingClientRect().x, y: divBeforeColroSelect!.getBoundingClientRect().y + 16 }, type: ToolbarOverlayType.PageColor });
  };

  const handleAspectClick = () => {
    store.overlay.toolbarOverlayInfoMaybe.set(
      { topLeftPx: { x: aspectDiv!.getBoundingClientRect().x, y: aspectDiv!.getBoundingClientRect().y + 30 }, type: ToolbarOverlayType.PageAspect });
  };

  const handleCellAspectClick = () => {
    // store.overlay.pageAspectOverlayInfoMaybe.set(
    //   { topLeftPx: { x: aspectDiv!.getBoundingClientRect().x, y: aspectDiv!.getBoundingClientRect().y + 30 } });
  };

  const handleJustifiedAspectClick = () => {
    // store.overlay.pageAspectOverlayInfoMaybe.set(
    //   { topLeftPx: { x: aspectDiv!.getBoundingClientRect().x, y: aspectDiv!.getBoundingClientRect().y + 30 } });
  };

  const handleWidthClick = () => {
    store.overlay.toolbarOverlayInfoMaybe.set(
      { topLeftPx: { x: widthDiv!.getBoundingClientRect().x, y: widthDiv!.getBoundingClientRect().y + 30 }, type: ToolbarOverlayType.PageWidth });
  };

  const handleDocWidthBlClick = () => {
    store.overlay.toolbarOverlayInfoMaybe.set(
      { topLeftPx: { x: docWidthDiv!.getBoundingClientRect().x, y: docWidthDiv!.getBoundingClientRect().y + 30 }, type: ToolbarOverlayType.PageDocWidth });
  };

  const handleNumColsClick = () => {
    store.overlay.toolbarOverlayInfoMaybe.set(
      { topLeftPx: { x: numColsDiv!.getBoundingClientRect().x, y: numColsDiv!.getBoundingClientRect().y + 30 }, type: ToolbarOverlayType.PageNumCols });
  };

  const subTitleColor = () => {
    // item state has no solid-js signals.
    // as a bit of a hack, change in title/color is signalled by re-setting this instead.
    store.overlay.toolbarOverlayInfoMaybe.get();
    return `${hexToRGBA(Colors[pageItem().backgroundColorIndex], 1.0)}; `;
  };

  return (
    <div class="inline-block p-[4px] flex-grow-0">
      <Show when={store.getToolbarFocus().itemId != store.history.currentPage()!.itemId }>
        <div class="font-bold inline-block" style={`color: ${subTitleColor()}`}>
          {pageItem().title}
        </div>
      </Show>
      <div class="inline-block w-[70px] border border-slate-400 text-center rounded-md ml-[10px]" style={`font-size: 13px;`}>
        {arrangeAlgoText()}
      </div>
      <InfuIconButton icon="fa fa-refresh" highlighted={false} clickHandler={handleChangeAlgorithm} />
      <div ref={divBeforeColroSelect} class="inline-block ml-[7px]"></div>
      <div class="inline-block h-[22px] align-middle">
        <InfuColorButton col={colorNumber()} onClick={handleColorClick} />
      </div>
      <Show when={showInnerBlockWidthButton()}>
        <div ref={widthDiv} class="inline-block ml-[10px]" style={`font-size: 13px;`} onClick={handleWidthClick}>
          <i class="bi-arrows" /> <span style={`font-size: 13px;`}>{widthText()}</span>
        </div>
      </Show>
      <div ref={aspectDiv} class="inline-block ml-[10px] align-middle" onClick={handleAspectClick}>
        <i class="bi-aspect-ratio" /> <span style={`font-size: 13px;`}>{aspectText()}</span>
      </div>
      <Show when={showGridButtons()}>
        <div ref={aspectDiv} class="inline-block ml-[10px] align-middle" onClick={handleCellAspectClick}>
          <i class="bi-aspect-ratio" /> <span style={`font-size: 13px;`}>{cellAspectText()}</span>
        </div>
        <div ref={numColsDiv} class="inline-block ml-[10px] align-middle" onClick={handleNumColsClick}>
          <i class="bi-layout-three-columns" /> <span style={`font-size: 13px;`}>{numColsText()}</span>
        </div>
      </Show>
      <Show when={showJustifiedButtons()}>
        <div ref={aspectDiv} class="inline-block ml-[10px] align-middle" onClick={handleJustifiedAspectClick}>
          <i class="bi-aspect-ratio" /> <span style={`font-size: 13px;`}>{justifiedAspectText()}</span>
        </div>
      </Show>
      <Show when={showDocumentButtons()}>
        <div ref={docWidthDiv} class="inline-block ml-[10px]" style={`font-size: 13px;`} onClick={handleDocWidthBlClick}>
          <i class="bi-arrows" /> <span style={`font-size: 13px;`}>{docWidthBlText()}</span>
        </div>
      </Show>
      <Show when={showOrderByButton()}>
        <InfuIconButton icon="bi-sort-alpha-down" highlighted={isSortedByTitle()} clickHandler={handleOrderChildrenBy} />
      </Show>
      <Show when={showMakePublicButton()}>
        <InfuIconButton icon="bi-globe-americas" highlighted={isPublic()} clickHandler={handleChangePermissions} />
      </Show>
      <Show when={showEmptyTrash()}>
        <div class="inline-block w-[100px] border border-slate-400 text-center rounded-md ml-[10px] cursor-pointer"
             style={`font-size: 13px;`}
             onClick={emptyTrashHandler}>
          empty trash
        </div>
      </Show>
    </div>
  );
}
