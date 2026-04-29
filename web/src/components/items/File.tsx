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
import { FileFns, asFileItem } from "../../items/file-item";
import { itemCanEdit } from "../../items/base/capabilities-item";
import { ATTACH_AREA_SIZE_PX, COMPOSITE_MOVE_OUT_AREA_ADDITIONAL_RIGHT_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_SIZE_PX, CONTAINER_IN_COMPOSITE_PADDING_PX, FONT_SIZE_PX, GRID_SIZE, LINE_HEIGHT_PX, NOTE_PADDING_PX, Z_INDEX_LOCAL_HIGHLIGHT } from "../../constants";
import { FIND_HIGHLIGHT_COLOR, SELECTION_HIGHLIGHT_COLOR, FOCUS_RING_BOX_SHADOW } from "../../style";
import { VisualElement_Desktop, VisualElementProps } from "../VisualElement";
import { VesCache } from "../../layout/ves-cache";
import { BoundingBox } from "../../util/geometry";
import { ItemFns } from "../../items/base/item-polymorphism";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { asXSizableItem, isXSizableItem } from "../../items/base/x-sizeable-item";
import { HitboxFlags } from "../../layout/hitbox";
import { MOUSE_LEFT } from "../../input/mouse_down";
import { ClickState } from "../../input/state";
import { asPageItem, isPage } from "../../items/page-item";
import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "../../layout/arrange/page_list";
import { itemState } from "../../store/ItemState";
import { InfuLinkTriangle } from "../library/InfuLinkTriangle";
import { useStore } from "../../store/StoreProvider";
import { InfuResizeTriangle } from "../library/InfuResizeTriangle";
import { CompositeFns, isComposite } from "../../items/composite-item";
import { desktopPopupIconTextIndentPx } from "../../layout/text";
import { getCaretPosition, setCaretPosition } from "../../util/caret";
import { arrangeNow } from "../../layout/arrange";
import { appendNewlineIfEmpty, trimNewline } from "../../util/string";
import { CompositeMoveOutHandle } from "./CompositeMoveOutHandle";

import { panic } from "../../util/lang";
import { asPositionalItem } from "../../items/base/positional-item";
import { server, serverOrRemote } from "../../server";
import { RelationshipToParent } from "../../layout/relationship-to-parent";
import { newOrdering } from "../../util/ordering";
import { NoteFns } from "../../items/note-item";
import { ItemType } from "../../items/base/item";
import { asLinkItem, isLink } from "../../items/link-item";
import { autoMovedIntoViewWarningStyle, desktopStackRootStyle, shouldShowFocusRingForVisualElement } from "./helper";


// REMINDER: it is not valid to access VesCache in the item components (will result in heisenbugs)

export const File: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  const isPopup = () => !(!(props.visualElement.flags & VisualElementFlags.Popup));
  const fileItem = () => asFileItem(props.visualElement.displayItem);
  const canEdit = () => itemCanEdit(fileItem());
  const vePath = () => VeFns.veToPath(props.visualElement);
  const boundsPx = () => props.visualElement.boundsPx;
  const positionClass = () => (props.visualElement.flags & VisualElementFlags.Fixed) ? 'fixed' : 'absolute';
  const attachBoundsPx = (): BoundingBox => {
    return {
      x: boundsPx().w - ATTACH_AREA_SIZE_PX - 2,
      y: 0,
      w: ATTACH_AREA_SIZE_PX,
      h: ATTACH_AREA_SIZE_PX,
    }
  };
  const attachInsertBarPx = (): BoundingBox => {
    const innerSizeBl = sizeBl();
    const blockSizePx = boundsPx().w / innerSizeBl.w;
    const insertIndex = store.perVe.getMoveOverAttachmentIndex(vePath());
    // Special case for position 0: align with right edge of parent item
    const xOffset = insertIndex === 0 ? -4 : -2;
    return {
      x: boundsPx().w - insertIndex * blockSizePx + xOffset,
      y: -blockSizePx / 2,
      w: 4,
      h: blockSizePx,
    };
  };
  const attachCompositeBoundsPx = (): BoundingBox => {
    return {
      x: 0,
      y: boundsPx().h - 1,
      w: boundsPx().w - 2,
      h: 1,
    }
  };
  const moveOutOfCompositeBox = (): BoundingBox => {
    return ({
      x: boundsPx().w
        - COMPOSITE_MOVE_OUT_AREA_SIZE_PX
        - COMPOSITE_MOVE_OUT_AREA_MARGIN_PX
        - COMPOSITE_MOVE_OUT_AREA_ADDITIONAL_RIGHT_MARGIN_PX
        - CONTAINER_IN_COMPOSITE_PADDING_PX,
      y: COMPOSITE_MOVE_OUT_AREA_MARGIN_PX,
      w: COMPOSITE_MOVE_OUT_AREA_SIZE_PX,
      h: boundsPx().h - (COMPOSITE_MOVE_OUT_AREA_MARGIN_PX * 2),
    });
  };
  const sizeBl = () => {
    if (props.visualElement.flags & VisualElementFlags.InsideCompositeOrDoc) {
      const cloned = FileFns.asFileMeasurable(ItemFns.cloneMeasurableFields(props.visualElement.displayItem));
      const parentVeid = VeFns.veidFromPath(props.visualElement.parentPath!);
      const parentDisplayItem = itemState.get(parentVeid.itemId)!;

      let parentTreeItem = VeFns.treeItemFromVeid(parentVeid);
      if (parentTreeItem == null) {
        // case where link is virtual (not in itemState). happens in list selected page case.
        parentTreeItem = itemState.get(parentVeid.itemId)!;
      }

      if (isPage(parentDisplayItem)) {
        cloned.spatialWidthGr = asPageItem(parentDisplayItem).docWidthBl * GRID_SIZE;
      } else {
        cloned.spatialWidthGr = isXSizableItem(parentTreeItem)
          ? asXSizableItem(parentTreeItem).spatialWidthGr
          : isLink(parentTreeItem)
            ? asLinkItem(parentTreeItem).spatialWidthGr
            : panic(`File sizeBl: parentTreeItem has unexpected type: ${parentTreeItem.itemType}`);
      }
      return ItemFns.calcSpatialDimensionsBl(cloned);
    }
    if (props.visualElement.linkItemMaybe != null) {
      return ItemFns.calcSpatialDimensionsBl(props.visualElement.linkItemMaybe!);
    }
    return FileFns.calcSpatialDimensionsBl(fileItem());
  };
  const naturalWidthPx = () => sizeBl().w * LINE_HEIGHT_PX - NOTE_PADDING_PX * 2;
  const naturalHeightPx = () => sizeBl().h * LINE_HEIGHT_PX;
  const widthScale = () => (boundsPx().w - NOTE_PADDING_PX * 2) / naturalWidthPx();
  const heightScale = () => (boundsPx().h - NOTE_PADDING_PX * 2 + (LINE_HEIGHT_PX - FONT_SIZE_PX)) / naturalHeightPx();
  const textBlockScale = () => widthScale();
  const lineHeightScale = () => heightScale() / widthScale();
  const showTriangleDetail = () => (boundsPx().h / naturalHeightPx()) > 0.5;
  const hasPopupHandle = () => props.visualElement.hitboxes.some(hb => !!(hb.type & HitboxFlags.OpenPopup));
  const reservePopupIconSpace = () =>
    FileFns.showsIcon(fileItem()) &&
    (hasPopupHandle() || isPopup());
  const shouldRenderIcon = () => reservePopupIconSpace();
  const popupIconBoundsPx = (): BoundingBox => ({
    x: 1,
    y: 1,
    w: Math.max(blockSize().w - 2, 0),
    h: Math.max(blockSize().h - 2, 0),
  });
  const popupIconScale = () => (blockSize().h / LINE_HEIGHT_PX) * 0.94;
  const popupIconTopPx = () => -Math.max(blockSize().h * 0.03, 0.5);
  const emoji = () => FileFns.emoji(fileItem());
  const popupTextIndentPx = () => {
    if (!reservePopupIconSpace()) { return 0; }
    return desktopPopupIconTextIndentPx(sizeBl().w);
  };

  const blockSize = () => {
    return {
      w: boundsPx().w / sizeBl().w,
      h: boundsPx().h / sizeBl().h
    };
  };

  // Link click events are handled in the global mouse up handler. However, calculating the text
  // hitbox is difficult, so this hook is here to enable the browser to conveniently do it for us.
  const aHrefMouseDown = (ev: MouseEvent) => {
    if (ev.button == MOUSE_LEFT) { ClickState.setLinkWasClicked(true); }
    ev.preventDefault();
  };
  const aHrefClick = (ev: MouseEvent) => { ev.preventDefault(); };
  const aHrefMouseUp = (ev: MouseEvent) => { ev.preventDefault(); };

  const inputListener = (_ev: InputEvent) => {
    setTimeout(() => {
      if (store.overlay.textEditInfo() && !store.overlay.toolbarPopupInfoMaybe.get()) {
        const editingItemPath = store.overlay.textEditInfo()!.itemPath;
        let editingDomId = editingItemPath + ":title";
        let el = document.getElementById(editingDomId);
        let newText = el!.innerText;
        let item = asFileItem(itemState.get(VeFns.veidFromPath(editingItemPath).itemId)!);
        item.title = trimNewline(newText);
        const caretPosition = getCaretPosition(el!);
        arrangeNow(store, "file-input-preserve-caret");
        setCaretPosition(el!, caretPosition);
      }
    }, 0);
  }

  const keyDownHandler = (ev: KeyboardEvent) => {
    switch (ev.key) {
      case "Enter":
        ev.preventDefault();
        ev.stopPropagation();
        enterKeyHandler();
        return;
      case "Escape":
        ev.preventDefault();
        ev.stopPropagation();
        store.overlay.setTextEditInfo(store.history, null, true);
        arrangeNow(store, "file-escape-exit-edit");
        return;
    }
  }

  const enterKeyHandler = () => {
    if (store.user.getUserMaybe() == null || fileItem().ownerId != store.user.getUser().userId) { return; }
    const ve = props.visualElement;
    const editingDomId = store.overlay.textEditInfo()!.itemPath + ":title";
    const textElement = document.getElementById(editingDomId);
    const caretPosition = getCaretPosition(textElement!);

    const beforeText = textElement!.innerText.substring(0, caretPosition);
    const afterText = textElement!.innerText.substring(caretPosition);

    if (ve.flags & VisualElementFlags.InsideTable || props.visualElement.actualLinkItemMaybe != null) {
      console.log("ve.flags & VisualElementFlags.InsideTable || props.visualElement.actualLinkItemMaybe != null")
    } else {
      // single note on a page.
      const spatialPositionGr = asPositionalItem(ve.displayItem).spatialPositionGr;
      const spatialWidthGr = asXSizableItem(ve.displayItem).spatialWidthGr;
      const composite = CompositeFns.create(ve.displayItem.ownerId, ve.displayItem.parentId, ve.displayItem.relationshipToParent, ve.displayItem.ordering);
      composite.spatialPositionGr = spatialPositionGr;
      composite.spatialWidthGr = spatialWidthGr;
      itemState.add(composite);
      server.addItem(composite, null, store.general.networkStatus);
      itemState.moveToNewParent(ve.displayItem, composite.id, RelationshipToParent.Child, newOrdering());
      asFileItem(ve.displayItem).title = beforeText;
      serverOrRemote.updateItem(ve.displayItem, store.general.networkStatus);

      const ordering = itemState.newOrderingDirectlyAfterChild(composite.id, ve.displayItem.id);
      const note = NoteFns.create(ve.displayItem.ownerId, composite.id, RelationshipToParent.Child, "", ordering);
      note.title = afterText;
      itemState.add(note);
      server.addItem(note, null, store.general.networkStatus);

      arrangeNow(store, "file-enter-create-composite");
      const veid = { itemId: note.id, linkIdMaybe: null };
      const newVes = VesCache.render.findSingle(veid);
      store.overlay.setTextEditInfo(store.history, { itemPath: VeFns.veToPath(newVes.get()), itemType: ItemType.Note });

      let editingDomId = store.overlay.textEditInfo()!.itemPath + ":title";
      let textElement = document.getElementById(editingDomId);
      setCaretPosition(textElement!, 0);
      textElement!.focus();
    }
  }

  const isInComposite = () =>
    isComposite(itemState.get(VeFns.veidFromPath(props.visualElement.parentPath!).itemId));

  const showMoveOutOfCompositeArea = () =>
    store.user.getUserMaybe() != null &&
    store.perVe.getMouseIsOver(vePath()) &&
    !store.anItemIsMoving.get() &&
    store.overlay.textEditInfo() == null &&
    isInComposite();

  const isInCompositeOrDocument = () =>
    (props.visualElement.flags & VisualElementFlags.InsideCompositeOrDoc) != 0;

  // Check if this file is currently focused (via focusPath or textEditInfo)
  const isFocused = () => {
    const focusPath = store.history.getFocusPath();
    const textEditInfo = store.overlay.textEditInfo();
    return focusPath === vePath() || (textEditInfo != null && textEditInfo.itemPath === vePath());
  };

  const shadowOuterClass = () => {
    if (isPopup()) {
      return `absolute border border-[#999] rounded-xs shadow-xl blur-md bg-slate-700 pointer-events-none`;
    }
    return `absolute border border-[#999] rounded-xs shadow-xl bg-white`;
  };

  const outerClass = () => {
    if (props.visualElement.flags & VisualElementFlags.InsideCompositeOrDoc) {
      return `rounded-xs`;
    } else {
      return `border border-[#999] rounded-xs bg-white hover:shadow-md`;
    }
  };

  const renderShadowMaybe = () =>
    <Show when={!(props.visualElement.flags & VisualElementFlags.InsideCompositeOrDoc) &&
      !(props.visualElement.flags & VisualElementFlags.DockItem)}>
      <div class={`${shadowOuterClass()}`}
        style={`left: 0px; top: 0px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; z-index: 0;`} />
    </Show>;

  const renderFocusRingMaybe = () =>
    <Show when={isFocused() && shouldShowFocusRingForVisualElement(store, () => props.visualElement)}>
      <div class="absolute pointer-events-none rounded-xs"
        style={`left: 0px; top: 0px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
          `box-shadow: ${FOCUS_RING_BOX_SHADOW}; z-index: 2;`} />
    </Show>;

  const renderDetailed = () =>
    <>
      <Show when={(props.visualElement.flags & VisualElementFlags.FindHighlighted) || (props.visualElement.flags & VisualElementFlags.SelectionHighlighted)}>
        <div class="absolute pointer-events-none rounded-xs"
          style={`left: 0px; top: 0px; ` +
            `width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
            `background-color: ${(props.visualElement.flags & VisualElementFlags.FindHighlighted) ? FIND_HIGHLIGHT_COLOR : SELECTION_HIGHLIGHT_COLOR}; ` +
            `z-index: ${Z_INDEX_LOCAL_HIGHLIGHT};`} />
      </Show>
      <Show when={shouldRenderIcon()}>
        <div class="absolute rounded-xs pointer-events-none"
          style={`left: ${popupIconBoundsPx().x}px; top: ${popupIconBoundsPx().y}px; ` +
            `width: ${popupIconBoundsPx().w}px; height: ${popupIconBoundsPx().h}px; ` +
            `background-color: ${store.perVe.getMouseIsOverOpenPopup(vePath()) ? '#0044ff0a' : 'transparent'}; ` +
            `border: 1px solid ${store.perVe.getMouseIsOverOpenPopup(vePath()) ? '#cbd5e1' : 'transparent'}; ` +
            `z-index: ${Z_INDEX_LOCAL_HIGHLIGHT}; transition: background-color 0.1s, border-color 0.1s;`} />
        <div class="absolute text-center pointer-events-none"
          style={`left: 0px; top: ${popupIconTopPx()}px; ` +
            `width: ${blockSize().w / popupIconScale()}px; height: ${blockSize().h / popupIconScale()}px; ` +
            `transform: scale(${popupIconScale()}); transform-origin: top left; ` +
            `z-index: ${Z_INDEX_LOCAL_HIGHLIGHT};`}>
          <Show when={emoji()} fallback={<i class="fas fa-file" />}>
            <span class="inline-block leading-none"
              style={`font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif; transform: translateY(1px);`}>
              {emoji()}
            </span>
          </Show>
        </div>
      </Show>
      <Switch>
        <Match when={store.overlay.textEditInfo() == null || store.overlay.textEditInfo()!.itemPath != vePath()}>
          <div class={"text-left"}
            style={`position: absolute; ` +
              `left: ${NOTE_PADDING_PX * textBlockScale()}px; ` +
              `top: ${(NOTE_PADDING_PX - LINE_HEIGHT_PX / 4) * textBlockScale()}px; ` +
              `width: ${naturalWidthPx()}px; ` +
              `line-height: ${LINE_HEIGHT_PX * lineHeightScale()}px; ` +
              `transform: scale(${textBlockScale()}); transform-origin: top left; ` +
              `overflow-wrap: break-word; white-space: pre-wrap; ` +
              `text-indent: ${popupTextIndentPx()}px; `}>
            <a id={VeFns.veToPath(props.visualElement) + ":title"}
              href={""}
              class={`text-green-800 hover:text-green-700`}
              style={`-webkit-user-drag: none; -khtml-user-drag: none; -moz-user-drag: none; -o-user-drag: none; user-drag: none;`}
              onClick={aHrefClick}
              onMouseDown={aHrefMouseDown}
              onMouseUp={aHrefMouseUp}>
              {appendNewlineIfEmpty(fileItem().title)}
            </a>
          </div>
        </Match>
        <Match when={store.overlay.textEditInfo() != null}>
          <span id={VeFns.veToPath(props.visualElement) + ":title"}
            class={"text-left"}
            style={`position: absolute; ` +
              `left: ${NOTE_PADDING_PX * textBlockScale()}px; ` +
              `top: ${(NOTE_PADDING_PX - LINE_HEIGHT_PX / 4) * textBlockScale()}px; ` +
              `width: ${naturalWidthPx()}px; ` +
              `line-height: ${LINE_HEIGHT_PX * lineHeightScale()}px; ` +
              `transform: scale(${textBlockScale()}); transform-origin: top left; ` +
              `overflow-wrap: break-word; white-space: pre-wrap; ` +
              `text-indent: ${popupTextIndentPx()}px; ` +
              `outline: 0px solid transparent;`}
            contentEditable={canEdit() && !isInComposite() && store.overlay.textEditInfo() != null ? true : undefined}
            spellcheck={canEdit() && store.overlay.textEditInfo() != null}
            onKeyDown={keyDownHandler}
            onInput={inputListener}>
            {appendNewlineIfEmpty(fileItem().title)}
          </span>
        </Match>
      </Switch>
      <For each={VesCache.render.getAttachments(VeFns.veToPath(props.visualElement))()}>{attachment =>
        <VisualElement_Desktop visualElement={attachment.get()} />
      }</For>
      <Show when={showMoveOutOfCompositeArea()}>
        <CompositeMoveOutHandle boundsPx={moveOutOfCompositeBox()} active={store.perVe.getMouseIsOverCompositeMoveOut(vePath())} />
      </Show>
      <Show when={props.visualElement.linkItemMaybe != null &&
        (props.visualElement.linkItemMaybe.id != LIST_PAGE_MAIN_ITEM_LINK_ITEM) &&
        !(isPopup() && (props.visualElement.actualLinkItemMaybe == null)) &&
        showTriangleDetail()}>
        <InfuLinkTriangle />
      </Show>
      <Show when={!isInCompositeOrDocument() && showTriangleDetail()}>
        <InfuResizeTriangle />
      </Show>
      <Show when={store.perVe.getMovingItemIsOverAttach(vePath()) &&
        store.perVe.getMoveOverAttachmentIndex(vePath()) >= 0}>
        <div class={`absolute bg-black`}
          style={`left: ${attachInsertBarPx().x}px; top: ${attachInsertBarPx().y}px; ` +
            `width: ${attachInsertBarPx().w}px; height: ${attachInsertBarPx().h}px;`} />
      </Show>
      <Show when={store.perVe.getMovingItemIsOverAttachComposite(vePath())}>
        <div class={`absolute border border-black`}
          style={`left: ${attachCompositeBoundsPx().x}px; top: ${attachCompositeBoundsPx().y}px; width: ${attachCompositeBoundsPx().w}px; height: ${attachCompositeBoundsPx().h}px;`} />
      </Show>
    </>;

  return (
    <div class={positionClass()}
      style={`left: ${boundsPx().x}px; top: ${boundsPx().y + ((props.visualElement.flags & VisualElementFlags.Fixed) ? store.topToolbarHeightPx() : 0)}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
        `${desktopStackRootStyle(props.visualElement)}`}>
      {renderShadowMaybe()}
      <div class={`absolute ${outerClass()}`}
        style={`left: 0px; top: 0px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; z-index: 1;`}>
        <Show when={props.visualElement.flags & VisualElementFlags.Detailed}>
          {renderDetailed()}
        </Show>
      </div>
      {renderFocusRingMaybe()}
      <Show when={store.perVe.getAutoMovedIntoView(vePath())}>
        <div class="absolute pointer-events-none rounded-xs"
          style={autoMovedIntoViewWarningStyle(boundsPx().w, boundsPx().h)} />
      </Show>
    </div>
  );
}
