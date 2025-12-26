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

import { Component, For, Match, Show, Switch } from "solid-js";

import { VesCache } from "../../layout/ves-cache";
import { ArrangeAlgorithm, asPageItem, isPage } from "../../items/page-item";
import { ATTACH_AREA_SIZE_PX, COMPOSITE_MOVE_OUT_AREA_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_SIZE_PX, GRID_SIZE, LINE_HEIGHT_PX, LIST_PAGE_TOP_PADDING_PX } from "../../constants";
import { useStore } from "../../store/StoreProvider";
import { VisualElementProps } from "../VisualElement";
import { HitboxFlags } from "../../layout/hitbox";
import { BoundingBox, zeroBoundingBoxTopLeft } from "../../util/geometry";
import { itemState } from "../../store/ItemState";
import { VisualElementFlags, VeFns, VisualElement } from "../../layout/visual-element";
import { PermissionFlags } from "../../items/base/permission-flags-item";
import { isComposite } from "../../items/composite-item";
import { Page_Opaque } from "./Page_Opaque";
import { Page_Trash } from "./Page_Trash";
import { Page_Translucent } from "./Page_Translucent";
import { Page_Root } from "./Page_Root";
import { Page_EmbeddedInteractive } from "./Page_EmbeddedInteractive";
import { Page_Umbrella } from "./Page_Umbrella";
import { Page_Dock } from "./Page_Dock";
import { Page_Popup } from "./Page_Popup";
import { Page_FlipCard } from "./Page_FlipCard";
import { ItemFns } from "../../items/base/item-polymorphism";
import { asContainerItem } from "../../items/base/container-item";
import createJustifiedLayout from "justified-layout";
import { createJustifyOptions } from "../../layout/arrange/page_justified";


// REMINDER: it is not valid to access VesCache in the item components (will result in heisenbugs)

export interface PageVisualElementProps {
  visualElement: VisualElement,
  pageFns: any
}

export const Page_Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  const pageFns = {
    pageItem: () => asPageItem(props.visualElement.displayItem),

    isPublic: () => pageFns.pageItem().permissionFlags != PermissionFlags.None,

    vePath: () => VeFns.veToPath(props.visualElement),

    parentPage: () => {
      const parentId = VeFns.itemIdFromPath(props.visualElement.parentPath!);
      const parent = itemState.get(parentId)!;
      if (isPage(parent)) {
        return asPageItem(parent);
      }
      return null;
    },

    parentPageArrangeAlgorithm: () => {
      const pp = pageFns.parentPage();
      if (!pp) { return ArrangeAlgorithm.None; }
      return pp.arrangeAlgorithm;
    },

    boundsPx: () => props.visualElement.boundsPx,

    attachCompositeBoundsPx: (): BoundingBox => {
      return {
        x: 0,
        y: pageFns.boundsPx().h - 1,
        w: pageFns.boundsPx().w - 2,
        h: 1,
      }
    },

    viewportBoundsPx: () => props.visualElement.viewportBoundsPx!,

    innerBoundsPx: () => {
      let r = zeroBoundingBoxTopLeft(props.visualElement.boundsPx);
      r.w = r.w - 2;
      r.h = r.h - 2;
      return r;
    },

    childAreaBoundsPx: () => props.visualElement.childAreaBoundsPx!,

    clickBoundsPx: (): BoundingBox | null => props.visualElement.hitboxes.find(hb => hb.type == HitboxFlags.Click || hb.type == HitboxFlags.OpenAttachment)!.boundsPx,

    popupClickBoundsPx: (): BoundingBox | null => props.visualElement.hitboxes.find(hb => hb.type == HitboxFlags.OpenPopup)!.boundsPx,

    hasPopupClickBoundsPx: (): boolean => props.visualElement.hitboxes.find(hb => hb.type == HitboxFlags.OpenPopup) != undefined,

    attachBoundsPx: (): BoundingBox => {
      return {
        x: pageFns.boundsPx().w - ATTACH_AREA_SIZE_PX - 2,
        y: 0,
        w: ATTACH_AREA_SIZE_PX,
        h: ATTACH_AREA_SIZE_PX,
      }
    },

    attachInsertBarPx: (): BoundingBox => {
      const innerSizeBl = ItemFns.calcSpatialDimensionsBl(props.visualElement.displayItem);
      const blockSizePx = pageFns.boundsPx().w / innerSizeBl.w;
      const insertIndex = store.perVe.getMoveOverAttachmentIndex(pageFns.vePath());
      // Special case for position 0: align with right edge of parent item
      const xOffset = insertIndex === 0 ? -4 : -2;
      return {
        x: pageFns.boundsPx().w - insertIndex * blockSizePx + xOffset,
        y: -blockSizePx / 2,
        w: 4,
        h: blockSizePx,
      };
    },

    moveOutOfCompositeBox: (): BoundingBox => {
      return ({
        x: pageFns.boundsPx().w - COMPOSITE_MOVE_OUT_AREA_SIZE_PX - COMPOSITE_MOVE_OUT_AREA_MARGIN_PX - 2,
        y: COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
        w: COMPOSITE_MOVE_OUT_AREA_SIZE_PX,
        h: pageFns.boundsPx().h - (COMPOSITE_MOVE_OUT_AREA_MARGIN_PX * 2),
      });
    },

    isPoppedUp: () =>
      store.history.currentPopupSpecVeid() != null &&
      VeFns.compareVeids(VeFns.actualVeidFromVe(props.visualElement), store.history.currentPopupSpecVeid()!) == 0,

    isInComposite: () =>
      isComposite(itemState.get(VeFns.veidFromPath(props.visualElement.parentPath!).itemId)),

    isDocumentPage: () =>
      pageFns.pageItem().arrangeAlgorithm == ArrangeAlgorithm.Document,

    showMoveOutOfCompositeArea: () =>
      store.user.getUserMaybe() != null &&
      store.perVe.getMouseIsOver(pageFns.vePath()) &&
      !store.anItemIsMoving.get() &&
      store.overlay.textEditInfo() == null &&
      pageFns.isInComposite(),

    lineChildren: () => VesCache.getChildrenVes(VeFns.veToPath(props.visualElement))().filter(c => c.get().flags & VisualElementFlags.LineItem),

    desktopChildren: () => VesCache.getChildrenVes(VeFns.veToPath(props.visualElement))().filter(c => !(c.get().flags & VisualElementFlags.LineItem)),


    showTriangleDetail: () => (pageFns.boundsPx().w / (pageFns.pageItem().spatialWidthGr / GRID_SIZE)) > 0.5,

    calcTitleInBoxScale: (textSize: string) => {
      const outerDiv = document.createElement("div");
      outerDiv.setAttribute("class", "flex items-center justify-center");
      outerDiv.setAttribute("style", `width: ${pageFns.boundsPx().w}px; height: ${pageFns.boundsPx().h}px;`);
      const innerDiv = document.createElement("div");
      innerDiv.setAttribute("class", `flex items-center text-center text-${textSize} font-bold text-white`);
      outerDiv.appendChild(innerDiv);
      const txt = document.createTextNode(pageFns.pageItem().title);
      innerDiv.appendChild(txt);
      document.body.appendChild(outerDiv);
      let scale = 0.85 / Math.max(innerDiv.offsetWidth / pageFns.boundsPx().w, innerDiv.offsetHeight / pageFns.boundsPx().h); // 0.85 -> margin.
      document.body.removeChild(outerDiv);
      return scale > 1.0 ? 1.0 : scale;
    },

    listViewScale: () => {
      return props.visualElement.viewportBoundsPx!.w / store.desktopMainAreaBoundsPx().w;
    },

    listColumnWidthBl: () => {
      return asPageItem(props.visualElement.displayItem).tableColumns[0].widthGr / GRID_SIZE;
    },

    renderGridLinesMaybe: () =>
      <Show when={pageFns.pageItem().arrangeAlgorithm == ArrangeAlgorithm.Grid}>
        <For each={[...Array(pageFns.pageItem().gridNumberOfColumns).keys()]}>{i =>
          <Show when={i != 0}>
            <div class="absolute bg-slate-100"
              style={`left: ${props.visualElement.cellSizePx!.w * i}px; height: ${pageFns.childAreaBoundsPx().h}px; width: 1px; top: 0px;`} />
          </Show>
        }</For>
        <For each={[...Array(props.visualElement.numRows!).keys()]}>{i =>
          <div class="absolute bg-slate-100"
            style={`left: 0px; height: 1px; width: ${pageFns.childAreaBoundsPx().w}px; top: ${props.visualElement.cellSizePx!.h * (i + 1)}px;`} />
        }</For>
      </Show>,

    renderMoveOverAnnotationMaybe: () => {
      if (!store.perVe.getMovingItemIsOver(pageFns.vePath())) {
        return <></>;
      }
      if (store.perVe.getMovingItemIsOver(pageFns.vePath()) && pageFns.pageItem().orderChildrenBy != "") {
        return pageFns.renderMoveOverSortedMaybe();
      }
      if (store.perVe.getMovingItemIsOver(pageFns.vePath())) {
        return pageFns.renderMoveOverIndexMaybe();
      }
    },

    renderMoveOverSortedMaybe: () => {
      if (pageFns.pageItem().arrangeAlgorithm == ArrangeAlgorithm.List) {
        const topPx = 0;
        const leftPx = 0;
        const widthPx = LINE_HEIGHT_PX * pageFns.listColumnWidthBl();
        const heightPx = props.visualElement.viewportBoundsPx!.h;
        return (
          <div class="absolute pointer-events-none"
            style={`background-color: #0044ff0a; ` +
              `left: ${leftPx}px; top: ${topPx}px; ` +
              `width: ${widthPx}px; height: ${heightPx}px; ` +
              `${VeFns.zIndexStyle(props.visualElement)}`} />
        );
      } else if (pageFns.pageItem().arrangeAlgorithm == ArrangeAlgorithm.Grid ||
        pageFns.pageItem().arrangeAlgorithm == ArrangeAlgorithm.Justified) {
        const heightPx = Math.max(pageFns.childAreaBoundsPx().h, pageFns.boundsPx().h);
        return (
          <div class="absolute pointer-events-none"
            style={`background-color: #0044ff0a; ` +
              `left: ${0}px; top: ${0}px; ` +
              `width: ${pageFns.childAreaBoundsPx().w}px; height: ${heightPx}px; ` +
              `${VeFns.zIndexStyle(props.visualElement)}`} />
        );
      }
      return <></>;
    },

    renderMoveOverIndexMaybe: () => {
      if (pageFns.pageItem().arrangeAlgorithm == ArrangeAlgorithm.Grid) {
        const topPx = props.visualElement.cellSizePx!.h * Math.floor((store.perVe.getMoveOverIndex(pageFns.vePath())) / pageFns.pageItem().gridNumberOfColumns);
        const leftPx = props.visualElement.cellSizePx!.w * (store.perVe.getMoveOverIndex(pageFns.vePath()) % pageFns.pageItem().gridNumberOfColumns) + 1;
        const heightPx = props.visualElement.cellSizePx!.h;
        return (
          <div class="absolute border border-black" style={`top: ${topPx}px; left: ${leftPx}px; height: ${heightPx}px; width: 1px;`} />
        );
      } else if (pageFns.pageItem().arrangeAlgorithm == ArrangeAlgorithm.List) {
        const topPx = store.perVe.getMoveOverIndex(pageFns.vePath()) * LINE_HEIGHT_PX + LIST_PAGE_TOP_PADDING_PX;
        const leftPx = 0;
        const widthPx = LINE_HEIGHT_PX * pageFns.listColumnWidthBl();
        return (
          <div class="absolute border border-black" style={`top: ${topPx}px; left: ${leftPx}px; height: 1px; width: ${widthPx}px;`} />
        );
      } else if (pageFns.pageItem().arrangeAlgorithm == ArrangeAlgorithm.Justified) {
        return pageFns.renderJustifiedMoveOverHighlight();
      } else {
        return <></>;
      }
    },

    renderJustifiedMoveOverHighlight: () => {
      const moveOverIndex = store.perVe.getMoveOverIndex(pageFns.vePath());

      // Filter out moving items to get the non-moving visual elements
      const childrenVes = VesCache.getChildrenVes(VeFns.veToPath(props.visualElement))();
      const nonMovingChildrenVes = childrenVes.filter(childVe =>
        !(childVe.get().flags & VisualElementFlags.Moving)
      );

      if (moveOverIndex >= 0 && moveOverIndex <= nonMovingChildrenVes.length) {
        let leftPx: number;
        let topPx: number;
        let heightPx: number;

        if (moveOverIndex === 0) {
          // Inserting at the beginning
          const firstVe = nonMovingChildrenVes[0]?.get();
          if (firstVe) {
            leftPx = firstVe.boundsPx.x - 2;
            topPx = firstVe.boundsPx.y;
            heightPx = firstVe.boundsPx.h;
          } else {
            return <></>;
          }
        } else if (moveOverIndex >= nonMovingChildrenVes.length) {
          // Inserting at the end
          const lastVe = nonMovingChildrenVes[nonMovingChildrenVes.length - 1]?.get();
          if (lastVe) {
            leftPx = lastVe.boundsPx.x + lastVe.boundsPx.w + 2;
            topPx = lastVe.boundsPx.y;
            heightPx = lastVe.boundsPx.h;
          } else {
            return <></>;
          }
        } else {
          // Inserting between elements
          const prevVe = nonMovingChildrenVes[moveOverIndex - 1].get();
          const nextVe = nonMovingChildrenVes[moveOverIndex].get();
          leftPx = (prevVe.boundsPx.x + prevVe.boundsPx.w + nextVe.boundsPx.x) / 2;
          topPx = Math.min(prevVe.boundsPx.y, nextVe.boundsPx.y);
          heightPx = Math.max(prevVe.boundsPx.h, nextVe.boundsPx.h);
        }

        return (
          <div class="absolute border border-black"
            style={`left: ${leftPx}px; top: ${topPx}px; width: 1px; height: ${heightPx}px; ${VeFns.zIndexStyle(props.visualElement)}`} />
        );
      }

      return <></>;
    },
  };

  return (
    <Switch>
      <Match when={props.visualElement.flags & VisualElementFlags.UmbrellaPage}>
        <Page_Umbrella visualElement={props.visualElement} pageFns={pageFns} />
      </Match>
      <Match when={props.visualElement.flags & VisualElementFlags.FlipCardPage}>
        <Page_FlipCard visualElement={props.visualElement} pageFns={pageFns} />
      </Match>
      <Match when={props.visualElement.flags & VisualElementFlags.IsDock}>
        <Page_Dock visualElement={props.visualElement} pageFns={pageFns} />
      </Match>
      <Match when={props.visualElement.flags & VisualElementFlags.IsTrash}>
        <Page_Trash visualElement={props.visualElement} pageFns={pageFns} />
      </Match>
      <Match when={props.visualElement.flags & VisualElementFlags.Popup}>
        <Page_Popup visualElement={props.visualElement} pageFns={pageFns} />
      </Match>
      <Match when={props.visualElement.flags & VisualElementFlags.TopLevelRoot ||
        props.visualElement.flags & VisualElementFlags.ListPageRoot}>
        <Page_Root visualElement={props.visualElement} pageFns={pageFns} />
      </Match>
      <Match when={props.visualElement.flags & VisualElementFlags.EmbeddedInteractiveRoot}>
        <Page_EmbeddedInteractive visualElement={props.visualElement} pageFns={pageFns} />
      </Match>
      <Match when={!(props.visualElement.flags & VisualElementFlags.Detailed) ||
        !(props.visualElement.flags & VisualElementFlags.ShowChildren)}>
        <Page_Opaque visualElement={props.visualElement} pageFns={pageFns} />
      </Match>
      <Match when={true}>
        <Page_Translucent visualElement={props.visualElement} pageFns={pageFns} />
      </Match>
    </Switch>
  );
}
