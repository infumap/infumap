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

import { toolbarPopupTopPx } from "../toolbarPopupStyle";
import { Component, Show, createEffect } from "solid-js";
import { itemCanEdit } from "../../../items/base/capabilities-item";
import { useStore } from "../../../store/StoreProvider";
import { ArrangeAlgorithm, PageFns, asPageItem, pageUsesEmbeddedInteractiveMode } from "../../../items/page-item";
import { itemState } from "../../../store/ItemState";
import { InfuIconButton } from "../../library/InfuIconButton";
import { InfuColorButton } from "../../library/InfuColorButton";
import { panic } from "../../../util/lang";
import { requestArrange } from "../../../layout/arrange";
import { server, serverOrRemote } from "../../../server";
import { PermissionFlags } from "../../../items/base/permission-flags-item";
import { ToolbarPopupType } from "../../../store/StoreProvider_Overlay";
import { getPageCalendarDisplayMode, PageCalendarDisplayMode, PageFlags } from "../../../items/base/flags-item";
import { ClickState } from "../../../input/state";
import { TransientMessageType } from "../../../store/StoreProvider_Overlay";
import { ItemType } from "../../../items/base/item";
import { isChatTextItem, isVirtualTextDocumentPage, openTextItemFileInNewTab, persistVirtualTextDocumentPageOptions, sourceTextItemForVirtualTextDocumentPage } from "../../../items/text-document";
import { continuePersistedChat } from "../../../items/query";
import { Toolbar_ItemOrdering } from "./Toolbar_ItemOrdering";
import { Toolbar_InfoAndId } from "./Toolbar_InfoAndId";
import { VeFns, VisualElementFlags } from "../../../layout/visual-element";
import { VesCache } from "../../../layout/ves-cache";
import { getToolbarFocusItem, getToolbarFocusPathMaybe } from "../toolbarFocus";
import { Toolbar_MoreActions } from "./Toolbar_MoreActions";
import { Toolbar_SortOrder } from "./Toolbar_SortOrder";
import { cellShapeLabel } from "../toolbarCellShape";
import { roundAspect } from "../toolbarDialog";
import { justifiedRowSizeWord } from "../Toolbar_PageJustifiedLayoutPopup";
import { TOOLBAR_INFO_DIVIDER_RIGHT_PX, TOOLBAR_INFO_DIVIDER_WITH_EXTRA_BUTTON_RIGHT_PX } from "../toolbarDividers";


const columnsText = (n: number): string => `${n} col${n == 1 ? "" : "s"}`;

export const Toolbar_Page: Component = () => {
  const store = useStore();

  let divBeforeColorSelect: HTMLDivElement | undefined;
  let colorSelectDiv: HTMLDivElement | undefined;
  let sizeDiv: HTMLDivElement | undefined;
  let documentLayoutDiv: HTMLDivElement | undefined;
  let aspectDiv: HTMLDivElement | undefined;
  let catalogLayoutDiv: HTMLDivElement | undefined;
  let pageShapeDiv: HTMLDivElement | undefined;
  let gridLayoutDiv: HTMLDivElement | undefined;
  let arrangeAlgoDiv: HTMLDivElement | undefined;
  let calendarDisplayModeDiv: HTMLDivElement | undefined;
  let justifiedLayoutDiv: HTMLDivElement | undefined;
  let tableLayoutDiv: HTMLDivElement | undefined;
  let openTextFileDiv: HTMLDivElement | undefined;
  let continueChatDiv: HTMLDivElement | undefined;

  const pageItem = () => asPageItem(getToolbarFocusItem(store));
  const canEdit = () => itemCanEdit(pageItem());
  const isQueriesPage = () => {
    store.touchToolbarDependency();
    const userMaybe = store.user.getUserMaybe();
    return userMaybe != null && pageItem().id == userMaybe.queriesPageId;
  };

  // Arrange Algorithm
  const handleArrangeAlgoClick = () => {
    if (isQueriesPage()) {
      return;
    }
    if (store.overlay.toolbarPopupInfoMaybe.get() != null && store.overlay.toolbarPopupInfoMaybe.get()!.type == ToolbarPopupType.PageArrangeAlgorithm) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      return;
    }
    store.overlay.toolbarPopupInfoMaybe.set(
      { topLeftPx: { x: arrangeAlgoDiv!.getBoundingClientRect().x, y: toolbarPopupTopPx(store) }, type: ToolbarPopupType.PageArrangeAlgorithm });
  };
  const handleArrangeAlgoDown = () => {
    if (isQueriesPage()) {
      return;
    }
    ClickState.setButtonClickBoundsPx(arrangeAlgoDiv!.getBoundingClientRect());
  };

  const handleCalendarDisplayModeClick = () => {
    if (store.overlay.toolbarPopupInfoMaybe.get() != null && store.overlay.toolbarPopupInfoMaybe.get()!.type == ToolbarPopupType.PageCalendarDisplayMode) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      return;
    }
    store.overlay.toolbarPopupInfoMaybe.set(
      { topLeftPx: { x: calendarDisplayModeDiv!.getBoundingClientRect().x, y: toolbarPopupTopPx(store) }, type: ToolbarPopupType.PageCalendarDisplayMode });
  };
  const handleCalendarDisplayModeDown = () => {
    ClickState.setButtonClickBoundsPx(calendarDisplayModeDiv!.getBoundingClientRect());
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
    if (aa == ArrangeAlgorithm.Catalog) { return "catalog"; }
    if (aa == ArrangeAlgorithm.List) { return "list"; }
    if (aa == ArrangeAlgorithm.Table) { return "table"; }
    if (aa == ArrangeAlgorithm.Justified) { return "justified"; }
    if (aa == ArrangeAlgorithm.SingleCell) { return "single-cell"; }
    if (aa == ArrangeAlgorithm.Calendar) { return "calendar"; }
    panic("unexpected arrange algorithm " + aa);
  }

  const calendarDisplayModeText = () => {
    store.touchToolbarDependency();
    const displayMode = getPageCalendarDisplayMode(pageItem());
    if (displayMode == PageCalendarDisplayMode.Month) { return "Month"; }
    if (displayMode == PageCalendarDisplayMode.Quarter) { return "Quarter"; }
    if (displayMode == PageCalendarDisplayMode.HalfYear) { return "Half-Year"; }
    if (displayMode == PageCalendarDisplayMode.Year) { return "Year"; }
    return "Auto";
  }

  const isPublic = () => {
    store.touchToolbarDependency();
    return !(!(pageItem().permissionFlags & PermissionFlags.Public));
  }

  const isInteractive = () => {
    store.touchToolbarDependency();
    return pageUsesEmbeddedInteractiveMode(pageItem());
  }

  const focusIsInDock = () => {
    store.touchToolbarDependency();
    const userMaybe = store.user.getUserMaybe();
    let path = store.history.getFocusPathMaybe();
    if (!userMaybe || path == null) {
      return false;
    }
    while (path != "") {
      if (VeFns.itemIdFromPath(path) == userMaybe.dockPageId) {
        return true;
      }
      path = VeFns.parentPath(path);
    }
    return false;
  }

  const focusIsInsideTable = () => {
    store.touchToolbarDependency();
    const focusPath = getToolbarFocusPathMaybe(store);
    const focusVe = focusPath == null ? null : VesCache.current.readNode(focusPath);
    return !!focusVe && !!(focusVe.flags & VisualElementFlags.InsideTable);
  }

  const showInteractiveButton = () => {
    store.touchToolbarDependency();
    return pageItem().arrangeAlgorithm != ArrangeAlgorithm.Calendar &&
      !isQueriesPage() && !focusIsInDock() && !focusIsInsideTable();
  }

  const showOrderByButton = () => {
    store.touchToolbarDependency();
    return pageItem().arrangeAlgorithm == ArrangeAlgorithm.List ||
      pageItem().arrangeAlgorithm == ArrangeAlgorithm.Table ||
      pageItem().arrangeAlgorithm == ArrangeAlgorithm.Grid ||
      pageItem().arrangeAlgorithm == ArrangeAlgorithm.Catalog ||
      pageItem().arrangeAlgorithm == ArrangeAlgorithm.Justified;
  }

  // List and calendar pages only have their aspect to set here, which only applies where they are shown in something
  // else: a list's column is resized on the page, and a calendar's view has its own menu.
  const showPageShapeButton = () => {
    store.touchToolbarDependency();
    return pageItem().arrangeAlgorithm == ArrangeAlgorithm.List || pageItem().arrangeAlgorithm == ArrangeAlgorithm.Calendar;
  }

  // Catalog pages set their preview shape and their aspect (which only applies where they are shown in something
  // else) together in one dialog.
  const showCatalogLayoutButton = () => {
    store.touchToolbarDependency();
    return pageItem().arrangeAlgorithm == ArrangeAlgorithm.Catalog;
  }

  // Grid pages set columns, cell shape and their aspect (which only applies where they are shown in something
  // else) together in one dialog.
  const showGridLayoutButton = () => {
    store.touchToolbarDependency();
    return pageItem().arrangeAlgorithm == ArrangeAlgorithm.Grid;
  }

  // Table pages set their columns and their aspect (which only applies where they are shown in something else)
  // together in one dialog. Column headings and wrapping are toggles of their own.
  const showTableButtons = () => {
    store.touchToolbarDependency();
    return pageItem().arrangeAlgorithm == ArrangeAlgorithm.Table;
  }

  const showTableHeader = () => {
    store.touchToolbarDependency();
    return !!(pageItem().flags & PageFlags.ShowTableColHeader);
  }

  const handleToggleTableHeader = () => {
    // Hiding the headings while one is being edited would leave the edit with nothing to edit.
    if ((pageItem().flags & PageFlags.ShowTableColHeader) &&
      store.overlay.textEditInfo()?.itemType == ItemType.Page &&
      store.overlay.textEditInfo()?.itemPath == getToolbarFocusPathMaybe(store) &&
      store.overlay.textEditInfo()?.colNum != null) {
      store.overlay.setTextEditInfo(store.history, null, true);
    }
    pageItem().flags ^= PageFlags.ShowTableColHeader;
    requestArrange(store, "toolbar-page-table-header-visibility");
    serverOrRemote.updateItem(pageItem());
    store.touchToolbar();
  }

  const tableWrapRows = () => {
    store.touchToolbarDependency();
    return !!(pageItem().flags & PageFlags.TableWrapRows);
  }

  const handleToggleTableWrapRows = () => {
    pageItem().flags ^= PageFlags.TableWrapRows;
    requestArrange(store, "toolbar-page-table-wrap-rows");
    serverOrRemote.updateItem(pageItem());
    store.touchToolbar();
  }

  // Justified pages set their row height and their aspect (which only applies where they are shown in something
  // else) together in one dialog.
  const showJustifiedLayoutButton = () => {
    store.touchToolbarDependency();
    return pageItem().arrangeAlgorithm == ArrangeAlgorithm.Justified;
  }

  const showCalendarButtons = () => {
    store.touchToolbarDependency();
    return pageItem().arrangeAlgorithm == ArrangeAlgorithm.Calendar;
  }

  const showDocumentButtons = () => {
    store.touchToolbarDependency();
    return pageItem().arrangeAlgorithm == ArrangeAlgorithm.Document;
  }

  const showVirtualDocumentButtons = () => {
    store.touchToolbarDependency();
    return isVirtualTextDocumentPage(pageItem().id) && pageItem().arrangeAlgorithm == ArrangeAlgorithm.Document;
  }

  // Spatial pages have a width in blocks as well as an aspect, set together in one dialog.
  const showPageSizeButton = () => {
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

  const sizeText = () => {
    store.touchToolbarDependency();
    const sizeBl = PageFns.calcInnerSpatialDimensionsBl(pageItem());
    return `${sizeBl.w} × ${sizeBl.h}`;
  }

  const documentLayoutText = () => {
    store.touchToolbarDependency();
    return `${pageItem().docWidthBl} wide`;
  }

  const showTitleInDocument = () => {
    store.touchToolbarDependency();
    return !(pageItem().flags & PageFlags.HideDocumentTitle);
  }

  const showTitleInEmbeddedInteractive = () => {
    store.touchToolbarDependency();
    return !(pageItem().flags & PageFlags.HideEmbeddedInteractiveTitle);
  }

  const aspectText = () => {
    store.touchToolbarDependency();
    return Math.round(pageItem().naturalAspect * 1000.0) / 1000.0;
  }

  const pageShapeText = () => {
    store.touchToolbarDependency();
    return roundAspect(pageItem().naturalAspect);
  }

  const catalogLayoutText = () => {
    store.touchToolbarDependency();
    return cellShapeLabel(pageItem().gridCellAspect);
  }

  const justifiedLayoutText = () => {
    store.touchToolbarDependency();
    return `${justifiedRowSizeWord(pageItem().justifiedRowAspect)} rows`;
  }

  const gridLayoutText = () => {
    store.touchToolbarDependency();
    return `${columnsText(pageItem().gridNumberOfColumns)} · ${cellShapeLabel(pageItem().gridCellAspect)}`;
  }

  const tableLayoutText = () => {
    store.touchToolbarDependency();
    return columnsText(pageItem().numberOfVisibleColumns);
  }

  const handleChangePermissions = () => {
    if (pageItem().permissionFlags & PermissionFlags.Public) {
      pageItem().permissionFlags &= ~PermissionFlags.Public;
    } else {
      pageItem().permissionFlags |= PermissionFlags.Public;
    }
    requestArrange(store, "toolbar-page-permissions");
    serverOrRemote.updateItem(pageItem());
    store.touchToolbar();
  }

  const handleChangeInteractive = () => {
    if (pageItem().flags & PageFlags.EmbeddedInteractive) {
      pageItem().flags &= ~PageFlags.EmbeddedInteractive
    } else {
      pageItem().flags |= PageFlags.EmbeddedInteractive;
    }
    requestArrange(store, "toolbar-page-interactive");
    serverOrRemote.updateItem(pageItem());
    store.touchToolbar();
  }

  const handleToggleDocumentTitle = () => {
    if (!(pageItem().flags & PageFlags.HideDocumentTitle) &&
      store.overlay.textEditInfo()?.itemType == ItemType.Page &&
      store.overlay.textEditInfo()?.itemPath == store.history.getFocusPathMaybe()) {
      store.overlay.setTextEditInfo(store.history, null, true);
    }
    if (pageItem().flags & PageFlags.HideDocumentTitle) {
      pageItem().flags &= ~PageFlags.HideDocumentTitle;
    } else {
      pageItem().flags |= PageFlags.HideDocumentTitle;
    }
    requestArrange(store, "toolbar-page-toggle-document-title");
    if (isVirtualTextDocumentPage(pageItem().id)) {
      persistVirtualTextDocumentPageOptions(store, pageItem());
    } else {
      serverOrRemote.updateItem(pageItem());
    }
    store.touchToolbar();
  }

  const handleToggleEmbeddedInteractiveTitle = () => {
    if (!(pageItem().flags & PageFlags.HideEmbeddedInteractiveTitle) &&
      store.overlay.textEditInfo()?.itemType == ItemType.Page &&
      store.overlay.textEditInfo()?.itemPath == store.history.getFocusPathMaybe()) {
      store.overlay.setTextEditInfo(store.history, null, true);
    }
    if (pageItem().flags & PageFlags.HideEmbeddedInteractiveTitle) {
      pageItem().flags &= ~PageFlags.HideEmbeddedInteractiveTitle;
    } else {
      pageItem().flags |= PageFlags.HideEmbeddedInteractiveTitle;
    }
    requestArrange(store, "toolbar-page-toggle-embedded-interactive-title");
    serverOrRemote.updateItem(pageItem());
    store.touchToolbar();
  }

  const emptyTrashHandler = async () => {
    store.overlay.emptyTrashInProgress.set(true);
    try {
      const r = await server.emptyTrash();
      console.debug(r);

      // Remove deleted items from client-side state. This includes items loaded
      // individually as link targets, which would otherwise continue to be displayed.
      itemState.removeDeletedItems(r.deletedItemIds);
      const trashPageId = store.user.getUser().trashPageId;
      const trashPage = itemState.getAsContainerItem(trashPageId);
      if (trashPage) {
        trashPage.computed_children = [];
      }
      requestArrange(store, "toolbar-page-empty-trash");
    } finally {
      store.overlay.emptyTrashInProgress.set(false);
    }
  };

  // Color
  const handleColorClick = () => {
    if (store.overlay.toolbarPopupInfoMaybe.get() != null && store.overlay.toolbarPopupInfoMaybe.get()!.type == ToolbarPopupType.PageColor) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      return;
    }
    store.overlay.toolbarPopupInfoMaybe.set(
      { topLeftPx: { x: divBeforeColorSelect!.getBoundingClientRect().x + 8, y: toolbarPopupTopPx(store) }, type: ToolbarPopupType.PageColor });
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
      { topLeftPx: { x: aspectDiv!.getBoundingClientRect().x, y: toolbarPopupTopPx(store) }, type: ToolbarPopupType.PageAspect });
  };
  const handleAspectDown = () => {
    ClickState.setButtonClickBoundsPx(aspectDiv!.getBoundingClientRect());
  };

  // Page Shape
  const handlePageShapeClick = () => {
    if (store.overlay.toolbarPopupInfoMaybe.get() != null && store.overlay.toolbarPopupInfoMaybe.get()!.type == ToolbarPopupType.PageShape) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      return;
    }
    store.overlay.toolbarPopupInfoMaybe.set(
      { topLeftPx: { x: pageShapeDiv!.getBoundingClientRect().x, y: toolbarPopupTopPx(store) }, type: ToolbarPopupType.PageShape });
  };
  const handlePageShapeDown = () => {
    ClickState.setButtonClickBoundsPx(pageShapeDiv!.getBoundingClientRect());
  };

  // Catalog Layout
  const handleCatalogLayoutClick = () => {
    if (store.overlay.toolbarPopupInfoMaybe.get() != null && store.overlay.toolbarPopupInfoMaybe.get()!.type == ToolbarPopupType.PageCatalogLayout) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      return;
    }
    store.overlay.toolbarPopupInfoMaybe.set(
      { topLeftPx: { x: catalogLayoutDiv!.getBoundingClientRect().x, y: toolbarPopupTopPx(store) }, type: ToolbarPopupType.PageCatalogLayout });
  };
  const handleCatalogLayoutDown = () => {
    ClickState.setButtonClickBoundsPx(catalogLayoutDiv!.getBoundingClientRect());
  };

  // Justified Layout
  const handleJustifiedLayoutClick = () => {
    if (store.overlay.toolbarPopupInfoMaybe.get() != null && store.overlay.toolbarPopupInfoMaybe.get()!.type == ToolbarPopupType.PageJustifiedLayout) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      return;
    }
    store.overlay.toolbarPopupInfoMaybe.set(
      { topLeftPx: { x: justifiedLayoutDiv!.getBoundingClientRect().x, y: toolbarPopupTopPx(store) }, type: ToolbarPopupType.PageJustifiedLayout });
  };
  const handleJustifiedLayoutDown = () => {
    ClickState.setButtonClickBoundsPx(justifiedLayoutDiv!.getBoundingClientRect());
  };

  // Size
  const handleSizeClick = () => {
    if (store.overlay.toolbarPopupInfoMaybe.get() != null && store.overlay.toolbarPopupInfoMaybe.get()!.type == ToolbarPopupType.PageSize) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      return;
    }
    store.overlay.toolbarPopupInfoMaybe.set(
      { topLeftPx: { x: sizeDiv!.getBoundingClientRect().x, y: toolbarPopupTopPx(store) }, type: ToolbarPopupType.PageSize });
  };
  const handleSizeDown = () => {
    ClickState.setButtonClickBoundsPx(sizeDiv!.getBoundingClientRect());
  };

  // Document Layout
  const handleDocumentLayoutClick = () => {
    if (store.overlay.toolbarPopupInfoMaybe.get() != null && store.overlay.toolbarPopupInfoMaybe.get()!.type == ToolbarPopupType.PageDocumentLayout) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      return;
    }
    store.overlay.toolbarPopupInfoMaybe.set(
      { topLeftPx: { x: documentLayoutDiv!.getBoundingClientRect().x, y: toolbarPopupTopPx(store) }, type: ToolbarPopupType.PageDocumentLayout });
  };
  const handleDocumentLayoutDown = () => {
    ClickState.setButtonClickBoundsPx(documentLayoutDiv!.getBoundingClientRect());
  };

  // Grid Layout
  const handleGridLayoutClick = () => {
    if (store.overlay.toolbarPopupInfoMaybe.get() != null && store.overlay.toolbarPopupInfoMaybe.get()!.type == ToolbarPopupType.PageGridLayout) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      return;
    }
    store.overlay.toolbarPopupInfoMaybe.set(
      { topLeftPx: { x: gridLayoutDiv!.getBoundingClientRect().x, y: toolbarPopupTopPx(store) }, type: ToolbarPopupType.PageGridLayout });
  };
  const handleGridLayoutDown = () => {
    ClickState.setButtonClickBoundsPx(gridLayoutDiv!.getBoundingClientRect());
  };

  // Table Layout
  const handleTableLayoutClick = () => {
    if (store.overlay.toolbarPopupInfoMaybe.get()?.type == ToolbarPopupType.PageTableLayout) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      return;
    }
    store.overlay.toolbarPopupInfoMaybe.set(
      { topLeftPx: { x: tableLayoutDiv!.getBoundingClientRect().x, y: toolbarPopupTopPx(store) }, type: ToolbarPopupType.PageTableLayout });
  };
  const handleTableLayoutDown = () => {
    ClickState.setButtonClickBoundsPx(tableLayoutDiv!.getBoundingClientRect());
  };

  const handleOpenTextFile = () => {
    const sourceTextItem = sourceTextItemForVirtualTextDocumentPage(pageItem().id);
    if (sourceTextItem == null) {
      store.overlay.toolbarTransientMessage.set({ text: "could not open text file", type: TransientMessageType.Error });
      setTimeout(() => { store.overlay.toolbarTransientMessage.set(null); }, 1500);
      return;
    }
    openTextItemFileInNewTab(store, sourceTextItem);
  }
  const handleOpenTextFileDown = () => {
    ClickState.setButtonClickBoundsPx(openTextFileDiv!.getBoundingClientRect());
  };

  /** The persisted chat this page shows, if it is the document page of a `.chat` item on this server. */
  const sourceChatItem = () => {
    store.touchToolbarDependency();
    const source = sourceTextItemForVirtualTextDocumentPage(pageItem().id);
    return source != null && isChatTextItem(source) && source.origin == null ? source : null;
  };
  const handleContinueChat = () => {
    const source = sourceChatItem();
    if (source == null) { return; }
    void continuePersistedChat(store, source.id, false).catch(e => {
      const text = e instanceof Error ? e.message : "could not continue the chat";
      store.overlay.toolbarTransientMessage.set({ text, type: TransientMessageType.Error });
      setTimeout(() => { store.overlay.toolbarTransientMessage.set(null); }, 5000);
    });
  };
  const handleContinueChatDown = () => {
    ClickState.setButtonClickBoundsPx(continueChatDiv!.getBoundingClientRect());
  };


  // Document pages set their text width and their aspect (which only applies where they are shown in something else)
  // together in one dialog. Showing the title is a toggle of its own. Also shown for the document pages of text files.
  const documentControls = () => (
    <>
      <div class="inline-block ml-[10px]">
        <InfuIconButton icon="bi-type-h1" highlighted={showTitleInDocument()} clickHandler={handleToggleDocumentTitle} title="Show document title" />
      </div>
      <div ref={documentLayoutDiv}
        class="inline-block border border-slate-400 rounded-md ml-[10px] px-[5px] hover:bg-slate-300 cursor-pointer whitespace-nowrap"
        style={`font-size: 13px;`}
        title="Document layout"
        onClick={handleDocumentLayoutClick}
        onMouseDown={handleDocumentLayoutDown}>
        <i class="bi-file-text" />
        <span class="pl-[6px]">{documentLayoutText()}</span>
      </div>
    </>
  );

  const infoDividerRightPx = () => showVirtualDocumentButtons() ? TOOLBAR_INFO_DIVIDER_WITH_EXTRA_BUTTON_RIGHT_PX : TOOLBAR_INFO_DIVIDER_RIGHT_PX;

  return (
    <div id="toolbarItemOptionsDiv"
      class="grow-0" style="flex-order: 0;">
      <Show when={showEmptyTrash()}>
        <div class="inline-block w-[100px] border border-slate-400 text-center rounded-md ml-[10px] cursor-pointer"
          style={`font-size: 13px;`}
          title="Permanently delete everything in the trash"
          onClick={emptyTrashHandler}>
          empty trash
        </div>
      </Show>
      <Show when={showVirtualDocumentButtons()}>
        {documentControls()}
      </Show>
      <Show when={canEdit()}>
        <Show when={showPageSizeButton()}>
          <div ref={sizeDiv}
            class="inline-block border border-slate-400 rounded-md ml-[10px] px-[5px] hover:bg-slate-300 cursor-pointer whitespace-nowrap"
            style={`font-size: 13px;`}
            title="Page size"
            onClick={handleSizeClick}
            onMouseDown={handleSizeDown}>
            <i class="bi-aspect-ratio" />
            <span class="pl-[6px]">{sizeText()}</span>
          </div>
        </Show>
        <Show when={showGridLayoutButton()}>
          <div ref={gridLayoutDiv}
            class="inline-block border border-slate-400 rounded-md ml-[10px] px-[5px] hover:bg-slate-300 cursor-pointer whitespace-nowrap"
            style={`font-size: 13px;`}
            title="Grid layout"
            onClick={handleGridLayoutClick}
            onMouseDown={handleGridLayoutDown}>
            <i class="bi-grid-3x3-gap" />
            <span class="pl-[6px]">{gridLayoutText()}</span>
          </div>
        </Show>
        <Show when={showPageShapeButton()}>
          <div ref={pageShapeDiv}
            class="inline-block border border-slate-400 rounded-md ml-[10px] px-[5px] hover:bg-slate-300 cursor-pointer whitespace-nowrap"
            style={`font-size: 13px;`}
            title="Page shape"
            onClick={handlePageShapeClick}
            onMouseDown={handlePageShapeDown}>
            <i class="bi-aspect-ratio" />
            <span class="pl-[6px]">{pageShapeText()}</span>
          </div>
        </Show>
        <Show when={!isQueriesPage() && !showPageSizeButton() && !showGridLayoutButton() && !showJustifiedLayoutButton() && !showCatalogLayoutButton() && !showPageShapeButton() && !showTableButtons() && !showDocumentButtons()}>
          <div ref={aspectDiv}
            class="inline-block w-[65px] border border-slate-400 rounded-md ml-[10px] hover:bg-slate-300 cursor-pointer"
            style={`font-size: 13px;`}
            title="Page aspect ratio"
            onClick={handleAspectClick}
            onMouseDown={handleAspectDown}>
            <i class="bi-aspect-ratio ml-[4px]" />
            <div class="inline-block w-[40px] pl-[6px] text-right">
              {aspectText()}
            </div>
          </div>
        </Show>
        <Show when={showCatalogLayoutButton()}>
          <div ref={catalogLayoutDiv}
            class="inline-block border border-slate-400 rounded-md ml-[10px] px-[5px] hover:bg-slate-300 cursor-pointer whitespace-nowrap"
            style={`font-size: 13px;`}
            title="Catalog layout"
            onClick={handleCatalogLayoutClick}
            onMouseDown={handleCatalogLayoutDown}>
            <i class="bi-card-list" />
            <span class="pl-[6px]">{catalogLayoutText()}</span>
          </div>
        </Show>
        <Show when={showTableButtons()}>
          <div ref={tableLayoutDiv}
            class="inline-block border border-slate-400 rounded-md ml-[10px] mr-[7px] px-[5px] hover:bg-slate-300 cursor-pointer whitespace-nowrap"
            style={`font-size: 13px;`}
            title="Table layout"
            onClick={handleTableLayoutClick}
            onMouseDown={handleTableLayoutDown}>
            <i class="bi-layout-three-columns" />
            <span class="pl-[6px]">{tableLayoutText()}</span>
          </div>
          <InfuIconButton icon="bi-table" highlighted={showTableHeader()} clickHandler={handleToggleTableHeader} title="Show column headers" />
          <InfuIconButton icon="bi-text-wrap" highlighted={tableWrapRows()} clickHandler={handleToggleTableWrapRows} title="Wrap row text" />
        </Show>
        <Show when={showJustifiedLayoutButton()}>
          <div ref={justifiedLayoutDiv}
            class="inline-block border border-slate-400 rounded-md ml-[10px] px-[5px] hover:bg-slate-300 cursor-pointer whitespace-nowrap"
            style={`font-size: 13px;`}
            title="Justified layout"
            onClick={handleJustifiedLayoutClick}
            onMouseDown={handleJustifiedLayoutDown}>
            <i class="bi-columns-gap" />
            <span class="pl-[6px]">{justifiedLayoutText()}</span>
          </div>
        </Show>
        <Show when={showCalendarButtons()}>
          <div ref={calendarDisplayModeDiv}
            class="inline-block w-[88px] border border-slate-400 rounded-md ml-[10px] cursor-pointer"
            style={`font-size: 13px;`}>
            <div class="inline-block w-[86px] pl-[6px] hover:bg-slate-300"
              title="Calendar view"
              onClick={handleCalendarDisplayModeClick}
              onMouseDown={handleCalendarDisplayModeDown}>
              {calendarDisplayModeText()}
            </div>
          </div>
        </Show>
        <Show when={showDocumentButtons()}>
          {documentControls()}
        </Show>
        <Show when={showOrderByButton()}>
          {/* On a table page this follows the heading and wrap toggles, so is spaced as one more icon in their run. */}
          <div class={`inline-block ${showTableButtons() ? "ml-[3px]" : "ml-[10px]"}`}>
            <Toolbar_SortOrder />
          </div>
        </Show>
        <Show when={!isQueriesPage()}>
          <div ref={arrangeAlgoDiv}
            class="inline-block w-[76px] border border-slate-400 rounded-md ml-[10px] cursor-pointer"
            style={`font-size: 13px;`}>
            <div class="inline-block w-[74px] pl-[6px] hover:bg-slate-300"
              title="Arrangement"
              onClick={handleArrangeAlgoClick}
              onMouseDown={handleArrangeAlgoDown}>
              {arrangeAlgoText()}
            </div>
          </div>
        </Show>
        <Show when={!isQueriesPage()}>
          <div ref={divBeforeColorSelect} class="inline-block ml-0" />
          <div ref={colorSelectDiv} class="inline-block h-[22px] mt-[2px] ml-[12px] mr-[4px] align-middle" onMouseDown={handleColorDown}>
            <InfuColorButton col={colorNumber()} onClick={handleColorClick} title="Page color" />
          </div>
        </Show>
        <Show when={showMakePublicButton()}>
          <InfuIconButton icon="bi-globe-americas" highlighted={isPublic()} clickHandler={handleChangePermissions} title="Public" />
        </Show>
        <Show when={showInteractiveButton()}>
          <Show when={isInteractive() && pageItem().arrangeAlgorithm != ArrangeAlgorithm.Document}>
            <InfuIconButton
              icon="bi-type"
              highlighted={showTitleInEmbeddedInteractive()}
              clickHandler={handleToggleEmbeddedInteractiveTitle}
              title="Show embedded title" />
          </Show>
          <InfuIconButton icon="bi-mouse2" highlighted={isInteractive()} clickHandler={handleChangeInteractive} title="Interactive when embedded" />
        </Show>
      </Show>

      <Show when={sourceChatItem() != null}>
        <div ref={continueChatDiv} class="inline-block ml-[5px]" onMouseDown={handleContinueChatDown}>
          <InfuIconButton icon="fa fa-comments" highlighted={false} clickHandler={handleContinueChat} title="Continue chat" />
        </div>
      </Show>

      <Toolbar_MoreActions />

      <Toolbar_ItemOrdering />

      {/* spacer line. TODO (LOW): don't use fixed layout for this. */}
      <div class="fixed border-r border-slate-300" style={`height: 25px; right: ${infoDividerRightPx()}px; top: 7px;`}></div>

      <Show when={showVirtualDocumentButtons()}>
        <div ref={openTextFileDiv} class="inline-block pl-[16px]" onMouseDown={handleOpenTextFileDown}>
          <InfuIconButton icon="fa fa-download" highlighted={false} clickHandler={handleOpenTextFile} title="Open text file" />
        </div>
      </Show>
      <Toolbar_InfoAndId infoClass={showVirtualDocumentButtons() ? "inline-block" : "inline-block pl-[16px]"} />

    </div>
  );
}
