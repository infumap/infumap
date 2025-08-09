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
import { NoteFns, asNoteItem } from "../../items/note-item";
import { ATTACH_AREA_SIZE_PX, CONTAINER_IN_COMPOSITE_PADDING_PX, COMPOSITE_MOVE_OUT_AREA_ADDITIONAL_RIGHT_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_SIZE_PX, FONT_SIZE_PX, GRID_SIZE, LINE_HEIGHT_PX, NOTE_PADDING_PX, Z_INDEX_SHADOW, Z_INDEX_POPUP, Z_INDEX_HIGHLIGHT } from "../../constants";
import { VisualElement_Desktop, VisualElementProps } from "../VisualElement";
import { BoundingBox } from "../../util/geometry";
import { ItemFns } from "../../items/base/item-polymorphism";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { NoteFlags } from "../../items/base/flags-item";
import { asXSizableItem } from "../../items/base/x-sizeable-item";
import { getTextStyleForNote } from "../../layout/text";
import { useStore } from "../../store/StoreProvider";
import { CompositeFns, isComposite } from "../../items/composite-item";
import { ClickState } from "../../input/state";
import { MOUSE_LEFT } from "../../input/mouse_down";
import { appendNewlineIfEmpty, isUrl, trimNewline } from "../../util/string";
import { ArrangeAlgorithm, asPageItem, isPage } from "../../items/page-item";
import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "../../layout/arrange/page_list";
import { itemState } from "../../store/ItemState";
import { FEATURE_COLOR } from "../../style";
import { InfuLinkTriangle } from "../library/InfuLinkTriangle";
import { fullArrange } from "../../layout/arrange";
import { getCaretPosition, setCaretPosition } from "../../util/caret";
import { InfuResizeTriangle } from "../library/InfuResizeTriangle";
import { VesCache } from "../../layout/ves-cache";
import { asPositionalItem } from "../../items/base/positional-item";
import { server, serverOrRemote } from "../../server";
import { RelationshipToParent } from "../../layout/relationship-to-parent";
import { newOrdering } from "../../util/ordering";
import { panic } from "../../util/lang";
import { ItemType } from "../../items/base/item";
import { isXSizableItem } from "../../items/base/x-sizeable-item";
import { asLinkItem, isLink } from "../../items/link-item";


// REMINDER: it is not valid to access VesCache in the item components (will result in heisenbugs)

export const Note_Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  const vePath = () => VeFns.veToPath(props.visualElement);
  const noteItem = () => asNoteItem(props.visualElement.displayItem);
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
    return NoteFns.calcSpatialDimensionsBl(noteItem());
  };
  const naturalWidthPx = () => sizeBl().w * LINE_HEIGHT_PX - NOTE_PADDING_PX*2;
  const naturalHeightPx = () => sizeBl().h * LINE_HEIGHT_PX;
  const widthScale = () => (boundsPx().w - NOTE_PADDING_PX*2) / naturalWidthPx();
  const heightScale = () => (boundsPx().h - NOTE_PADDING_PX*2 + (LINE_HEIGHT_PX - FONT_SIZE_PX)) / naturalHeightPx();
  const textBlockScale = () => widthScale();
  const lineHeightScale = () => heightScale() / widthScale();
  const showTriangleDetail = () => (boundsPx().h / naturalHeightPx()) > 0.5;

  const attachBoundsPx = (): BoundingBox => {
    return ({
      x: boundsPx().w - ATTACH_AREA_SIZE_PX-2,
      y: 0,
      w: ATTACH_AREA_SIZE_PX,
      h: ATTACH_AREA_SIZE_PX,
    });
  };
  const attachCompositeBoundsPx = (): BoundingBox => {
    return ({
      x: boundsPx().w / 4.0,
      y: boundsPx().h - ATTACH_AREA_SIZE_PX,
      w: boundsPx().w / 2.0,
      h: ATTACH_AREA_SIZE_PX,
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

  const shadowOuterClass = () => {
    if (isPopup()) {
      return `${positionClass()} border border-[#999] rounded-sm shadow-xl blur-md bg-slate-700 pointer-events-none`;
    }
    if (noteItem().flags & NoteFlags.HideBorder) {
      if (store.perVe.getMouseIsOver(vePath())) {
        return `${positionClass()} border border-[#999] rounded-sm shadow-xl`;
      } else {
        return `${positionClass()} border border-transparent rounded-sm`;
      }
    }
    return `${positionClass()} border border-[#999] rounded-sm shadow-xl bg-white`;
  };

  const outerClass = () => {
    if (props.visualElement.flags & VisualElementFlags.InsideCompositeOrDoc) {
      return `${positionClass()} rounded-sm`;
    } else {
      if (noteItem().flags & NoteFlags.HideBorder) {
        if (store.perVe.getMouseIsOver(vePath())) {
          return `${positionClass()} border border-[#999] rounded-sm`;
        } else {
          return `${positionClass()} border border-transparent rounded-sm`;
        }
      }
      return `${positionClass()} border border-[#999] rounded-sm bg-white hover:shadow-md`;
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
        fullArrange(store);
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
    const parentVe = VesCache.get(ve.parentPath!)!.get();

    const editingDomId = store.overlay.textEditInfo()!.itemPath + ":title";
    const textElement = document.getElementById(editingDomId);
    const caretPosition = getCaretPosition(textElement!);

    const beforeText = textElement!.innerText.substring(0, caretPosition);
    const afterText = textElement!.innerText.substring(caretPosition);

    if (ve.flags & VisualElementFlags.InsideTable || props.visualElement.actualLinkItemMaybe != null) {
      console.log("ve.flags & VisualElementFlags.InsideTable || props.visualElement.actualLinkItemMaybe != null")
    } else if (isPage(parentVe.displayItem) && asPageItem(parentVe.displayItem).arrangeAlgorithm == ArrangeAlgorithm.Document) {
      console.log("isPage(parentVe.displayItem) && asPageItem(parentVe.displayItem).arrangeAlgorithm == ArrangeAlgorithm.Document")
    } else if (isComposite(parentVe.displayItem)) {
      // inside composite
      panic("Note.enterKeyHandler called for note in composite");
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

      fullArrange(store);

      // If in a popup context, redirect the popup to show the composite
      if (isPopup()) {
        const compositeVeid = { itemId: composite.id, linkIdMaybe: null };
        store.history.replacePopup({
          actualVeid: compositeVeid,
          vePath: VeFns.addVeidToPath(compositeVeid, ve.parentPath!)
        });
        fullArrange(store);
      }

      const veid = { itemId: note.id, linkIdMaybe: null };

      const attemptToSetEditFocus = (attempt: number = 0) => {
        const foundVes = VesCache.find(veid);
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
            fullArrange(store);
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
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y + ((props.visualElement.flags & VisualElementFlags.Fixed) ? store.topToolbarHeightPx() : 0)}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                  `z-index: ${isPopup() ? Z_INDEX_POPUP : Z_INDEX_SHADOW}; ${VeFns.opacityStyle(props.visualElement)};`} />
    </Show>;

  const renderDetailed = () =>
    <>
      <Show when={props.visualElement.flags & VisualElementFlags.FindHighlighted}>
        <div class="absolute pointer-events-none rounded-sm"
             style={`left: 0px; top: 0px; ` +
                    `width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                    `background-color: rgba(255, 255, 0, 0.4); ` +
                    `z-index: ${Z_INDEX_HIGHLIGHT};`} />
      </Show>
      <Switch>
        <Match when={NoteFns.hasUrl(noteItem()) &&
                     (store.overlay.textEditInfo() == null || store.overlay.textEditInfo()!.itemPath != vePath())}>
          <div class={`${infuTextStyle().isCode ? ' font-mono' : ''} ${infuTextStyle().alignClass}`}
               style={`position: absolute; ` +
                      `left: ${NOTE_PADDING_PX*textBlockScale()}px; ` +
                      `top: ${(NOTE_PADDING_PX - LINE_HEIGHT_PX/4)*textBlockScale()}px; ` +
                      `width: ${naturalWidthPx()}px; ` +
                      `line-height: ${LINE_HEIGHT_PX * lineHeightScale() * infuTextStyle().lineHeightMultiplier}px; `+
                      `transform: scale(${textBlockScale()}); transform-origin: top left; ` +
                      `font-size: ${infuTextStyle().fontSize}px; ` +
                      `overflow-wrap: break-word; white-space: pre-wrap; ` +
                      `${infuTextStyle().isBold ? ' font-weight: bold; ' : ""}; `}>
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
                       `left: ${NOTE_PADDING_PX*textBlockScale()}px; ` +
                       `top: ${(NOTE_PADDING_PX - LINE_HEIGHT_PX/4)*textBlockScale()}px; ` +
                       `width: ${naturalWidthPx()}px; ` +
                       `line-height: ${LINE_HEIGHT_PX * lineHeightScale() * infuTextStyle().lineHeightMultiplier}px; `+
                       `transform: scale(${textBlockScale()}); transform-origin: top left; ` +
                       `font-size: ${infuTextStyle().fontSize}px; ` +
                       `overflow-wrap: break-word; white-space: pre-wrap; ` +
                       `${infuTextStyle().isBold ? ' font-weight: bold; ' : ""}; ` +
                       `outline: 0px solid transparent;`}
                contentEditable={!isInCompositeOrDocument() && store.overlay.textEditInfo() != null ? true : undefined}
                spellcheck={store.overlay.textEditInfo() != null}
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
                       `left: ${NOTE_PADDING_PX*textBlockScale()}px; ` +
                       `top: ${(NOTE_PADDING_PX - LINE_HEIGHT_PX/4)*textBlockScale()}px; ` +
                       `width: ${naturalWidthPx()}px; ` +
                       `line-height: ${LINE_HEIGHT_PX * lineHeightScale() * infuTextStyle().lineHeightMultiplier}px; `+
                       `transform: scale(${textBlockScale()}); transform-origin: top left; ` +
                       `font-size: ${infuTextStyle().fontSize}px; ` +
                       `overflow-wrap: break-word; white-space: pre-wrap; ` +
                       `${infuTextStyle().isBold ? ' font-weight: bold; ' : ""}; ` +
                       `outline: 0px solid transparent;`}
                contentEditable={!isInCompositeOrDocument() && store.overlay.textEditInfo() != null ? true : undefined}
                spellcheck={store.overlay.textEditInfo() != null}
                onKeyDown={keyDownHandler}
                onInput={inputListener}>
            {appendNewlineIfEmpty(NoteFns.noteFormatMaybe(noteItem().title, noteItem().format))}<span></span>
          </span>
        </Match>
      </Switch>
      <For each={props.visualElement.attachmentsVes}>{attachment =>
        <VisualElement_Desktop visualElement={attachment.get()} />
      }</For>
      <Show when={showMoveOutOfCompositeArea()}>
        <div class={`absolute rounded-sm`}
             style={`left: ${moveOutOfCompositeBox().x}px; top: ${moveOutOfCompositeBox().y}px; width: ${moveOutOfCompositeBox().w}px; height: ${moveOutOfCompositeBox().h}px; ` +
                    `background-color: ${FEATURE_COLOR};`} />
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
      <Show when={store.perVe.getMovingItemIsOverAttach(vePath())}>
        <div class={`absolute rounded-sm`}
             style={`left: ${attachBoundsPx().x}px; top: ${attachBoundsPx().y}px; width: ${attachBoundsPx().w}px; height: ${attachBoundsPx().h}px; ` +
                    `background-color: ${FEATURE_COLOR};`} />
      </Show>
      <Show when={store.perVe.getMovingItemIsOverAttachComposite(vePath())}>
        <div class={`absolute rounded-sm`}
             style={`left: ${attachCompositeBoundsPx().x}px; top: ${attachCompositeBoundsPx().y}px; width: ${attachCompositeBoundsPx().w}px; height: ${attachCompositeBoundsPx().h}px; ` +
                    `background-color: ${FEATURE_COLOR};`} />
      </Show>
    </>;

  return (
    <>
      {renderShadowMaybe()}
      <div class={`${outerClass()}`}
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y + ((props.visualElement.flags & VisualElementFlags.Fixed) ? store.topToolbarHeightPx() : 0)}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                  `${VeFns.zIndexStyle(props.visualElement)}; ${VeFns.opacityStyle(props.visualElement)}; ` +
                  `${!(props.visualElement.flags & VisualElementFlags.Detailed) ? 'background-color: #ddd; ' : ''}`}>
        <Show when={props.visualElement.flags & VisualElementFlags.Detailed}>
          {renderDetailed()}
        </Show>
      </div>
    </>
  );
}
