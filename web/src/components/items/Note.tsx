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

import { Component, createEffect, For, Match, Show, Switch } from "solid-js";
import { NoteFns, asNoteItem } from "../../items/note-item";
import { itemCanEdit } from "../../items/base/capabilities-item";
import { ATTACH_AREA_SIZE_PX, CONTAINER_IN_COMPOSITE_PADDING_PX, COMPOSITE_MOVE_OUT_AREA_ADDITIONAL_RIGHT_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_SIZE_PX, FONT_SIZE_PX, GRID_SIZE, LINE_HEIGHT_PX, NOTE_PADDING_PX, Z_INDEX_LOCAL_HIGHLIGHT } from "../../constants";
import { FIND_HIGHLIGHT_COLOR, SELECTION_HIGHLIGHT_COLOR, FOCUS_RING_BOX_SHADOW } from "../../style";
import { VisualElement_Desktop, VisualElementProps } from "../VisualElement";
import { BoundingBox } from "../../util/geometry";
import { ItemFns } from "../../items/base/item-polymorphism";
import { itemState } from "../../store/ItemState";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { NoteFlags } from "../../items/base/flags-item";
import { asXSizableItem } from "../../items/base/x-sizeable-item";
import { desktopPopupIconTextIndentPx, getTextStyleForNote } from "../../layout/text";
import { HitboxFlags } from "../../layout/hitbox";
import { useStore } from "../../store/StoreProvider";
import { CompositeFns, isComposite } from "../../items/composite-item";
import { ClickState } from "../../input/state";
import { MOUSE_LEFT } from "../../input/mouse_down";
import { appendNewlineIfEmpty, isUrl, trimNewline } from "../../util/string";
import { asPageItem, isPage } from "../../items/page-item";
import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "../../layout/arrange/page_list";
import { VesCache } from "../../layout/ves-cache";
import { InfuLinkTriangle } from "../library/InfuLinkTriangle";
import { arrangeNow } from "../../layout/arrange";
import { getCaretPosition, setCaretPosition } from "../../util/caret";
import { InfuResizeTriangle } from "../library/InfuResizeTriangle";
import { CompositeMoveOutHandle } from "./CompositeMoveOutHandle";

import { asPositionalItem } from "../../items/base/positional-item";
import { server, serverOrRemote } from "../../server";
import { RelationshipToParent } from "../../layout/relationship-to-parent";
import { newOrdering } from "../../util/ordering";
import { panic } from "../../util/lang";
import { ItemType } from "../../items/base/item";
import { isXSizableItem } from "../../items/base/x-sizeable-item";
import { asLinkItem, isLink } from "../../items/link-item";
import { autoMovedIntoViewWarningStyle, desktopStackRootStyle, shouldShowFocusRingForVisualElement } from "./helper";


// REMINDER: it is not valid to access VesCache in the item components (will result in heisenbugs)

export const Note_Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  const vePath = () => VeFns.veToPath(props.visualElement);
  const noteItem = () => asNoteItem(props.visualElement.displayItem);
  const canEdit = () => itemCanEdit(noteItem());
  const isPopup = () => !(!(props.visualElement.flags & VisualElementFlags.Popup));
  const boundsPx = () => props.visualElement.boundsPx;
  const positionClass = () => (props.visualElement.flags & VisualElementFlags.Fixed) ? 'fixed' : 'absolute';
  const sizeBl = () => {
    if (props.visualElement.flags & VisualElementFlags.InsideCompositeOrDoc) {
      const cloned = NoteFns.asNoteMeasurable(ItemFns.cloneMeasurableFields(props.visualElement.displayItem));
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
            : panic(`Note sizeBl: parentTreeItem has unexpected type: ${parentTreeItem.itemType}`);
      }
      return ItemFns.calcSpatialDimensionsBl(cloned);
    }
    if (props.visualElement.linkItemMaybe != null) {
      return ItemFns.calcSpatialDimensionsBl(props.visualElement.linkItemMaybe!);
    }
    const ignoreExplicitHeight = isPopup() && !(noteItem().flags & NoteFlags.ExplicitHeight);
    return NoteFns.calcSpatialDimensionsBl(noteItem(), ignoreExplicitHeight);
  };
  const naturalWidthPx = () => sizeBl().w * LINE_HEIGHT_PX - NOTE_PADDING_PX * 2;
  const naturalHeightPx = () => sizeBl().h * LINE_HEIGHT_PX;
  const widthScale = () => (boundsPx().w - NOTE_PADDING_PX * 2) / naturalWidthPx();
  const heightScale = () => (boundsPx().h - NOTE_PADDING_PX * 2 + (LINE_HEIGHT_PX - FONT_SIZE_PX)) / naturalHeightPx();
  const textBlockScale = () => widthScale();
  const lineHeightScale = () => isPopup() ? 1.0 : heightScale() / widthScale();
  const showTriangleDetail = () => (boundsPx().h / naturalHeightPx()) > 0.5;
  const lineClamp = () => isPopup() ? 1000 : Math.floor(sizeBl().h);
  const hasPopupHandle = () => props.visualElement.hitboxes.some(hb => !!(hb.type & HitboxFlags.OpenPopup));
  const reservePopupIconSpace = () =>
    NoteFns.showsDesktopPopupIcon(noteItem()) &&
    (hasPopupHandle() || isPopup());
  const showPopupIcon = () => reservePopupIconSpace();
  const popupIconBoundsPx = (): BoundingBox => ({
    x: 1,
    y: 1,
    w: Math.max(blockSize().w - 2, 0),
    h: Math.max(blockSize().h - 2, 0),
  });
  const popupIconScale = () => (blockSize().h / LINE_HEIGHT_PX) * 0.94;
  const popupIconTopPx = () => -Math.max(blockSize().h * 0.03, 0.5);
  const popupTextIndentPx = () => {
    if (!reservePopupIconSpace()) { return 0; }
    return desktopPopupIconTextIndentPx(sizeBl().w);
  };

  createEffect(() => {
    if (!isPopup()) { return; }
    console.log("[calendar-popup-debug] note-render", {
      vePath: vePath(),
      noteId: noteItem().id,
      flags: noteItem().flags,
      titleLength: noteItem().title.length,
      boundsPx: boundsPx(),
      blockSizePx: props.visualElement.blockSizePx,
      sizeBl: sizeBl(),
      naturalWidthPx: naturalWidthPx(),
      naturalHeightPx: naturalHeightPx(),
      widthScale: widthScale(),
      heightScale: heightScale(),
      textBlockScale: textBlockScale(),
      lineHeightScale: lineHeightScale(),
      lineClamp: lineClamp(),
      hasPopupHandle: hasPopupHandle(),
      reservePopupIconSpace: reservePopupIconSpace(),
      linkItemMaybe: props.visualElement.linkItemMaybe == null
        ? null
        : {
          id: props.visualElement.linkItemMaybe.id,
          spatialWidthGr: props.visualElement.linkItemMaybe.spatialWidthGr,
          spatialHeightGr: props.visualElement.linkItemMaybe.spatialHeightGr,
        },
      actualLinkItemMaybe: props.visualElement.actualLinkItemMaybe == null
        ? null
        : {
          id: props.visualElement.actualLinkItemMaybe.id,
          spatialWidthGr: props.visualElement.actualLinkItemMaybe.spatialWidthGr,
          spatialHeightGr: props.visualElement.actualLinkItemMaybe.spatialHeightGr,
        },
    });
  });

  const blockSize = () => {
    return {
      w: boundsPx().w / sizeBl().w,
      h: boundsPx().h / sizeBl().h
    };
  };

  const attachBoundsPx = (): BoundingBox => {
    return ({
      x: boundsPx().w - ATTACH_AREA_SIZE_PX - 2,
      y: 0,
      w: ATTACH_AREA_SIZE_PX,
      h: ATTACH_AREA_SIZE_PX,
    });
  };
  const attachInsertBarPx = (): BoundingBox => {
    const insertIndex = store.perVe.getMoveOverAttachmentIndex(vePath());
    // Special case for position 0: align with right edge of parent item
    const xOffset = insertIndex === 0 ? -4 : -2;
    return ({
      x: boundsPx().w - insertIndex * blockSize().w + xOffset,
      y: -blockSize().w / 2,
      w: 4,
      h: blockSize().w,
    });
  };
  const attachCompositeBoundsPx = (): BoundingBox => {
    return ({
      x: 0,
      y: boundsPx().h - 1,
      w: boundsPx().w - 2,
      h: 1,
    });
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

  // Check if this note is currently focused (via focusPath or textEditInfo)
  const isFocused = () => {
    const focusPath = store.history.getFocusPath();
    const textEditInfo = store.overlay.textEditInfo();
    // Focused if: focus path matches this item, OR we're currently editing this item
    return focusPath === vePath() || (textEditInfo != null && textEditInfo.itemPath === vePath());
  };

  const shadowOuterClass = () => {
    if (isPopup()) {
      return `absolute border border-[#999] rounded-xs shadow-xl blur-md bg-slate-700 pointer-events-none`;
    }
    if (noteItem().flags & NoteFlags.HideBorder) {
      if (store.perVe.getMouseIsOver(vePath())) {
        return `absolute border border-[#999] rounded-xs shadow-xl`;
      } else {
        return `absolute border border-transparent rounded-xs`;
      }
    }
    return `absolute border border-[#999] rounded-xs shadow-xl bg-white`;
  };

  const outerClass = () => {
    if (props.visualElement.flags & VisualElementFlags.InsideCompositeOrDoc) {
      return `rounded-xs`;
    } else {
      if (noteItem().flags & NoteFlags.HideBorder) {
        if (store.perVe.getMouseIsOver(vePath())) {
          return `border border-[#999] rounded-xs`;
        } else {
          return `border border-transparent rounded-xs`;
        }
      }
      return `border border-[#999] rounded-xs bg-white hover:shadow-md`;
    }
  };

  // Link click events are handled in the global mouse up handler. However, calculating the text
  // hitbox is difficult, so this hook is here to enable the browser to conveniently do it for us.
  const aHrefMouseDownListener = (ev: MouseEvent) => {
    if (ev.button == MOUSE_LEFT) { ClickState.setLinkWasClicked(noteItem().url != null && noteItem().url != ""); }
    ev.preventDefault();
  };
  const aHrefClickListener = (ev: MouseEvent) => { ev.preventDefault(); };
  const aHrefMouseUpListener = (ev: MouseEvent) => { ev.preventDefault(); };

  const inputListener = (_ev: InputEvent) => {
    setTimeout(() => {
      if (store.overlay.textEditInfo() && !store.overlay.toolbarPopupInfoMaybe.get()) {
        const editingItemPath = store.overlay.textEditInfo()!.itemPath;
        let editingDomId = editingItemPath + ":title";
        let el = document.getElementById(editingDomId);
        let newText = el!.innerText;
        let item = asNoteItem(itemState.get(VeFns.veidFromPath(editingItemPath).itemId)!);
        item.title = trimNewline(newText);
        const caretPosition = getCaretPosition(el!);
        arrangeNow(store, "note-input-preserve-caret");
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
        arrangeNow(store, "note-escape-exit-edit");
        return;
    }
  }

  const enterKeyHandler = () => {
    if (store.user.getUserMaybe() == null || noteItem().ownerId != store.user.getUser().userId) { return; }

    if (isUrl(noteItem().title)) {
      if (noteItem().url == "") {
        noteItem().url = noteItem().title;
      }
    }

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
      asNoteItem(ve.displayItem).title = beforeText;
      serverOrRemote.updateItem(ve.displayItem, store.general.networkStatus);

      const ordering = itemState.newOrderingDirectlyAfterChild(composite.id, ve.displayItem.id);
      const note = NoteFns.create(ve.displayItem.ownerId, composite.id, RelationshipToParent.Child, "", ordering);
      note.title = afterText;
      itemState.add(note);
      server.addItem(note, null, store.general.networkStatus);

      arrangeNow(store, "note-enter-create-composite");

      // If in a popup context, redirect the popup to show the composite
      if (isPopup()) {
        const compositeVeid = { itemId: composite.id, linkIdMaybe: null };
        store.history.replacePopup({
          actualVeid: compositeVeid,
          vePath: VeFns.addVeidToPath(compositeVeid, ve.parentPath!)
        });
        arrangeNow(store, "note-enter-redirect-popup");
      }

      const veid = { itemId: note.id, linkIdMaybe: null };

      const attemptToSetEditFocus = (attempt: number = 0) => {
        const foundVes = VesCache.render.find(veid);
        if (foundVes.length > 0) {
          store.overlay.setTextEditInfo(store.history, { itemPath: VeFns.veToPath(foundVes[0].get()), itemType: ItemType.Note });
          let editingDomId = store.overlay.textEditInfo()!.itemPath + ":title";
          let textElement = document.getElementById(editingDomId);
          if (textElement) {
            setCaretPosition(textElement, 0);
            textElement.focus();
          }
        } else if (attempt < 3) {
          // Retry with another arrange - needed for popups
          setTimeout(() => {
            arrangeNow(store, "note-enter-retry-find-new-editor");
            attemptToSetEditFocus(attempt + 1);
          }, 10);
        }
      };

      attemptToSetEditFocus();
    }
  }

  const infuTextStyle = () => getTextStyleForNote(noteItem().flags);

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

  const renderShadowMaybe = () =>
    <Show when={!(props.visualElement.flags & VisualElementFlags.InsideCompositeOrDoc) && !(props.visualElement.flags & VisualElementFlags.DockItem)}>
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
      <div class="absolute inset-0 rounded-xs overflow-hidden">
        <Show when={(props.visualElement.flags & VisualElementFlags.FindHighlighted) || (props.visualElement.flags & VisualElementFlags.SelectionHighlighted)}>
          <div class="absolute pointer-events-none rounded-xs"
            style={`left: 0px; top: 0px; ` +
              `width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
              `background-color: ${(props.visualElement.flags & VisualElementFlags.FindHighlighted) ? FIND_HIGHLIGHT_COLOR : SELECTION_HIGHLIGHT_COLOR}; ` +
              `z-index: ${Z_INDEX_LOCAL_HIGHLIGHT};`} />
        </Show>
        <Show when={showPopupIcon()}>
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
            <i class="fas fa-sticky-note" />
          </div>
        </Show>
        <Switch>
          <Match when={NoteFns.hasUrl(noteItem()) &&
            (store.overlay.textEditInfo() == null || store.overlay.textEditInfo()!.itemPath != vePath())}>
            <div class={`${infuTextStyle().isCode ? ' font-mono' : ''} ${infuTextStyle().alignClass}`}
              style={`position: absolute; ` +
                `left: ${NOTE_PADDING_PX * textBlockScale()}px; ` +
                `top: ${(NOTE_PADDING_PX - LINE_HEIGHT_PX / 4) * textBlockScale()}px; ` +
                `width: ${naturalWidthPx()}px; ` +
                `line-height: ${LINE_HEIGHT_PX * lineHeightScale() * infuTextStyle().lineHeightMultiplier}px; ` +
                `transform: scale(${textBlockScale()}); transform-origin: top left; ` +
                `font-size: ${infuTextStyle().fontSize}px; ` +
                `overflow-wrap: break-word; white-space: pre-wrap; ` +
                `text-indent: ${popupTextIndentPx()}px; ` +
                `${infuTextStyle().isBold ? ' font-weight: bold; ' : ""}; ` +
                `display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: ${lineClamp()}; overflow: hidden; text-overflow: ellipsis; `}>
              <a id={VeFns.veToPath(props.visualElement) + ":title"}
                href={noteItem().url}
                class={`text-blue-800 hover:text-blue-600`}
                style={`-webkit-user-drag: none; -khtml-user-drag: none; -moz-user-drag: none; -o-user-drag: none; user-drag: none;`}
                onClick={aHrefClickListener}
                onMouseDown={aHrefMouseDownListener}
                onMouseUp={aHrefMouseUpListener}>
                {NoteFns.noteFormatMaybe(noteItem().title, noteItem().format)}
              </a>
            </div>
          </Match>
          <Match when={store.overlay.textEditInfo() != null && store.overlay.textEditInfo()!.itemPath == vePath()}>
            {/* when editing, don't apply text formatting. */}
            <span id={VeFns.veToPath(props.visualElement) + ":title"}
              class={`block${infuTextStyle().isCode ? ' font-mono' : ''} ${infuTextStyle().alignClass} ` +
                `${NoteFns.hasUrl(noteItem()) ? 'black' : ''}`}
              style={`position: absolute; ` +
                `left: ${NOTE_PADDING_PX * textBlockScale()}px; ` +
                `top: ${(NOTE_PADDING_PX - LINE_HEIGHT_PX / 4) * textBlockScale()}px; ` +
                `width: ${naturalWidthPx()}px; ` +
                `line-height: ${LINE_HEIGHT_PX * lineHeightScale() * infuTextStyle().lineHeightMultiplier}px; ` +
                `transform: scale(${textBlockScale()}); transform-origin: top left; ` +
                `font-size: ${infuTextStyle().fontSize}px; ` +
                `overflow-wrap: break-word; white-space: pre-wrap; ` +
                `text-indent: ${popupTextIndentPx()}px; ` +
                `${infuTextStyle().isBold ? ' font-weight: bold; ' : ""}; ` +
                `outline: 0px solid transparent;`}
              contentEditable={canEdit() && !isInCompositeOrDocument() && store.overlay.textEditInfo() != null ? true : undefined}
              spellcheck={canEdit() && store.overlay.textEditInfo() != null}
              onKeyDown={keyDownHandler}
              onInput={inputListener}>
              {appendNewlineIfEmpty(noteItem().title)}<span></span>
            </span>
          </Match>
          <Match when={!NoteFns.hasUrl(noteItem()) || store.overlay.textEditInfo() != null}>
            <span id={VeFns.veToPath(props.visualElement) + ":title"}
              class={`block${infuTextStyle().isCode ? ' font-mono' : ''} ${infuTextStyle().alignClass} ` +
                `${NoteFns.hasUrl(noteItem()) ? 'black' : ''}`}
              style={`position: absolute; ` +
                `left: ${NOTE_PADDING_PX * textBlockScale()}px; ` +
                `top: ${(NOTE_PADDING_PX - LINE_HEIGHT_PX / 4) * textBlockScale()}px; ` +
                `width: ${naturalWidthPx()}px; ` +
                `line-height: ${LINE_HEIGHT_PX * lineHeightScale() * infuTextStyle().lineHeightMultiplier}px; ` +
                `transform: scale(${textBlockScale()}); transform-origin: top left; ` +
                `font-size: ${infuTextStyle().fontSize}px; ` +
                `overflow-wrap: break-word; white-space: pre-wrap; ` +
                `text-indent: ${popupTextIndentPx()}px; ` +
                `${infuTextStyle().isBold ? ' font-weight: bold; ' : ""}; ` +
                `outline: 0px solid transparent; ` +
                `display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: ${lineClamp()}; overflow: hidden; text-overflow: ellipsis; `}
              contentEditable={canEdit() && !isInCompositeOrDocument() && store.overlay.textEditInfo() != null ? true : undefined}
              spellcheck={canEdit() && store.overlay.textEditInfo() != null}
              onKeyDown={keyDownHandler}
              onInput={inputListener}>
              {appendNewlineIfEmpty(NoteFns.noteFormatMaybe(noteItem().title, noteItem().format))}<span></span>
            </span>
          </Match>
        </Switch>
      </div>
      <For each={VesCache.render.getAttachments(VeFns.veToPath(props.visualElement))()}>{attachment =>
        <VisualElement_Desktop visualElement={attachment.get()} />
      }</For>
      <Show when={showMoveOutOfCompositeArea()}>
        <CompositeMoveOutHandle boundsPx={moveOutOfCompositeBox()} active={store.perVe.getMouseIsOverCompositeMoveOut(vePath())} />
      </Show>
      <Show when={props.visualElement.linkItemMaybe != null &&
        (props.visualElement.linkItemMaybe.id != LIST_PAGE_MAIN_ITEM_LINK_ITEM) &&
        (!(noteItem().flags & NoteFlags.HideBorder) || store.perVe.getMouseIsOver(vePath())) &&
        !(isPopup() && (props.visualElement.actualLinkItemMaybe == null)) &&
        showTriangleDetail()}>
        <InfuLinkTriangle />
      </Show>
      <Show when={!isInCompositeOrDocument() &&
        showTriangleDetail() &&
        (!(noteItem().flags & NoteFlags.HideBorder) || store.perVe.getMouseIsOver(vePath()))}>
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
        style={`left: 0px; top: 0px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; z-index: 1; ` +
          `${!(props.visualElement.flags & VisualElementFlags.Detailed) ? 'background-color: #ddd; ' : ''}`}>
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
