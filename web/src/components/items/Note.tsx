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
import { ATTACH_AREA_SIZE_PX, CONTAINER_IN_COMPOSITE_PADDING_PX, COMPOSITE_MOVE_OUT_AREA_ADDITIONAL_RIGHT_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_MARGIN_PX, COMPOSITE_MOVE_OUT_AREA_SIZE_PX, FONT_SIZE_PX, GRID_SIZE, LINE_HEIGHT_PX, NOTE_PADDING_PX, PADDING_PROP, Z_INDEX_SHADOW } from "../../constants";
import { VisualElement_Desktop, VisualElementProps } from "../VisualElement";
import { BoundingBox, cloneBoundingBox } from "../../util/geometry";
import { ItemFns } from "../../items/base/item-polymorphism";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { NoteFlags } from "../../items/base/flags-item";
import { asXSizableItem } from "../../items/base/x-sizeable-item";
import { getTextStyleForNote } from "../../layout/text";
import { useStore } from "../../store/StoreProvider";
import { CompositeFns, isComposite } from "../../items/composite-item";
import { ClickState } from "../../input/state";
import { MOUSE_LEFT } from "../../input/mouse_down";
import { isNumeric } from "../../util/math";
import { appendNewlineIfEmpty, trimNewline } from "../../util/string";
import { ArrangeAlgorithm, asPageItem, isPage } from "../../items/page-item";
import { LIST_PAGE_MAIN_ITEM_LINK_ITEM } from "../../layout/arrange/page_list";
import { itemState } from "../../store/ItemState";
import { FEATURE_COLOR } from "../../style";
import { InfuLinkTriangle } from "../library/InfuLinkTriangle";
import { fullArrange } from "../../layout/arrange";
import { getCaretPosition, setCaretPosition } from "../../util/caret";
import { InfuResizeTriangle } from "../library/InfuResizeTriangle";
import { createHighlightBoundsPxFn, createLineHighlightBoundsPxFn } from "./helper";
import { VesCache } from "../../layout/ves-cache";
import { asPositionalItem } from "../../items/base/positional-item";
import { server, serverOrRemote } from "../../server";
import { RelationshipToParent } from "../../layout/relationship-to-parent";
import { newOrdering } from "../../util/ordering";
import { panic } from "../../util/lang";
import { ItemType } from "../../items/base/item";


// REMINDER: it is not valid to access VesCache in the item components (will result in heisenbugs)

export const Note_Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  const vePath = () => VeFns.veToPath(props.visualElement);
  const noteItem = () => asNoteItem(props.visualElement.displayItem);
  const boundsPx = () => props.visualElement.boundsPx;
  const sizeBl = () => {
    if (props.visualElement.flags & VisualElementFlags.InsideCompositeOrDoc) {
      const cloned = NoteFns.asNoteMeasurable(ItemFns.cloneMeasurableFields(props.visualElement.displayItem));
      const parentVeid = VeFns.veidFromPath(props.visualElement.parentPath!);
      const parentDisplayItem = itemState.get(parentVeid.itemId)!;

      let parentCanonicalItem = VeFns.canonicalItemFromVeid(parentVeid);
      if (parentCanonicalItem == null) {
        // case where link is virtual (not in itemState). happens in list selected page case.
        parentCanonicalItem = itemState.get(parentVeid.itemId)!;
      }

      if (isPage(parentDisplayItem)) {
        cloned.spatialWidthGr = asPageItem(parentDisplayItem).docWidthBl * GRID_SIZE;
      } else {
        cloned.spatialWidthGr = asXSizableItem(parentCanonicalItem).spatialWidthGr;
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
    if (noteItem().flags & NoteFlags.HideBorder) {
      if (store.perVe.getMouseIsOver(vePath())) {
        return `absolute border border-slate-700 rounded-sm shadow-lg`;
      } else {
        return 'absolute border border-transparent rounded-sm';
      }
    }
    return `absolute border border-slate-700 rounded-sm shadow-lg bg-white`;
  };

  const outerClass = () => {
    if (props.visualElement.flags & VisualElementFlags.InsideCompositeOrDoc) {
      return 'absolute rounded-sm bg-white';
    } else {
      if (noteItem().flags & NoteFlags.HideBorder) {
        if (store.perVe.getMouseIsOver(vePath())) {
          return `absolute border border-slate-700 rounded-sm`;
        } else {
          return 'absolute border border-transparent rounded-sm';
        }
      }
      return `absolute border border-slate-700 rounded-sm bg-white`;
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
      server.addItem(composite, null);
      itemState.moveToNewParent(ve.displayItem, composite.id, RelationshipToParent.Child, newOrdering());
      asNoteItem(ve.displayItem).title = beforeText;
      serverOrRemote.updateItem(ve.displayItem);

      const ordering = itemState.newOrderingDirectlyAfterChild(composite.id, ve.displayItem.id);
      const note = NoteFns.create(ve.displayItem.ownerId, composite.id, RelationshipToParent.Child, "", ordering);
      note.title = afterText;
      itemState.add(note);
      server.addItem(note, null);

      fullArrange(store);
      const veid = { itemId: note.id, linkIdMaybe: null };
      const newVes = VesCache.findSingle(veid);
      store.overlay.setTextEditInfo(store.history, { itemPath: VeFns.veToPath(newVes.get()), itemType: ItemType.Note });

      let editingDomId = store.overlay.textEditInfo()!.itemPath + ":title";
      let textElement = document.getElementById(editingDomId);
      setCaretPosition(textElement!, 0);
      textElement!.focus();
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
    <Show when={!(props.visualElement.flags & VisualElementFlags.InsideCompositeOrDoc)}>
      <div class={`${shadowOuterClass()}`}
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                  `z-index: ${Z_INDEX_SHADOW}; ${VeFns.opacityStyle(props.visualElement)};`} />
    </Show>;

  const renderDetailed = () =>
    <>
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
               href={""}
               class={`text-blue-800`}
               style={`-webkit-user-drag: none; -khtml-user-drag: none; -moz-user-drag: none; -o-user-drag: none; user-drag: none;`}
               onClick={aHrefClickListener}
               onMouseDown={aHrefMouseDownListener}
               onMouseUp={aHrefMouseUpListener}>
              {formatMaybe(noteItem().title, noteItem().format)}
            </a>
          </div>
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
                contentEditable={!isInComposite() && store.overlay.textEditInfo() != null ? true : undefined}
                spellcheck={store.overlay.textEditInfo() != null}
                onKeyDown={keyDownHandler}
                onInput={inputListener}>
            {appendNewlineIfEmpty(formatMaybe(noteItem().title, noteItem().format))}<span></span>
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
      <Show when={props.visualElement.linkItemMaybe != null && (props.visualElement.linkItemMaybe.id != LIST_PAGE_MAIN_ITEM_LINK_ITEM)}>
        <InfuLinkTriangle />
      </Show>
      <Show when={!isInCompositeOrDocument()}>
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
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; width: ${boundsPx().w}px; height: ${boundsPx().h}px; ` +
                  `${VeFns.zIndexStyle(props.visualElement)}; ${VeFns.opacityStyle(props.visualElement)}; ` +
                  `${!(props.visualElement.flags & VisualElementFlags.Detailed) ? 'background-color: #ddd; ' : ''}`}>
        <Show when={props.visualElement.flags & VisualElementFlags.Detailed}>
          {renderDetailed()}
        </Show>
      </div>
    </>
  );
}


export const Note_LineItem: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();

  const noteItem = () => asNoteItem(props.visualElement.displayItem);
  const vePath = () => VeFns.veToPath(props.visualElement);
  const boundsPx = () => props.visualElement.boundsPx;
  const highlightBoundsPx = createHighlightBoundsPxFn(() => props.visualElement);
  const lineHighlightBoundsPx = createLineHighlightBoundsPxFn(() => props.visualElement);
  const scale = () => boundsPx().h / LINE_HEIGHT_PX;
  const smallScale = () => scale() * 0.7;
  const oneBlockWidthPx = () => props.visualElement.blockSizePx!.w;
  const showCopyIcon = () => (noteItem().flags & NoteFlags.ShowCopyIcon);
  const leftPx = () => props.visualElement.flags & VisualElementFlags.Attachment
    ? boundsPx().x + oneBlockWidthPx() * PADDING_PROP
    : boundsPx().x + oneBlockWidthPx();
  const widthPx = () => props.visualElement.flags & VisualElementFlags.Attachment
    ? boundsPx().w - oneBlockWidthPx() * PADDING_PROP - (showCopyIcon() ? oneBlockWidthPx() * 0.9 : 0)
    : boundsPx().w - oneBlockWidthPx() - (showCopyIcon() ? oneBlockWidthPx() * 0.9 : 0);
  const openPopupBoundsPx = () => {
    const r = cloneBoundingBox(boundsPx())!;
    r.w = oneBlockWidthPx();
    return r;
  };

  const infuTextStyle = () => getTextStyleForNote(noteItem().flags);

  const eatMouseEvent = (ev: MouseEvent) => { ev.stopPropagation(); }

  const copyClickHandler = () => {
    if (noteItem().url == "") {
      navigator.clipboard.writeText(noteItem().title);
    } else {
      navigator.clipboard.writeText("[" + noteItem().title + "](" + noteItem().url + ")");
    }
  }

  // Link click events are handled in the global mouse up handler. However, calculating the text
  // hitbox is difficult, so this hook is here to enable the browser to conveniently do it for us.
  const aHrefMouseDown = (ev: MouseEvent) => {
    if (ev.button == MOUSE_LEFT) { ClickState.setLinkWasClicked(noteItem().url != null && noteItem().url != ""); }
    ev.preventDefault();
  };
  const aHrefClick = (ev: MouseEvent) => { ev.preventDefault(); };
  const aHrefMouseUp = (ev: MouseEvent) => { ev.preventDefault(); };

  const renderHighlightsMaybe = () =>
    <Switch>
      <Match when={store.perVe.getMouseIsOverOpenPopup(vePath())}>
        <div class="absolute border border-slate-300 rounded-sm bg-slate-200"
             style={`left: ${openPopupBoundsPx().x+2}px; top: ${openPopupBoundsPx().y+2}px; width: ${openPopupBoundsPx().w-4}px; height: ${openPopupBoundsPx().h-4}px;`} />
        <Show when={lineHighlightBoundsPx() != null}>
          <div class="absolute border border-slate-300 rounded-sm"
               style={`left: ${lineHighlightBoundsPx()!.x+2}px; top: ${lineHighlightBoundsPx()!.y+2}px; width: ${lineHighlightBoundsPx()!.w-4}px; height: ${lineHighlightBoundsPx()!.h-4}px;`} />
        </Show>
      </Match>
      <Match when={!store.perVe.getMouseIsOverOpenPopup(vePath()) && store.perVe.getMouseIsOver(vePath())}>
        <div class="absolute border border-slate-300 rounded-sm bg-slate-200"
             style={`left: ${highlightBoundsPx().x+2}px; top: ${highlightBoundsPx().y+2}px; width: ${highlightBoundsPx().w-4}px; height: ${highlightBoundsPx().h-4}px;`} />
        <Show when={lineHighlightBoundsPx() != null}>
          <div class="absolute border border-slate-300 rounded-sm"
               style={`left: ${lineHighlightBoundsPx()!.x+2}px; top: ${lineHighlightBoundsPx()!.y+2}px; width: ${lineHighlightBoundsPx()!.w-4}px; height: ${lineHighlightBoundsPx()!.h-4}px;`} />
        </Show>
      </Match>
      <Match when={props.visualElement.flags & VisualElementFlags.Selected}>
        <div class="absolute"
             style={`left: ${boundsPx().x+1}px; top: ${boundsPx().y}px; width: ${boundsPx().w-1}px; height: ${boundsPx().h}px; background-color: #dddddd88;`} />
      </Match>
    </Switch>;

  const renderIconMaybe = () =>
    <Show when={!(props.visualElement.flags & VisualElementFlags.Attachment)}>
      <div class="absolute text-center"
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; ` +
                  `width: ${oneBlockWidthPx() / scale()}px; height: ${boundsPx().h/scale()}px; `+
                  `transform: scale(${scale()}); transform-origin: top left;`}>
        <i class={`fas fa-sticky-note`} />
      </div>
    </Show>;

  const inputListener = (_ev: InputEvent) => {
    // fullArrange is not required in the line item case, because the ve geometry does not change.
  }

  const keyDownHandler = (ev: KeyboardEvent) => {
    switch (ev.key) {
      case "Enter":
        ev.preventDefault();
        ev.stopPropagation();
        return;
    }
  }

  const renderText = () =>
    <div class={`absolute overflow-hidden whitespace-nowrap ` +
                ((store.overlay.textEditInfo() != null && store.overlay.textEditInfo()?.itemPath == vePath()) ? '' : `text-ellipsis `) +
                `${infuTextStyle().alignClass} `}
         style={`left: ${leftPx()}px; top: ${boundsPx().y}px; ` +
                `width: ${widthPx()/scale()}px; height: ${boundsPx().h / scale()}px; ` +
                `transform: scale(${scale()}); transform-origin: top left;`}>
      <Switch>
        <Match when={NoteFns.hasUrl(noteItem()) &&
                     (store.overlay.textEditInfo() == null || store.overlay.textEditInfo()!.itemPath != vePath())}>
          <a id={VeFns.veToPath(props.visualElement) + ":title"}
             href={""}
             class={`text-blue-800 ${infuTextStyle().isCode ? 'font-mono' : ''}`}
             style={`-webkit-user-drag: none; -khtml-user-drag: none; -moz-user-drag: none; -o-user-drag: none; user-drag: none; ` +
                    `${infuTextStyle().isBold ? ' font-weight: bold; ' : ""}; `}
             onClick={aHrefClick}
             onMouseDown={aHrefMouseDown}
             onMouseUp={aHrefMouseUp}>
            {formatMaybe(noteItem().title, noteItem().format)}
          </a>
        </Match>
        <Match when={!NoteFns.hasUrl(noteItem()) || store.overlay.textEditInfo() != null}>
          <span id={VeFns.veToPath(props.visualElement) + ":title"}
                class={`${infuTextStyle().isCode ? 'font-mono' : ''}`}
                style={`${infuTextStyle().isBold ? ' font-weight: bold; ' : ""}; ` +
                       `outline: 0px solid transparent;`}
                contentEditable={store.overlay.textEditInfo() != null ? true : undefined}
                spellcheck={store.overlay.textEditInfo() != null}
                onKeyDown={keyDownHandler}
                onInput={inputListener}>
            {appendNewlineIfEmpty(formatMaybe(noteItem().title, noteItem().format))}<span></span>
          </span>
        </Match>
      </Switch>
    </div>;

  const renderCopyIconMaybe = () =>
    <Show when={showCopyIcon()}>
      <div class="absolute text-center text-slate-600"
           style={`left: ${boundsPx().x+boundsPx().w - 1*oneBlockWidthPx()}px; top: ${boundsPx().y + boundsPx().h*PADDING_PROP}px; ` +
                  `width: ${oneBlockWidthPx() / smallScale()}px; height: ${boundsPx().h/smallScale()}px; `+
                  `transform: scale(${smallScale()}); transform-origin: top left;`}
           onmousedown={eatMouseEvent}
           onmouseup={eatMouseEvent}
           onclick={copyClickHandler}>
        <i class={`fas fa-copy cursor-pointer`} />
      </div>
    </Show>;

  const renderLinkMarkingMaybe = () =>
    <Show when={props.visualElement.linkItemMaybe != null && (props.visualElement.linkItemMaybe.id != LIST_PAGE_MAIN_ITEM_LINK_ITEM)}>
      <div class="absolute text-center text-slate-600"
           style={`left: ${boundsPx().x}px; top: ${boundsPx().y}px; ` +
                  `width: ${oneBlockWidthPx() / scale()}px; height: ${boundsPx().h/scale()}px; `+
                  `transform: scale(${scale()}); transform-origin: top left;`}>
        <InfuLinkTriangle />
      </div>
    </Show>

  return (
    <>
      {renderHighlightsMaybe()}
      {renderIconMaybe()}
      {renderText()}
      {renderCopyIconMaybe()}
      {renderLinkMarkingMaybe()}
    </>
  );
}


// TODO (HIGH): something not naive.
function formatMaybe(text: string, format: string): string {
  if (format == "") { return text; }
  if (!isNumeric(text)) { return text; }
  if (format == "0") { return parseFloat(text).toFixed(0); }
  if (format == "0.0") { return parseFloat(text).toFixed(1); }
  if (format == "0.00") { return parseFloat(text).toFixed(2); }
  if (format == "0.000") { return parseFloat(text).toFixed(3); }
  if (format == "0.0000") { return parseFloat(text).toFixed(4); }
  return text;
}
