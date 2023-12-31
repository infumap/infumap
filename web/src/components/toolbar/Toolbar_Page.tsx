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
import { PageFlags } from "../../items/base/flags-item";


export const Toolbar_Page: Component = () => {
  const store = useStore();

  let divBeforeColroSelect: HTMLInputElement | undefined;
  let widthDiv: HTMLInputElement | undefined;
  let docWidthDiv: HTMLInputElement | undefined;
  let aspectDiv: HTMLInputElement | undefined;
  let cellAspectDiv: HTMLInputElement | undefined;
  let justifiedRowAspectDiv: HTMLInputElement | undefined;
  let numColsDiv: HTMLInputElement | undefined;

  const pageItem = () => asPageItem(store.history.getFocusItem());

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
    store.touchToolbar();
    server.updateItem(pageItem());
  };

  // force rerender when color selector closes.
  createEffect(() => {
    store.touchToolbar();
  });

  const arrangeAlgoText = () => {
    store.touchToolbarDependency();
    const aa = pageItem().arrangeAlgorithm;
    if (aa == ArrangeAlgorithm.SpatialStretch) { return "spatial"; }
    if (aa == ArrangeAlgorithm.Document) { return "document"; }
    if (aa == ArrangeAlgorithm.Grid) { return "grid"; }
    if (aa == ArrangeAlgorithm.List) { return "list"; }
    if (aa == ArrangeAlgorithm.Justified) { return "justified"; }
    panic("unexpected arrange algorithm " + aa);
  }

  const isSortedByTitle = () => {
    store.touchToolbarDependency();
    return pageItem().orderChildrenBy == "title[ASC]";
  }

  const isPublic= () => {
    store.touchToolbarDependency();
    return !(!(pageItem().permissionFlags & PermissionFlags.Public));
  }

  const isInteractive= () => {
    store.touchToolbarDependency();
    return !(!(pageItem().flags & PageFlags.EmbeddedInteractive));
  }

  const showOrderByButton = () => {
    store.touchToolbarDependency();
    return pageItem().arrangeAlgorithm == ArrangeAlgorithm.List ||
           pageItem().arrangeAlgorithm == ArrangeAlgorithm.Grid ||
           pageItem().arrangeAlgorithm == ArrangeAlgorithm.Justified;
  }

  const showGridButtons = () => {
    store.touchToolbarDependency();
    return pageItem().arrangeAlgorithm == ArrangeAlgorithm.Grid;
  }

  const showJustifiedButtons = () => {
    store.touchToolbarDependency();
    return pageItem().arrangeAlgorithm == ArrangeAlgorithm.Justified;
  }

  const showDocumentButtons = () => {
    store.touchToolbarDependency();
    return pageItem().arrangeAlgorithm == ArrangeAlgorithm.Document;
  }

  const showInnerBlockWidthButton = () => {
    store.touchToolbarDependency();
    return pageItem().arrangeAlgorithm == ArrangeAlgorithm.SpatialStretch;
  }

  const showEmptyTrash = () => {
    store.touchToolbarDependency();
    if (store.user.getUserMaybe() == null) { return false; }
    return (pageItem().id == store.user.getUser().trashPageId);
  }

  const showMakePublicButton = () => {
    store.touchToolbarDependency();
    if (store.user.getUserMaybe() == null) { return false; }
    return (pageItem().id != store.user.getUser().trashPageId && pageItem().id != store.user.getUser().dockPageId);
  }

  const colorNumber = () => {
    store.touchToolbarDependency();
    return pageItem().backgroundColorIndex;
  }

  const widthText = () => {
    store.touchToolbarDependency();
    return pageItem().innerSpatialWidthGr / GRID_SIZE;
  }

  const docWidthBlText = () => {
    store.touchToolbarDependency();
    return pageItem().docWidthBl;
  }

  const aspectText = () => {
    store.touchToolbarDependency();
    return Math.round(pageItem().naturalAspect * 1000.0) / 1000.0;
  }

  const cellAspectText = () => {
    store.touchToolbarDependency();
    return Math.round(pageItem().gridCellAspect * 1000.0) / 1000.0;
  }

  const justifiedAspectText = () => {
    store.touchToolbarDependency();
    return Math.round(pageItem().justifiedRowAspect * 10.0) / 10.0;
  }

  const numColsText = () => {
    store.touchToolbarDependency();
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
    store.touchToolbar();
  }

  const handleChangePermissions = () => {
    if (pageItem().permissionFlags & PermissionFlags.Public) {
      pageItem().permissionFlags &= ~PermissionFlags.Public;
    } else {
      pageItem().permissionFlags |= PermissionFlags.Public;
    }
    arrange(store);
    server.updateItem(pageItem());
    store.touchToolbar();
  }

  const handleChangeInteractive = () => {
    if (pageItem().flags & PageFlags.EmbeddedInteractive) {
      pageItem().flags &= ~PageFlags.EmbeddedInteractive
    } else {
      pageItem().flags |= PageFlags.EmbeddedInteractive;
    }
    arrange(store);
    server.updateItem(pageItem());
    store.touchToolbar();
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
    store.overlay.toolbarOverlayInfoMaybe.set(
      { topLeftPx: { x: cellAspectDiv!.getBoundingClientRect().x, y: cellAspectDiv!.getBoundingClientRect().y + 30 }, type: ToolbarOverlayType.PageCellAspect });
  };

  const handleJustifiedRowAspectClick = () => {
    store.overlay.toolbarOverlayInfoMaybe.set(
      { topLeftPx: { x: justifiedRowAspectDiv!.getBoundingClientRect().x, y: justifiedRowAspectDiv!.getBoundingClientRect().y + 30 }, type: ToolbarOverlayType.PageJustifiedRowAspect });
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

  const handleQr = () => {
    store.overlay.toolbarOverlayInfoMaybe.set(
      { topLeftPx: { x: 0, y: 0 }, type: ToolbarOverlayType.Ids });
  }

  const subTitleColor = () => {
    // item state has no solid-js signals.
    // as a bit of a hack, change in title/color is signalled by re-setting this instead.
    store.overlay.toolbarOverlayInfoMaybe.get();
    return `${hexToRGBA(Colors[pageItem().backgroundColorIndex], 1.0)}; `;
  };

  return (
    <div class="flex-grow-0" style="flex-order: 0;">
      <Show when={showEmptyTrash()}>
        <div class="inline-block w-[100px] border border-slate-400 text-center rounded-md ml-[10px] cursor-pointer"
             style={`font-size: 13px;`}
             onClick={emptyTrashHandler}>
          empty trash
        </div>
      </Show>
      <Show when={showInnerBlockWidthButton()}>
        <div ref={widthDiv}
             class="inline-block w-[55px] border border-slate-400 rounded-md ml-[10px] hover:bg-slate-300 cursor-pointer"
             style={`font-size: 13px;`}
             onClick={handleWidthClick}>
          <i class="bi-arrows ml-[4px]" />
          <div class="inline-block w-[30px] pl-[6px] text-right">
            {widthText()}
          </div>
        </div>
      </Show>
      <div ref={aspectDiv}
           class="inline-block w-[65px] border border-slate-400 rounded-md ml-[10px] hover:bg-slate-300 cursor-pointer"
           style={`font-size: 13px;`}
           onClick={handleAspectClick}>
        <i class="bi-aspect-ratio ml-[4px]" />
        <div class="inline-block w-[40px] pl-[6px] text-right">
          {aspectText()}
        </div>
      </div>
      <Show when={showGridButtons()}>
        <div ref={cellAspectDiv}
             class="inline-block w-[65px] border border-slate-400 rounded-md ml-[10px] hover:bg-slate-300 cursor-pointer"
             style={`font-size: 13px;`}
             onClick={handleCellAspectClick}>
          <i class="bi-aspect-ratio ml-[4px]" />
          <div class="inline-block w-[40px] pl-[6px] text-right">
            {cellAspectText()}
          </div>
        </div>
        <div ref={numColsDiv}
             class="inline-block w-[45px] border border-slate-400 rounded-md ml-[10px] hover:bg-slate-300 cursor-pointer"
             style={`font-size: 13px;`}
             onClick={handleNumColsClick}>
          <i class="bi-layout-three-columns ml-[4px]" />
          <div class="inline-block w-[20px] pl-[6px] text-right">
            {numColsText()}
          </div>
        </div>
      </Show>
      <Show when={showJustifiedButtons()}>
        <div ref={justifiedRowAspectDiv}
             class="inline-block w-[50px] border border-slate-400 rounded-md ml-[10px] hover:bg-slate-300 cursor-pointer"
             style={`font-size: 13px;`}
             onClick={handleJustifiedRowAspectClick}>
          <i class="bi-aspect-ratio ml-[4px]" />
          <div class="inline-block w-[25px] pl-[6px] text-right">
            {justifiedAspectText()}
          </div>
        </div>
      </Show>
      <Show when={showDocumentButtons()}>
        <div ref={docWidthDiv}
             class="inline-block w-[55px] border border-slate-400 rounded-md ml-[10px] hover:bg-slate-300 cursor-pointer"
             style={`font-size: 13px;`}
             onClick={handleDocWidthBlClick}>
          <i class="bi-arrows ml-[4px]" />
          <div class="inline-block w-[30px] pl-[6px] text-right">
            {docWidthBlText()}
          </div>
        </div>
      </Show>
      <Show when={showOrderByButton()}>
        <div class="inline-block ml-[10px]">
          <InfuIconButton icon="bi-sort-alpha-down" highlighted={isSortedByTitle()} clickHandler={handleOrderChildrenBy} />
        </div>
      </Show>
      <div class="inline-block w-[95px] border border-slate-400 rounded-md ml-[10px] hover:bg-slate-300 cursor-pointer"
           style={`font-size: 13px;`}
           onClick={handleChangeAlgorithm}>
        <div class="inline-block w-[70px] pl-[6px]">
          {arrangeAlgoText()}
        </div>
        <i class="fa fa-refresh ml-[4px]" />
        {/* <InfuIconButton icon="fa fa-refresh" highlighted={false} clickHandler={handleChangeAlgorithm} /> */}
      </div>
      <div ref={divBeforeColroSelect} class="inline-block ml-[0px]" />
      <div class="inline-block h-[22px] mt-[2px] ml-[12px] mr-[4px] align-middle">
        <InfuColorButton col={colorNumber()} onClick={handleColorClick} />
      </div>
      <Show when={showMakePublicButton()}>
        <InfuIconButton icon="bi-globe-americas" highlighted={isPublic()} clickHandler={handleChangePermissions} />
      </Show>
      <InfuIconButton icon="bi-mouse2" highlighted={isInteractive()} clickHandler={handleChangeInteractive} />
      <div class="inline-block">
        <InfuIconButton icon="bi-qr-code" highlighted={false} clickHandler={handleQr} />
      </div>
    </div>
  );
}
