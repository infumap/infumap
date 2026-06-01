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

import { Component, For, Show } from "solid-js";
import { GRID_SIZE, MIN_IMAGE_WIDTH_PX } from "../constants";
import { CompositeFlags, ImageFlags, NoteFlags } from "../items/base/flags-item";
import { asCompositeItem, isComposite } from "../items/composite-item";
import { isFile } from "../items/file-item";
import { asImageItem, isImage } from "../items/image-item";
import { asNoteItem, isNote } from "../items/note-item";
import { ArrangeAlgorithm, asPageItem, isPage } from "../items/page-item";
import { isPassword } from "../items/password-item";
import { isSearch } from "../items/search-item";
import { asTableItem, isTable } from "../items/table-item";
import { VisualElement, VisualElementFlags, VeFns, isVeTranslucentPage } from "../layout/visual-element";
import { VesCache } from "../layout/ves-cache";
import { itemState } from "../store/ItemState";
import { useStore } from "../store/StoreProvider";
import { BoundingBox, Vector, quantizeBoundingBox } from "../util/geometry";
import { VisualElementSignal } from "../util/signals";


const DEFAULT_OFFSET_PX: Vector = { x: 0, y: 0 };

export interface VisualElementDesktopShadowProps {
  visualElement: VisualElement,
  includeAttachments?: boolean,
  offsetPx?: Vector,
}

export interface VisualElementDesktopShadowLayerProps {
  visualElementSignals: Array<VisualElementSignal>,
}

function isSceneLevelShadowCandidate(visualElement: VisualElement): boolean {
  return !(visualElement.flags & VisualElementFlags.Moving) &&
    !(visualElement.flags & VisualElementFlags.Popup) &&
    !(visualElement.flags & VisualElementFlags.TopLevelRoot) &&
    !(visualElement.flags & VisualElementFlags.ListPageRoot) &&
    !(visualElement.flags & VisualElementFlags.EmbeddedInteractiveRoot) &&
    !(visualElement.flags & VisualElementFlags.IsDock) &&
    !(visualElement.flags & VisualElementFlags.IsTrash) &&
    !(visualElement.flags & VisualElementFlags.UmbrellaPage) &&
    !(visualElement.flags & VisualElementFlags.Attachment) &&
    !(visualElement.flags & VisualElementFlags.InsideCompositeOrDoc) &&
    !(visualElement.flags & VisualElementFlags.DockItem);
}

function offsetBoundsPx(boundsPx: BoundingBox, offsetPx: Vector): BoundingBox {
  return {
    x: boundsPx.x + offsetPx.x,
    y: boundsPx.y + offsetPx.y,
    w: boundsPx.w,
    h: boundsPx.h,
  };
}

function shadowStyle(boundsPx: BoundingBox): string {
  return `left: ${boundsPx.x}px; top: ${boundsPx.y}px; width: ${boundsPx.w}px; height: ${boundsPx.h}px; z-index: 0;`;
}

function tableBlockSizePx(visualElement: VisualElement): { w: number, h: number } {
  const tableItem = asTableItem(visualElement.displayItem);
  const spatialWidthGr = (() => {
    if (visualElement.linkItemMaybe != null) {
      const parent = itemState.get(visualElement.linkItemMaybe.parentId)!;
      if (isComposite(parent)) {
        return asCompositeItem(parent).spatialWidthGr;
      }
      return visualElement.linkItemMaybe.spatialWidthGr;
    }
    const parent = itemState.get(tableItem.parentId)!;
    if (isComposite(parent)) {
      return asCompositeItem(parent).spatialWidthGr;
    }
    return tableItem.spatialWidthGr;
  })();
  const spatialHeightGr = visualElement.linkItemMaybe?.spatialHeightGr ?? tableItem.spatialHeightGr;
  const sizeBl = { w: spatialWidthGr / GRID_SIZE, h: spatialHeightGr / GRID_SIZE };
  return {
    w: visualElement.boundsPx.w / sizeBl.w,
    h: visualElement.boundsPx.h / sizeBl.h,
  };
}

function parentPageArrangeAlgorithm(visualElement: VisualElement): ArrangeAlgorithm {
  if (visualElement.parentPath == null) {
    return ArrangeAlgorithm.None;
  }
  const parent = itemState.get(VeFns.veidFromPath(visualElement.parentPath).itemId);
  return parent != null && isPage(parent)
    ? asPageItem(parent).arrangeAlgorithm
    : ArrangeAlgorithm.None;
}

function isInsideSearchWorkspace(visualElement: VisualElement): boolean {
  const parentPath = visualElement.parentPath;
  if (parentPath == null) {
    return false;
  }
  const parentVe = VesCache.current.readNode(parentPath) ?? VesCache.render.getNode(parentPath)?.get() ?? null;
  return parentVe != null && isSearch(parentVe.displayItem);
}

function pageUsesFlatWorkspaceChrome(visualElement: VisualElement): boolean {
  return parentPageArrangeAlgorithm(visualElement) == ArrangeAlgorithm.List ||
    isInsideSearchWorkspace(visualElement);
}

export const VisualElement_DesktopShadow: Component<VisualElementDesktopShadowProps> = (props: VisualElementDesktopShadowProps) => {
  const store = useStore();
  const offsetPx = () => props.offsetPx ?? DEFAULT_OFFSET_PX;
  const boundsPx = () => offsetBoundsPx(props.visualElement.boundsPx, offsetPx());
  const vePath = () => VeFns.veToPath(props.visualElement);

  const renderOwnShadowMaybe = () => {
    if (!isSceneLevelShadowCandidate(props.visualElement)) {
      return null;
    }

    if (isNote(props.visualElement.displayItem)) {
      const noteItem = asNoteItem(props.visualElement.displayItem);
      if ((noteItem.flags & NoteFlags.HideBorder) && !store.perVe.getMouseIsOver(vePath())) {
        return null;
      }
      return <div class="absolute pointer-events-none border border-[#999] rounded-xs shadow-xl"
        style={shadowStyle(boundsPx())} />;
    }

    if (isFile(props.visualElement.displayItem)) {
      return <div class="absolute pointer-events-none border border-[#999] rounded-xs shadow-xl"
        style={shadowStyle(boundsPx())} />;
    }

    if (isPassword(props.visualElement.displayItem)) {
      return <div class="absolute pointer-events-none border border-[#999] rounded-xs shadow-xl"
        style={shadowStyle(boundsPx())} />;
    }

    if (isComposite(props.visualElement.displayItem)) {
      if (asCompositeItem(props.visualElement.displayItem).flags & CompositeFlags.HideBorder) {
        return null;
      }
      return <div class="absolute pointer-events-none border border-transparent rounded-xs shadow-xl overflow-hidden"
        style={shadowStyle(boundsPx())} />;
    }

    if (isImage(props.visualElement.displayItem)) {
      const imageItem = asImageItem(props.visualElement.displayItem);
      const isFocused = store.history.getFocusPath() === vePath();
      if (props.visualElement.boundsPx.w <= MIN_IMAGE_WIDTH_PX ||
        ((imageItem.flags & ImageFlags.HideBorder) &&
          !store.perVe.getMouseIsOver(vePath()) &&
          !isFocused)) {
        return null;
      }
      const quantizedBoundsPx = offsetBoundsPx(quantizeBoundingBox(props.visualElement.boundsPx), offsetPx());
      return <div class="absolute pointer-events-none border border-transparent rounded-xs shadow-xl"
        style={shadowStyle({
          ...quantizedBoundsPx,
          w: quantizedBoundsPx.w - 2,
          h: quantizedBoundsPx.h - 2,
        })} />;
    }

    if (isTable(props.visualElement.displayItem)) {
      const blockSizePx = tableBlockSizePx(props.visualElement);
      const tableShadowBoundsPx = {
        x: boundsPx().x,
        y: boundsPx().y + blockSizePx.h,
        w: boundsPx().w,
        h: boundsPx().h - blockSizePx.h,
      };
      return <div class="absolute pointer-events-none border border-transparent rounded-xs shadow-xl"
        style={shadowStyle(tableShadowBoundsPx)} />;
    }

    if (isPage(props.visualElement.displayItem)) {
      if (isVeTranslucentPage(props.visualElement) && pageUsesFlatWorkspaceChrome(props.visualElement)) {
        return null;
      }
      return <div class="absolute pointer-events-none border border-transparent rounded-xs shadow-xl overflow-hidden"
        style={shadowStyle(boundsPx())} />;
    }

    return null;
  };

  const attachmentOffsetPx = (): Vector => ({
    x: offsetPx().x + props.visualElement.boundsPx.x,
    y: offsetPx().y + props.visualElement.boundsPx.y,
  });

  return (
    <>
      {renderOwnShadowMaybe()}
      <Show when={props.includeAttachments}>
        <For each={VesCache.render.getAttachments(VeFns.veToPath(props.visualElement))()}>{attachment =>
          <VisualElement_DesktopShadow
            visualElement={attachment.get()}
            includeAttachments={true}
            offsetPx={attachmentOffsetPx()} />
        }</For>
      </Show>
    </>
  );
}

export const VisualElement_DesktopShadowLayer: Component<VisualElementDesktopShadowLayerProps> = (props: VisualElementDesktopShadowLayerProps) => {
  return (
    <div class="absolute pointer-events-none"
      style="left: 0px; top: 0px; width: 100%; height: 100%; z-index: 1;">
      <For each={props.visualElementSignals}>{visualElementSignal =>
        <VisualElement_DesktopShadow visualElement={visualElementSignal.get()} includeAttachments={true} />
      }</For>
    </div>
  );
}
