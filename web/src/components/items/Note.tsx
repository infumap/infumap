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
import { ItemIconRenderContext } from "../../items/base/icon-item";
import { NoteFns, asNoteItem, splitNoteInlineMarks, splitNoteUrls } from "../../items/note-item";
import { itemCanEdit } from "../../items/base/capabilities-item";
import { ATTACH_AREA_SIZE_PX, CONTAINER_IN_COMPOSITE_PADDING_PX, COMPOSITE_MOVE_OUT_AREA_ADDITIONAL_RIGHT_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_SIZE_PX, FONT_SIZE_PX, GRID_SIZE, LINE_HEIGHT_PX, NOTE_PADDING_PX, Z_INDEX_LOCAL_HIGHLIGHT } from "../../constants";
import { FIND_HIGHLIGHT_COLOR, SELECTION_HIGHLIGHT_COLOR, FOCUS_RING_BOX_SHADOW } from "../../style";
import { VisualElement_Desktop, VisualElementProps } from "../VisualElement";
import { BoundingBox } from "../../util/geometry";
import { ItemFns } from "../../items/base/item-polymorphism";
import { itemState } from "../../store/ItemState";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { itemCanAcceptManualChildren, NoteFlags } from "../../items/base/flags-item";
import { asXSizableItem } from "../../items/base/x-sizeable-item";
import {
  desktopPopupIconTextIndentPx,
  documentLineHeightPxForNote,
  getTextStyleForNote,
  noteHasListMarker,
  noteHasNumbered,
  noteListMarkerFontSizePx,
  noteListMarkerLeftPx,
  noteListMarkerText,
  noteListTextInsetPx,
  noteTextBlockPaddingLeftPx,
  noteTextBlockTextIndentPx,
} from "../../layout/text";
import { HitboxFlags } from "../../layout/hitbox";
import { useStore } from "../../store/StoreProvider";
import { CompositeFns } from "../../items/composite-item";
import { ArrangeAlgorithm, asPageItem, isPage } from "../../items/page-item";
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
import { autoMovedIntoViewWarningStyle, desktopStackRootStyle, documentPageMoveOutBoxPxMaybe, effectiveFlowItemWidthGrMaybe, parentDocumentPageMaybe, shouldShowFocusRingForVisualElement } from "./helper";
import { NoteIconGlyph } from "./NoteIconGlyph";
import { NoteInlineText } from "./NoteInlineText";
import { edit_beforeInputHandler, edit_inputListener, edit_keyDownHandler } from "../../input/edit";


// REMINDER: it is not valid to access VesCache in the item components (will result in heisenbugs)

export const Note_Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  const vePath = () => VeFns.veToPath(props.visualElement);
  const noteItem = () => asNoteItem(props.visualElement.displayItem);
  const canEdit = () => itemCanEdit(noteItem());
  const isPopup = () => !(!(props.visualElement.flags & VisualElementFlags.Popup));
  const parentDocumentPage = () => parentDocumentPageMaybe(props.visualElement);
  const isInDocumentFlow = () => parentDocumentPage() != null;
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

      const documentPage = parentDocumentPage();
      if (documentPage != null) {
        cloned.spatialWidthGr = documentPage.docWidthBl * GRID_SIZE;
        return NoteFns.calcDocumentSpatialDimensionsBl(cloned);
      }
      const effectiveWidthGr = effectiveFlowItemWidthGrMaybe(props.visualElement);
      if (effectiveWidthGr != null) {
        cloned.spatialWidthGr = effectiveWidthGr;
        return NoteFns.calcSpatialDimensionsBl(cloned, true);
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
      return NoteFns.calcSpatialDimensionsBl(cloned, true);
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
  const lineHeightScale = () => isPopup() || isInDocumentFlow() ? 1.0 : heightScale() / widthScale();
  const titleLineHeightPx = () => isInDocumentFlow()
    ? documentLineHeightPxForNote(noteItem().flags)
    : LINE_HEIGHT_PX * lineHeightScale() * infuTextStyle().lineHeightMultiplier;
  const showTriangleDetail = () => (boundsPx().h / naturalHeightPx()) > 0.5;
  const lineClamp = () => isPopup() ? 1000 : Math.floor(sizeBl().h);
  const hasPopupHandle = () => props.visualElement.hitboxes.some(hb => !!(hb.type & HitboxFlags.OpenPopup));
  const iconContext = () => ItemIconRenderContext.Spatial;
  const reservePopupIconSpace = () =>
    NoteFns.showsIcon(noteItem(), iconContext()) &&
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
  const popupTextIndentPx = () => {
    if (!reservePopupIconSpace()) { return 0; }
    return desktopPopupIconTextIndentPx(sizeBl().w);
  };
  const hasListMarker = () => noteHasListMarker(noteItem().flags);
  const titlePaddingLeftPx = () => noteTextBlockPaddingLeftPx(noteItem().flags, popupTextIndentPx());
  const titleTextIndentPx = () => noteTextBlockTextIndentPx(noteItem().flags, popupTextIndentPx());
  const listMarkerLeftPx = () => noteListMarkerLeftPx(noteItem().flags, popupTextIndentPx());
  const listMarkerText = () => noteListMarkerText(noteItem().flags, props.visualElement.listItemNumber);
  const listMarkerWidthPx = () => noteListTextInsetPx(noteItem().flags);
  const listMarkerFontSizePx = () => noteListMarkerFontSizePx(noteItem().flags, infuTextStyle().fontSize);

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
    const documentBox = documentPageMoveOutBoxPxMaybe(props.visualElement);
    if (documentBox != null) { return documentBox; }
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
      return `border border-[#999] rounded-xs bg-white ${props.suppressLocalShadow ? "" : "hover:shadow-md"}`;
    }
  };

  const beforeInputListener = (ev: InputEvent) => {
    edit_beforeInputHandler(store, ev);
  }

  const inputListener = (ev: InputEvent) => {
    ev.stopPropagation();
    edit_inputListener(store, ev);
  }

  const parentChainAcceptsManualChildAdd = (parentId: string | null): boolean => {
    let current = parentId != null ? itemState.get(parentId) : null;
    while (current != null) {
      if (isPage(current)) {
        const page = asPageItem(current);
        return page.clientOnly !== true && itemCanAcceptManualChildren(page);
      }
      current = current.parentId != null ? itemState.get(current.parentId) : null;
    }
    return true;
  }

  const keyDownHandler = (ev: KeyboardEvent) => {
    if (!isTextEditTarget()) { return; }
    switch (ev.key) {
      case "Enter":
        if (isInCompositeOrDocument()) {
          edit_keyDownHandler(store, props.visualElement, ev);
          return;
        }
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
    if (!parentChainAcceptsManualChildAdd(props.visualElement.displayItem.parentId)) { return; }

    NoteFns.ensureTitleUrl(noteItem());

    const ve = props.visualElement;
    const editingDomId = store.overlay.textEditInfo()!.itemPath + ":title";
    const textElement = document.getElementById(editingDomId);
    const caretPosition = getCaretPosition(textElement!);

    const sourceNote = asNoteItem(ve.displayItem);
    const beforeText = textElement!.innerText.substring(0, caretPosition);
    const afterText = textElement!.innerText.substring(caretPosition);
    const continuationFlags = NoteFns.listContinuationFlagsForEnter(sourceNote, textElement!.innerText, caretPosition);
    const splitMarks = splitNoteInlineMarks(sourceNote.inlineMarks, sourceNote.title, caretPosition);
    const splitUrls = splitNoteUrls(sourceNote.urls, sourceNote.title, caretPosition);

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
      asNoteItem(ve.displayItem).inlineMarks = splitMarks[0];
      asNoteItem(ve.displayItem).urls = splitUrls[0];
      NoteFns.ensureTitleUrl(asNoteItem(ve.displayItem));
      serverOrRemote.updateItem(ve.displayItem, store.general.networkStatus);

      const ordering = itemState.newOrderingDirectlyAfterChild(composite.id, ve.displayItem.id);
      const note = NoteFns.create(ve.displayItem.ownerId, composite.id, RelationshipToParent.Child, "", ordering);
      note.title = afterText;
      note.flags = continuationFlags;
      note.inlineMarks = splitMarks[1];
      note.urls = splitUrls[1];
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

  const showMoveOutOfCompositeArea = () =>
    store.user.getUserMaybe() != null &&
    store.perVe.getMouseIsOver(vePath()) &&
    !store.anItemIsMoving.get() &&
    store.overlay.textEditInfo() == null &&
    isInCompositeOrDocument();

  const isInCompositeOrDocument = () =>
    (props.visualElement.flags & VisualElementFlags.InsideCompositeOrDoc) != 0;

  const isInDocumentPage = () => {
    if (isInDocumentFlow()) { return true; }
    const seenParentIds = new Set<string>();
    let parentId: string | null = noteItem().parentId;
    while (parentId != null && !seenParentIds.has(parentId)) {
      seenParentIds.add(parentId);
      const parentItem = itemState.get(parentId);
      if (parentItem == null) { return false; }
      if (isPage(parentItem) && asPageItem(parentItem).arrangeAlgorithm == ArrangeAlgorithm.Document) {
        return true;
      }
      parentId = parentItem.parentId;
    }
    return false;
  };

  const isSelectableReadOnlyDocumentText = () =>
    isInDocumentPage() && !canEdit();

  const readOnlyDocumentSelectableTextStyle = () =>
    isSelectableReadOnlyDocumentText()
      ? `pointer-events: auto; user-select: text; -webkit-user-select: text; `
      : "";

  const documentTextBottomSelectionGuardHeightPx = () => {
    if (!isInDocumentPage()) { return 0; }
    const visualLineHeightPx = titleLineHeightPx() * textBlockScale();
    const visualFontSizePx = infuTextStyle().fontSize * textBlockScale();
    const visualTextTopPx = (NOTE_PADDING_PX - LINE_HEIGHT_PX / 4) * textBlockScale();
    const visualTextLineBoxBottomPx = visualTextTopPx + sizeBl().h * visualLineHeightPx;
    const bottomSlackPx = Math.max(0, boundsPx().h - visualTextLineBoxBottomPx);
    return Math.max(2, (visualLineHeightPx - visualFontSizePx) / 2 + bottomSlackPx);
  };

  const isTextEditTarget = () =>
    store.overlay.textEditInfo()?.itemPath == vePath();

  const renderedTitle = () => noteItem().title;

  const renderedInlineMarks = () => noteItem().inlineMarks;

  const renderedUrls = () => noteItem().urls;

  const renderListMarkerMaybe = () =>
    <Show when={hasListMarker()}>
      <span class={`absolute pointer-events-none${infuTextStyle().isCode ? ' font-mono' : ''}`}
        style={`left: ${(NOTE_PADDING_PX + listMarkerLeftPx()) * textBlockScale()}px; ` +
          `top: ${(NOTE_PADDING_PX - LINE_HEIGHT_PX / 4) * textBlockScale()}px; ` +
          `width: ${listMarkerWidthPx()}px; ` +
          `line-height: ${titleLineHeightPx()}px; ` +
          `transform: scale(${textBlockScale()}); transform-origin: top left; ` +
          `font-size: ${listMarkerFontSizePx()}px; ` +
          `${noteHasNumbered(noteItem().flags) ? 'text-align: right; padding-right: 6px; box-sizing: border-box; ' : ''}` +
          `${infuTextStyle().isBold ? ' font-weight: bold; ' : ""}; `}>
        {listMarkerText()}
      </span>
    </Show>;

  const renderShadowMaybe = () =>
    <Show when={!props.suppressLocalShadow &&
      !(props.visualElement.flags & VisualElementFlags.InsideCompositeOrDoc) &&
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

  const editingTextRenderKey = () => isTextEditTarget()
    ? JSON.stringify([renderedTitle(), renderedInlineMarks(), renderedUrls()])
    : null;

  const renderTitle = (editing: boolean) =>
    <span id={VeFns.veToPath(props.visualElement) + ":title"}
      class={`block${infuTextStyle().isCode ? ' font-mono' : ''} ${infuTextStyle().alignClass} ` +
        `${editing || isSelectableReadOnlyDocumentText() ? ' select-text cursor-text' : ''}`}
      style={`position: absolute; ` +
        `left: ${NOTE_PADDING_PX * textBlockScale()}px; ` +
        `top: ${(NOTE_PADDING_PX - LINE_HEIGHT_PX / 4) * textBlockScale()}px; ` +
        `width: ${naturalWidthPx()}px; ` +
        `line-height: ${titleLineHeightPx()}px; ` +
        `transform: scale(${textBlockScale()}); transform-origin: top left; ` +
        `font-size: ${infuTextStyle().fontSize}px; ` +
        `overflow-wrap: break-word; white-space: pre-wrap; ` +
        `box-sizing: border-box; padding-left: ${titlePaddingLeftPx()}px; ` +
        `text-indent: ${titleTextIndentPx()}px; ` +
        `${infuTextStyle().isBold ? ' font-weight: bold; ' : ""}; ` +
        `outline: 0px solid transparent; ` +
        (editing
          ? `user-select: text; -webkit-user-select: text; `
          : isSelectableReadOnlyDocumentText()
            ? readOnlyDocumentSelectableTextStyle()
            : `display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: ${lineClamp()}; overflow: hidden; text-overflow: ellipsis; `)}
      contentEditable={canEdit() && editing ? "plaintext-only" : undefined}
      spellcheck={canEdit() && editing}
      onKeyDown={keyDownHandler}
      onBeforeInput={beforeInputListener}
      onInput={inputListener}>
      <NoteInlineText
        text={renderedTitle()}
        inlineMarks={renderedInlineMarks()}
        urls={renderedUrls()}
        linksEnabled={!editing}
        inactiveLinksStyled={editing} />
    </span>;

  const renderDetailed = () =>
    <>
      <div class={`absolute inset-0 rounded-xs ${isTextEditTarget() ? "overflow-visible" : "overflow-hidden"}`}>
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
            <NoteIconGlyph note={noteItem} iconContext={iconContext} highPriority={isPopup} />
          </div>
        </Show>
        {renderListMarkerMaybe()}
        <Show keyed when={editingTextRenderKey()} fallback={renderTitle(false)}>
          {(_renderKey) => renderTitle(true)}
        </Show>
        <Show when={isInDocumentPage()}>
          <div
            aria-hidden="true"
            contentEditable={false}
            class="absolute select-none"
            style={`left: 0px; top: ${boundsPx().h - documentTextBottomSelectionGuardHeightPx()}px; ` +
              `width: ${boundsPx().w}px; height: ${documentTextBottomSelectionGuardHeightPx()}px; ` +
              `z-index: ${Z_INDEX_LOCAL_HIGHLIGHT - 1}; pointer-events: auto; ` +
              `cursor: ${isTextEditTarget() || isSelectableReadOnlyDocumentText() ? "text" : "default"}; ` +
              `user-select: none; -webkit-user-select: none;`} />
        </Show>
      </div>
      <For each={VesCache.render.getAttachments(VeFns.veToPath(props.visualElement))()}>{attachment =>
        <VisualElement_Desktop visualElement={attachment.get()} suppressLocalShadow={props.suppressLocalShadow} />
      }</For>
      <Show when={showMoveOutOfCompositeArea()}>
        <CompositeMoveOutHandle boundsPx={moveOutOfCompositeBox()} active={store.perVe.getMouseIsOverCompositeMoveOut(vePath())} vePath={vePath()} />
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
