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
import { useStore } from "../../../store/StoreProvider";
import { ArrangeAlgorithm, asPageItem } from "../../../items/page-item";
import { itemState } from "../../../store/ItemState";
import { InfuIconButton } from "../../library/InfuIconButton";
import { InfuColorButton } from "../../library/InfuColorButton";
import { panic } from "../../../util/lang";
import { fullArrange } from "../../../layout/arrange";
import { GRID_SIZE } from "../../../constants";
import { server, serverOrRemote } from "../../../server";
import { PermissionFlags } from "../../../items/base/permission-flags-item";
import { ToolbarPopupType } from "../../../store/StoreProvider_Overlay";
import { PageFlags } from "../../../items/base/flags-item";
import { ClickState } from "../../../input/state";


export const Toolbar_Page: Component = () => {
  const store = useStore();

  let divBeforeColorSelect: HTMLDivElement | undefined;
  let colorSelectDiv: HTMLDivElement | undefined;
  let widthDiv: HTMLDivElement | undefined;
  let docWidthDiv: HTMLDivElement | undefined;
  let aspectDiv: HTMLDivElement | undefined;
  let cellAspectDiv: HTMLDivElement | undefined;
  let arrangeAlgoDiv: HTMLDivElement | undefined;
  let justifiedRowAspectDiv: HTMLDivElement | undefined;
  let numColsDiv: HTMLDivElement | undefined;
  let qrDiv: HTMLDivElement | undefined;

  const pageItem = () => asPageItem(store.history.getFocusItem());

  // Arrange Algorithm
  const handleArrangeAlgoClick = () => {
    if (store.overlay.toolbarPopupInfoMaybe.get() != null && store.overlay.toolbarPopupInfoMaybe.get()!.type == ToolbarPopupType.PageArrangeAlgorithm) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      return;
    }
    store.overlay.toolbarPopupInfoMaybe.set(
      { topLeftPx: { x: arrangeAlgoDiv!.getBoundingClientRect().x, y: arrangeAlgoDiv!.getBoundingClientRect().y + 35 }, type: ToolbarPopupType.PageArrangeAlgorithm });
  };
  const handleArrangeAlgoDown = () => {
    ClickState.setButtonClickBoundsPx(arrangeAlgoDiv!.getBoundingClientRect());
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
    fullArrange(store);
    serverOrRemote.updateItem(pageItem(), store.general.networkStatus);
    store.touchToolbar();
  }

  const handleChangePermissions = () => {
    if (pageItem().permissionFlags & PermissionFlags.Public) {
      pageItem().permissionFlags &= ~PermissionFlags.Public;
    } else {
      pageItem().permissionFlags |= PermissionFlags.Public;
    }
    fullArrange(store);
    serverOrRemote.updateItem(pageItem(), store.general.networkStatus);
    store.touchToolbar();
  }

  const handleChangeInteractive = () => {
    if (pageItem().flags & PageFlags.EmbeddedInteractive) {
      pageItem().flags &= ~PageFlags.EmbeddedInteractive
    } else {
      pageItem().flags |= PageFlags.EmbeddedInteractive;
    }
    fullArrange(store);
    serverOrRemote.updateItem(pageItem(), store.general.networkStatus);
    store.touchToolbar();
  }

  const emptyTrashHandler = () => {
    server.emptyTrash(store.general.networkStatus).then(r => {
      console.debug(r);
    })
  };

  // Color
  const handleColorClick = () => {
    if (store.overlay.toolbarPopupInfoMaybe.get() != null && store.overlay.toolbarPopupInfoMaybe.get()!.type == ToolbarPopupType.PageColor) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      return;
    }
    store.overlay.toolbarPopupInfoMaybe.set(
      { topLeftPx: { x: divBeforeColorSelect!.getBoundingClientRect().x + 8, y: divBeforeColorSelect!.getBoundingClientRect().y + 19 }, type: ToolbarPopupType.PageColor });
  };
  const handleColorDown = () => {
    ClickState.setButtonClickBoundsPx(colorSelectDiv!.getBoundingClientRect());
  };

  // Aspect
  const handleAspectClick = () => {
    if (store.overlay.toolbarPopupInfoMaybe.get() != null && store.overlay.toolbarPopupInfoMaybe.get()!.type == ToolbarPopupType.PageAspect) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      return;
    }
    store.overlay.toolbarPopupInfoMaybe.set(
      { topLeftPx: { x: aspectDiv!.getBoundingClientRect().x, y: aspectDiv!.getBoundingClientRect().y + 35 }, type: ToolbarPopupType.PageAspect });
  };
  const handleAspectDown = () => {
    ClickState.setButtonClickBoundsPx(aspectDiv!.getBoundingClientRect());
  };

  // Cell Aspect
  const handleCellAspectClick = () => {
    if (store.overlay.toolbarPopupInfoMaybe.get() != null && store.overlay.toolbarPopupInfoMaybe.get()!.type == ToolbarPopupType.PageCellAspect) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      return;
    }
    store.overlay.toolbarPopupInfoMaybe.set(
      { topLeftPx: { x: cellAspectDiv!.getBoundingClientRect().x, y: cellAspectDiv!.getBoundingClientRect().y + 35 }, type: ToolbarPopupType.PageCellAspect });
  };
  const handleCellAspectDown = () => {
    ClickState.setButtonClickBoundsPx(cellAspectDiv!.getBoundingClientRect());
  };

  // Justified Row Aspect
  const handleJustifiedRowAspectClick = () => {
    if (store.overlay.toolbarPopupInfoMaybe.get() != null && store.overlay.toolbarPopupInfoMaybe.get()!.type == ToolbarPopupType.PageJustifiedRowAspect) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      return;
    }
    store.overlay.toolbarPopupInfoMaybe.set(
      { topLeftPx: { x: justifiedRowAspectDiv!.getBoundingClientRect().x, y: justifiedRowAspectDiv!.getBoundingClientRect().y + 35 }, type: ToolbarPopupType.PageJustifiedRowAspect });
  };
  const handleJustifiedRowAspectDown = () => {
    ClickState.setButtonClickBoundsPx(justifiedRowAspectDiv!.getBoundingClientRect());
  };

  // Width
  const handleWidthClick = () => {
    if (store.overlay.toolbarPopupInfoMaybe.get() != null && store.overlay.toolbarPopupInfoMaybe.get()!.type == ToolbarPopupType.PageWidth) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      return;
    }
    store.overlay.toolbarPopupInfoMaybe.set(
      { topLeftPx: { x: widthDiv!.getBoundingClientRect().x, y: widthDiv!.getBoundingClientRect().y + 35 }, type: ToolbarPopupType.PageWidth });
  };
  const handleWidthDown = () => {
    ClickState.setButtonClickBoundsPx(widthDiv!.getBoundingClientRect());
  };

  // Doc Width Bl
  const handleDocWidthBlClick = () => {
    if (store.overlay.toolbarPopupInfoMaybe.get() != null && store.overlay.toolbarPopupInfoMaybe.get()!.type == ToolbarPopupType.PageDocWidth) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      return;
    }
    store.overlay.toolbarPopupInfoMaybe.set(
      { topLeftPx: { x: docWidthDiv!.getBoundingClientRect().x, y: docWidthDiv!.getBoundingClientRect().y + 35 }, type: ToolbarPopupType.PageDocWidth });
  };
  const handlePageDocWidthDown = () => {
    ClickState.setButtonClickBoundsPx(docWidthDiv!.getBoundingClientRect());
  };

  // Num Cols
  const handleNumColsClick = () => {
    if (store.overlay.toolbarPopupInfoMaybe.get() != null && store.overlay.toolbarPopupInfoMaybe.get()!.type == ToolbarPopupType.PageNumCols) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      return;
    }
    store.overlay.toolbarPopupInfoMaybe.set(
      { topLeftPx: { x: numColsDiv!.getBoundingClientRect().x, y: numColsDiv!.getBoundingClientRect().y + 35 }, type: ToolbarPopupType.PageNumCols });
  };
  const handleNumColsDown = () => {
    ClickState.setButtonClickBoundsPx(numColsDiv!.getBoundingClientRect());
  };

  // QR
  const handleQr = () => {
    if (store.overlay.toolbarPopupInfoMaybe.get() != null && store.overlay.toolbarPopupInfoMaybe.get()!.type == ToolbarPopupType.QrLink) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      return;
    }
    store.overlay.toolbarPopupInfoMaybe.set(
      { topLeftPx: { x: qrDiv!.getBoundingClientRect().x, y: qrDiv!.getBoundingClientRect().y + 38 }, type: ToolbarPopupType.QrLink });
  }
  const handleQrDown = () => {
    ClickState.setButtonClickBoundsPx(qrDiv!.getBoundingClientRect());
  };


  const handleCopyId = () => {
    navigator.clipboard.writeText(pageItem().id);
    store.overlay.toolbarTransientMessage.set("page id → clipboard");
    setTimeout(() => { store.overlay.toolbarTransientMessage.set(null); }, 1000);
  }

  return (
    <div id="toolbarItemOptionsDiv"
         class="flex-grow-0" style="flex-order: 0;">
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
             onClick={handleWidthClick}
             onMouseDown={handleWidthDown}>
          <i class="bi-arrows ml-[4px]" />
          <div class="inline-block w-[30px] pl-[6px] text-right">
            {widthText()}
          </div>
        </div>
      </Show>
      <div ref={aspectDiv}
           class="inline-block w-[65px] border border-slate-400 rounded-md ml-[10px] hover:bg-slate-300 cursor-pointer"
           style={`font-size: 13px;`}
           onClick={handleAspectClick}
           onMouseDown={handleAspectDown}>
        <i class="bi-aspect-ratio ml-[4px]" />
        <div class="inline-block w-[40px] pl-[6px] text-right">
          {aspectText()}
        </div>
      </div>
      <Show when={showGridButtons()}>
        <div ref={cellAspectDiv}
             class="inline-block w-[65px] border border-slate-400 rounded-md ml-[10px] hover:bg-slate-300 cursor-pointer"
             style={`font-size: 13px;`}
             onClick={handleCellAspectClick}
             onMouseDown={handleCellAspectDown}>
          <i class="bi-aspect-ratio ml-[4px]" />
          <div class="inline-block w-[40px] pl-[6px] text-right">
            {cellAspectText()}
          </div>
        </div>
        <div ref={numColsDiv}
             class="inline-block w-[45px] border border-slate-400 rounded-md ml-[10px] hover:bg-slate-300 cursor-pointer"
             style={`font-size: 13px;`}
             onClick={handleNumColsClick}
             onMouseDown={handleNumColsDown}>
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
             onClick={handleJustifiedRowAspectClick}
             onMouseDown={handleJustifiedRowAspectDown}>
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
             onClick={handleDocWidthBlClick}
             onMouseDown={handlePageDocWidthDown}>
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
      <div ref={arrangeAlgoDiv}
           class="inline-block w-[76px] border border-slate-400 rounded-md ml-[10px] cursor-pointer"
           style={`font-size: 13px;`}>
        <div class="inline-block w-[74px] pl-[6px] hover:bg-slate-300"
             onClick={handleArrangeAlgoClick}
             onMouseDown={handleArrangeAlgoDown}>
          {arrangeAlgoText()}
        </div>
      </div>
      <div ref={divBeforeColorSelect} class="inline-block ml-[0px]" />
      <div ref={colorSelectDiv} class="inline-block h-[22px] mt-[2px] ml-[12px] mr-[4px] align-middle" onMouseDown={handleColorDown}>
        <InfuColorButton col={colorNumber()} onClick={handleColorClick} />
      </div>
      <Show when={showMakePublicButton()}>
        <InfuIconButton icon="bi-globe-americas" highlighted={isPublic()} clickHandler={handleChangePermissions} />
      </Show>
      <InfuIconButton icon="bi-mouse2" highlighted={isInteractive()} clickHandler={handleChangeInteractive} />
  
      {/* spacer line. TODO (LOW): don't use fixed layout for this. */}
      <div class="fixed border-r border-slate-300" style="height: 25px; right: 151px; top: 7px;"></div>

      <div ref={qrDiv} class="inline-block pl-[16px]" onMouseDown={handleQrDown}>
        <InfuIconButton icon="bi-qr-code" highlighted={false} clickHandler={handleQr} />
      </div>
      <div class="inline-block">
        <InfuIconButton icon="fa fa-hashtag" highlighted={false} clickHandler={handleCopyId} />
      </div>

    </div>
  );
}
