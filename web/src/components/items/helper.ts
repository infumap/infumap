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

import { ArrangeAlgorithm, asPageItem, isPage } from "../../items/page-item";
import { RelationshipToParent } from "../../layout/relationship-to-parent";
import { VeFns, VisualElement } from "../../layout/visual-element";
import { edit_inputListener, edit_keyDownHandler, edit_keyUpHandler } from "../../input/edit";
import { isArrowKey } from "../../input/key";
import { itemState } from "../../store/ItemState";
import { StoreContextModel } from "../../store/StoreProvider";
import { cloneBoundingBox } from "../../util/geometry";


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

export const scrollGestureStyleForArrangeAlgorithm = (arrangeAlgorithm: ArrangeAlgorithm): string => {
  if (arrangeAlgorithm != ArrangeAlgorithm.Grid && arrangeAlgorithm != ArrangeAlgorithm.Justified) {
    return "";
  }
  return "overscroll-behavior: contain; touch-action: pan-x pan-y; ";
}

export const isInsideDocumentPage = (veFn: () => VisualElement): boolean => {
  let currentPath = veFn().parentPath;

  while (currentPath) {
    const parentItem = itemState.get(VeFns.veidFromPath(currentPath).itemId);
    if (parentItem && isPage(parentItem) && asPageItem(parentItem).arrangeAlgorithm == ArrangeAlgorithm.Document) {
      return true;
    }
    currentPath = VeFns.parentPath(currentPath);
  }

  return false;
}

export const shouldShowFocusRingForVisualElement = (
  store: StoreContextModel,
  veFn: () => VisualElement,
): boolean => {
  const textEditInfo = store.overlay.textEditInfo();
  if (textEditInfo == null || textEditInfo.itemPath != VeFns.veToPath(veFn())) {
    return true;
  }
  return !isInsideDocumentPage(veFn);
}

// Use the item's existing top-level DOM node as its stack root when possible.
// This avoids introducing extra wrapper DOM around desktop items, which helps keep
// contentEditable/caret behavior predictable while still allowing local stacking.
export const desktopStackRootStyle = (visualElement: VisualElement): string => {
  return `${VeFns.opacityStyle(visualElement)} ${VeFns.zIndexStyle(visualElement)} isolation: isolate;`;
}

export const createPageTitleEditHandlers = (
  store: StoreContextModel,
  veFn: () => VisualElement,
  onEscapeMaybe?: () => void,
) => {
  const vePath = () => VeFns.veToPath(veFn());

  const exitTitleEdit = () => {
    store.overlay.setTextEditInfo(store.history, null, true);
    onEscapeMaybe?.();
  };

  return {
    isEditingTitle: () => store.overlay.textEditInfo()?.itemPath == vePath(),
    titleKeyDownHandler: (ev: KeyboardEvent) => {
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
