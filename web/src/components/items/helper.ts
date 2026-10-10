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

import { ArrangeAlgorithm } from "../../items/page-item";
import { itemCanEdit } from "../../items/base/capabilities-item";
import { RelationshipToParent } from "../../layout/relationship-to-parent";
import { isEmptyVeid, isVeTranslucentPage, VeFns, VisualElement, VisualElementFlags } from "../../layout/visual-element";
import { commitActiveTextEdit, edit_inputListener, edit_keyDownHandler, edit_keyUpHandler } from "../../input/edit";
import { isArrowKey } from "../../input/key";
import { StoreContextModel } from "../../store/StoreProvider";
import { itemState } from "../../store/ItemState";
import { BoundingBox, cloneBoundingBox } from "../../util/geometry";
import { isPage, asPageItem } from "../../items/page-item";
import { isQueryItem } from "../../items/query-item";
import { POPUP_LINK_UID } from "../../util/uid";
import { VesCache } from "../../layout/ves-cache";
import { arrangeNow } from "../../layout/arrange";
import { GRID_SIZE, PAGE_DOCUMENT_LEFT_MARGIN_BL } from "../../constants";
import { documentPageMoveOutBoxPx } from "../../layout/composite-move-out";
import { FIND_HIGHLIGHT_COLOR, SELECTION_HIGHLIGHT_COLOR } from "../../style";

const LOCAL_AUTO_MOVED_WARNING_Z_INDEX = 100;

// The visible box of an opaque page is inset within its bounds, so pages placed edge to edge are separated by a thin gap.
export const OPAQUE_PAGE_BOX_INSET_PX = 1;

export const opaquePageBoxInsetPx = (visualElement: VisualElement): number =>
  (visualElement.flags & VisualElementFlags.InsideCompositeOrDoc) ? 0 : OPAQUE_PAGE_BOX_INSET_PX;

/**
 * Style setting the corner radius (rounded-item) of items in a container that shows a page's children as a miniature of
 * the page as it appears when opened, so the radius scales down with them. widthPx is the on screen width of the
 * miniature.
 */
export const miniatureChildItemRadiusStyle = (store: StoreContextModel, widthPx: number): string =>
  `--radius-item: calc(var(--item-radius-base) * ${Math.min(1.0, widthPx / store.desktopMainAreaBoundsPx().w)});`;

/**
 * CSS corner radius of the visible box of an opaque page: the item radius (rounded-item), capped relative to size so
 * small pages do not become pills.
 */
export const opaquePageBoxRadiusCss = (widthPx: number, heightPx: number): string =>
  `min(var(--radius-item), ${Math.min(widthPx, heightPx) / 8}px)`;
const AUTO_MOVED_INTO_VIEW_BACKGROUND_IMAGE = "repeating-linear-gradient(135deg, rgba(245, 158, 11, 0.18), rgba(245, 158, 11, 0.18) 8px, rgba(251, 191, 36, 0.30) 8px, rgba(251, 191, 36, 0.30) 16px)";


export function highlightStyle(flags: VisualElementFlags): string {
  return `background-color: ${(flags & VisualElementFlags.FindHighlighted) ? FIND_HIGHLIGHT_COLOR : SELECTION_HIGHLIGHT_COLOR}; `;
}

export const createHighlightBoundsPxFn = (veFn: () => VisualElement) => {
  return (() => {
    if (veFn().displayItem.relationshipToParent == RelationshipToParent.Child &&
        veFn().tableDimensionsPx &&
        veFn().blockSizePx &&
        veFn().indentBl != null) { // not set if not in table.
      let r = cloneBoundingBox(veFn().boundsPx)!;
      r.w = veFn().tableDimensionsPx!.w - veFn().indentBl! * veFn().blockSizePx!.w;
      return r;
    }
    return veFn().boundsPx;
  })
}

export const createLineHighlightBoundsPxFn = (veFn: () => VisualElement) => {
  return (() => {
    if (veFn().displayItem.relationshipToParent == RelationshipToParent.Attachment &&
        veFn().tableDimensionsPx) { // not set if not in table.
      let r = cloneBoundingBox(veFn().boundsPx)!;
      r.x = 0;
      r.w = veFn().tableDimensionsPx!.w;
      return r;
    }
    return null;
  })
}

export const lineItemTextClippedWidthCssPx = (visualElement: VisualElement, renderedWidthPx: number, scale: number): number =>
  Math.max(0, renderedWidthPx - Math.max(0, visualElement.lineItemTextRightPaddingPx)) / Math.max(0.001, scale);

export const scrollGestureStyleForArrangeAlgorithm = (arrangeAlgorithm: ArrangeAlgorithm): string => {
  if (arrangeAlgorithm != ArrangeAlgorithm.Grid && arrangeAlgorithm != ArrangeAlgorithm.Justified) {
    return "";
  }
  return "overscroll-behavior: contain; touch-action: pan-x pan-y; ";
}

export const shouldShowFocusRingForVisualElement = (
  store: StoreContextModel,
  veFn: () => VisualElement,
): boolean => {
  if (store.printMode.get()) { return false; }
  if (store.history.focusRingIsSuppressed(VeFns.veToPath(veFn()))) { return false; }
  const currentPagePath = store.history.currentPagePath();
  if (currentPagePath && veFn().parentPath == currentPagePath) {
    const currentPage = itemState.get(VeFns.itemIdFromPath(currentPagePath));
    if (currentPage && isPage(currentPage) && asPageItem(currentPage).arrangeAlgorithm == ArrangeAlgorithm.List) {
      const selectedVeid = store.perItem.getSelectedListPageItem(VeFns.veidFromPath(currentPagePath));
      const selectedItem = isEmptyVeid(selectedVeid) ? null : itemState.get(selectedVeid.itemId);
      if (selectedItem && isQueryItem(selectedItem)) {
        return false;
      }
    }
  }
  return store.overlay.textEditInfo()?.itemPath != VeFns.veToPath(veFn());
}

export const pageIsFocusedOpenPopupSource = (
  store: StoreContextModel,
  veFn: () => VisualElement,
): boolean => {
  const popupSpec = store.history.currentPopupSpec();
  const focusPath = store.history.getFocusPathMaybe();
  if (popupSpec == null || focusPath == null) {
    return false;
  }

  const sourceActualVeid = VeFns.actualVeidFromVe(veFn());
  if (VeFns.compareVeids(sourceActualVeid, popupSpec.actualVeid) != 0) {
    return false;
  }

  const focusVeid = VeFns.veidFromPath(focusPath);
  if (focusVeid.itemId != popupSpec.actualVeid.itemId) {
    return false;
  }

  return focusVeid.linkIdMaybe == popupSpec.actualVeid.linkIdMaybe ||
    focusVeid.linkIdMaybe == POPUP_LINK_UID;
}

// Use the item's existing top-level DOM node as its stack root when possible.
// This avoids introducing extra wrapper DOM around desktop items, which helps keep
// contentEditable/caret behavior predictable while still allowing local stacking.
export const desktopStackRootStyle = (visualElement: VisualElement): string => {
  return `${VeFns.opacityStyle(visualElement)} ${VeFns.zIndexStyle(visualElement)} isolation: isolate;`;
}

// This warning now renders only inside item-local stack roots, so a high local z-index
// is safe and won't leak across neighboring items.
export const autoMovedIntoViewWarningStyle = (widthPx: number, heightPx: number): string => {
  return `left: 0px; top: 0px; width: ${widthPx}px; height: ${heightPx}px; ` +
    `border: 2px solid rgba(245, 158, 11, 0.95); ` +
    `background-image: ${AUTO_MOVED_INTO_VIEW_BACKGROUND_IMAGE}; ` +
    `box-shadow: inset 0 0 0 1px rgba(255, 251, 235, 0.8); z-index: ${LOCAL_AUTO_MOVED_WARNING_Z_INDEX};`;
}

export const autoMovedIntoViewBackgroundImage = (): string => AUTO_MOVED_INTO_VIEW_BACKGROUND_IMAGE;

/**
 * True when the visual element is rendered inside a translucent page, whose contents must not respond to the mouse.
 * Query search results and chat pages render as translucent pages but are interactive workspaces.
 */
export const isInsideTranslucentPage = (visualElement: VisualElement): boolean => {
  let parentPath = visualElement.parentPath;
  while (parentPath != null) {
    const parentVe = VesCache.render.getNode(parentPath)?.get();
    if (parentVe == null) { return false; }
    // The selected item of a list page is part of that list page.
    if (isPage(parentVe.displayItem) && !(parentVe.flags & VisualElementFlags.ListPageRoot)) {
      if (!isVeTranslucentPage(parentVe)) { return false; }
      const grandparentVe = parentVe.parentPath == null ? null : VesCache.render.getNode(parentVe.parentPath)?.get();
      return grandparentVe == null || !isQueryItem(grandparentVe.displayItem);
    }
    parentPath = parentVe.parentPath;
  }
  return false;
};

/**
 * True when the visual element is rendered (at any depth) within a popped up item, e.g. it is an item in a popped up page.
 */
export const isInsidePopup = (visualElement: VisualElement): boolean => {
  let parentPath = visualElement.parentPath;
  while (parentPath != null) {
    const parentVe = VesCache.render.getNode(parentPath)?.get();
    if (parentVe == null) { return false; }
    if (parentVe.flags & VisualElementFlags.Popup) { return true; }
    parentPath = parentVe.parentPath;
  }
  return false;
};

export const parentDocumentPageMaybe = (visualElement: VisualElement) => {
  if (!(visualElement.flags & VisualElementFlags.InsideCompositeOrDoc) || visualElement.parentPath == null) {
    return null;
  }
  const parentItem = itemState.get(VeFns.veidFromPath(visualElement.parentPath).itemId);
  if (!parentItem || !isPage(parentItem) || asPageItem(parentItem).arrangeAlgorithm != ArrangeAlgorithm.Document) {
    return null;
  }
  return asPageItem(parentItem);
}

export const effectiveFlowItemWidthGrMaybe = (visualElement: VisualElement): number | null => {
  if (!(visualElement.flags & VisualElementFlags.InsideCompositeOrDoc) ||
    visualElement.blockSizePx == null ||
    visualElement.blockSizePx.w <= 0) {
    return null;
  }
  return (visualElement.boundsPx.w / visualElement.blockSizePx.w) * GRID_SIZE;
}

export const documentPageMoveOutBoxPxMaybe = (visualElement: VisualElement): BoundingBox | null => {
  const parentPage = parentDocumentPageMaybe(visualElement);
  if (parentPage == null || visualElement.blockSizePx == null) {
    return null;
  }
  return documentPageMoveOutBoxPx(
    visualElement.boundsPx,
    visualElement.blockSizePx,
    parentPage.docWidthBl,
    PAGE_DOCUMENT_LEFT_MARGIN_BL,
  );
}

export const createPageTitleEditHandlers = (
  store: StoreContextModel,
  veFn: () => VisualElement,
  onEscapeMaybe?: () => void,
) => {
  const vePath = () => VeFns.veToPath(veFn());

  const exitTitleEdit = () => {
    commitActiveTextEdit(store, true, "page-title-escape-commit");
    onEscapeMaybe?.();
  };

  return {
    isEditingTitle: () => itemCanEdit(veFn().displayItem) && store.overlay.textEditInfo()?.itemPath == vePath(),
    titleKeyDownHandler: (ev: KeyboardEvent) => {
      if (ev.key == "Enter") {
        ev.preventDefault();
        ev.stopPropagation();
        commitActiveTextEdit(store, false, "page-title-enter-commit");
        return;
      }

      if (ev.key == "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        exitTitleEdit();
        return;
      }

      if (isArrowKey(ev.key)) {
        edit_keyDownHandler(store, veFn(), ev);
      }
    },
    titleKeyUpHandler: (ev: KeyboardEvent) => {
      edit_keyUpHandler(store, ev);
    },
    titleInputListener: (ev: InputEvent) => {
      edit_inputListener(store, ev);
    },
  };
}

function selectEditedPageLineItemMaybe(
  store: StoreContextModel,
  visualElementMaybe?: VisualElement,
): string | null {
  const textEditInfo = store.overlay.textEditInfo();
  const itemPath = visualElementMaybe ? VeFns.veToPath(visualElementMaybe) : textEditInfo?.itemPath;
  if (!itemPath) { return null; }

  const lineItemVe = visualElementMaybe ?? VesCache.current.readNode(itemPath);
  if (!lineItemVe ||
    !(lineItemVe.flags & VisualElementFlags.LineItem) ||
    !isPage(lineItemVe.displayItem)) {
    return null;
  }

  const parentPath = lineItemVe.parentPath ?? VeFns.parentPath(itemPath);
  if (!parentPath) { return null; }

  const parentVe = VesCache.current.readNode(parentPath);
  if (!parentVe ||
    (parentVe.flags & VisualElementFlags.DockItem) ||
    !isPage(parentVe.displayItem) ||
    asPageItem(parentVe.displayItem).arrangeAlgorithm != ArrangeAlgorithm.List) {
    return null;
  }

  store.perItem.setSelectedListPageItem(
    VeFns.actualVeidFromVe(parentVe),
    VeFns.veidFromVe(lineItemVe),
  );
  return parentPath;
}

function focusSelectedInnerPageMaybe(store: StoreContextModel, listPagePath: string | null): void {
  if (listPagePath == null) { return; }

  const selectedVe = VesCache.current.readSelected(listPagePath);
  if (!selectedVe || !isPage(selectedVe.displayItem)) { return; }

  store.history.setFocus(VeFns.veToPath(selectedVe));
  arrangeNow(store, "line-item-enter-focus-selected-page");
}

export const handleLineItemTitleKeyDown = (
  store: StoreContextModel,
  ev: KeyboardEvent,
  visualElementMaybe?: VisualElement,
): boolean => {
  if (ev.key == "Enter") {
    ev.preventDefault();
    ev.stopPropagation();
    const listPagePath = selectEditedPageLineItemMaybe(store, visualElementMaybe);
    if (commitActiveTextEdit(store, false, "line-item-enter-exit-edit")) {
      focusSelectedInnerPageMaybe(store, listPagePath);
    }
    return true;
  }

  if (ev.key == "Escape") {
    ev.preventDefault();
    ev.stopPropagation();
    commitActiveTextEdit(store, true, "line-item-escape-exit-edit");
    return true;
  }

  return false;
}
