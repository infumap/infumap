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

import { Component, Match, Show, Switch } from "solid-js";
import { InfuIconButton } from "../../library/InfuIconButton";
import { itemCanEdit } from "../../../items/base/capabilities-item";
import { NoteFns, NoteInlineMarkFlags, NoteTextStyle, asNoteItem } from "../../../items/note-item";
import { CompositeFlags, getNoteIndentLevel, NoteFlags } from "../../../items/base/flags-item";
import { useStore } from "../../../store/StoreProvider";
import { asCompositeItem, isComposite } from "../../../items/composite-item";
import { ToolbarPopupType } from "../../../store/StoreProvider_Overlay";
import { ClickState } from "../../../input/state";
import { requestArrange } from "../../../layout/arrange";
import { TransientMessageType } from "../../../store/StoreProvider_Overlay";
import { GRID_SIZE } from "../../../constants";
import { itemState } from "../../../store/ItemState";
import { isTable } from "../../../items/table-item";
import { Toolbar_ItemOrdering } from "./Toolbar_ItemOrdering";
import { getToolbarFocusItem, getToolbarFocusPathMaybe } from "../toolbarFocus";
import { toggleActiveNoteInlineMark } from "../../../input/edit";
import { ArrangeAlgorithm, asPageItem, isPage } from "../../../items/page-item";
import { VeFns } from "../../../layout/visual-element";
import { VesCache } from "../../../layout/ves-cache";


export const Toolbar_Note: Component = () => {
  const store = useStore();

  let textStyleDiv: HTMLDivElement | undefined;
  let indentDiv: HTMLDivElement | undefined;
  let beforeUrlElement: HTMLDivElement | undefined;
  let qrDiv: HTMLDivElement | undefined;
  let urlDiv: HTMLDivElement | undefined;
  let popupIconDiv: HTMLDivElement | undefined;

  const noteItem = () => {
    store.touchToolbarDependency();
    return asNoteItem(getToolbarFocusItem(store));
  };
  const canEdit = () => itemCanEdit(noteItem());
  const compositeItemMaybe = () => {
    const parentItem = itemState.get(noteItem().parentId);
    if (!parentItem || !isComposite(parentItem)) { return null; }
    return asCompositeItem(parentItem);
  };

  const touchToolbar = () => {
    store.touchToolbar();
  };

  const isInTable = (): boolean => {
    let parentId = noteItem().parentId;
    while (parentId) {
      const parentItem = itemState.get(parentId);
      if (!parentItem) { return false; }
      if (isTable(parentItem)) { return true; }
      if (parentItem.parentId == null || parentItem.parentId === parentId) { return false; }
      parentId = parentItem.parentId;
    }
    return false;
  };

  const isInDocumentPage = (): boolean => {
    const focusPath = getToolbarFocusPathMaybe(store);
    if (focusPath == null) { return false; }

    let currentPath: string | null = VeFns.parentPath(focusPath);
    while (currentPath != null && currentPath != "") {
      const currentVe = VesCache.current.readNode(currentPath);
      if (currentVe == null) { return false; }
      if (isPage(currentVe.displayItem) && asPageItem(currentVe.displayItem).arrangeAlgorithm == ArrangeAlgorithm.Document) {
        return true;
      }
      currentPath = currentVe.parentPath;
    }

    return false;
  };

  const selectAlignLeft = () => { NoteFns.clearAlignmentFlags(noteItem()); requestArrange(store, "toolbar-note-alignment"); touchToolbar(); };
  const selectAlignCenter = () => { NoteFns.clearAlignmentFlags(noteItem()); noteItem().flags |= NoteFlags.AlignCenter; requestArrange(store, "toolbar-note-alignment"); touchToolbar(); };
  const selectAlignRight = () => { NoteFns.clearAlignmentFlags(noteItem()); noteItem().flags |= NoteFlags.AlignRight; requestArrange(store, "toolbar-note-alignment"); touchToolbar(); };
  const selectAlignJustify = () => { NoteFns.clearAlignmentFlags(noteItem()); noteItem().flags |= NoteFlags.AlignJustify; requestArrange(store, "toolbar-note-alignment"); touchToolbar(); };
  const toggleBold = () => { toggleActiveNoteInlineMark(store, NoteInlineMarkFlags.Bold); };
  const toggleItalic = () => { toggleActiveNoteInlineMark(store, NoteInlineMarkFlags.Italic); };
  const inlineMarkHighlighted = (flag: NoteInlineMarkFlags): boolean => {
    const textEditInfo = store.overlay.textEditInfo();
    const selectionInfo = store.overlay.noteTextSelectionInfo.get();
    return textEditInfo != null &&
      selectionInfo != null &&
      textEditInfo.itemPath == selectionInfo.itemPath &&
      !!(selectionInfo.typingFlags & flag);
  };
  const noteUrlSelection = () => {
    const selectionInfo = store.overlay.noteTextSelectionInfo.get();
    if (selectionInfo == null || selectionInfo.itemPath != getToolbarFocusPathMaybe(store)) { return null; }
    return selectionInfo;
  };
  const noteUrlHighlighted = (): boolean => {
    return NoteFns.urlForToolbarEdit(noteItem(), noteUrlSelection()).trim() != "";
  };

  const borderVisible = (): boolean => {
    if (compositeItemMaybe() != null) {
      return (compositeItemMaybe()!.flags & CompositeFlags.HideBorder) ? false : true;
    }
    return (noteItem().flags & NoteFlags.HideBorder) ? false : true;
  }

  const copyButtonHandler = (): void => {
    if (noteItem().flags & NoteFlags.ShowCopyIcon) {
      noteItem().flags &= ~NoteFlags.ShowCopyIcon;
    } else {
      noteItem().flags |= NoteFlags.ShowCopyIcon;
    }
    requestArrange(store, "toolbar-note-copy-icon");
    touchToolbar();
  };

  const borderButtonHandler = (): void => {
    if (compositeItemMaybe() != null) {
      if (compositeItemMaybe()!.flags & CompositeFlags.HideBorder) {
        compositeItemMaybe()!.flags &= ~CompositeFlags.HideBorder;
      } else {
        compositeItemMaybe()!.flags |= CompositeFlags.HideBorder;
      }
    } else {
      if (noteItem().flags & NoteFlags.HideBorder) {
        noteItem().flags &= ~NoteFlags.HideBorder;
      } else {
        noteItem().flags |= NoteFlags.HideBorder;
      }
    }
    requestArrange(store, "toolbar-note-border");
    touchToolbar();
  };

  const explicitHeightEnabled = (): boolean => {
    return (noteItem().flags & NoteFlags.ExplicitHeight) ? true : false;
  }

  const popupIconVisible = (): boolean => {
    return NoteFns.showsIcon(noteItem());
  }

  const explicitHeightButtonHandler = (): void => {
    if (noteItem().flags & NoteFlags.ExplicitHeight) {
      noteItem().flags &= ~NoteFlags.ExplicitHeight;
      noteItem().spatialHeightGr = 0;
    } else {
      const naturalDims = NoteFns.calcSpatialDimensionsBl(noteItem());
      noteItem().flags |= NoteFlags.ExplicitHeight;
      noteItem().spatialHeightGr = naturalDims.h * GRID_SIZE;
    }
    requestArrange(store, "toolbar-note-explicit-height");
    touchToolbar();
  };

  const popupIconButtonHandler = (): void => {
    if (store.overlay.toolbarPopupInfoMaybe.get() != null && store.overlay.toolbarPopupInfoMaybe.get()!.type == ToolbarPopupType.ItemIcon) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      return;
    }
    store.overlay.toolbarPopupInfoMaybe.set(
      { topLeftPx: { x: popupIconDiv!.getBoundingClientRect().x, y: popupIconDiv!.getBoundingClientRect().y + 20 }, type: ToolbarPopupType.ItemIcon });
  };
  const handlePopupIconDown = () => {
    ClickState.setButtonClickBoundsPx(popupIconDiv!.getBoundingClientRect());
  };

  // QR
  const handleQr = () => {
    if (store.overlay.toolbarPopupInfoMaybe.get() != null && store.overlay.toolbarPopupInfoMaybe.get()!.type == ToolbarPopupType.QrLink) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      return;
    }
    store.overlay.toolbarPopupInfoMaybe.set(
      { topLeftPx: { x: qrDiv!.getBoundingClientRect().x, y: qrDiv!.getBoundingClientRect().y + 38 }, type: ToolbarPopupType.QrLink });
  }
  const handleQrDown = () => {
    ClickState.setButtonClickBoundsPx(qrDiv!.getBoundingClientRect());
  };

  const handleCopyId = () => {
    navigator.clipboard.writeText(noteItem().id);
    store.overlay.toolbarTransientMessage.set({ text: "note id → clipboard", type: TransientMessageType.Info });
    setTimeout(() => { store.overlay.toolbarTransientMessage.set(null); }, 1000);
  }

  // URL
  const urlButtonHandler = () => {
    if (store.overlay.toolbarPopupInfoMaybe.get() != null && store.overlay.toolbarPopupInfoMaybe.get()!.type == ToolbarPopupType.NoteUrl) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      return;
    }
    store.overlay.toolbarPopupInfoMaybe.set(
      { topLeftPx: { x: beforeUrlElement!.getBoundingClientRect().x, y: beforeUrlElement!.getBoundingClientRect().y + 20 }, type: ToolbarPopupType.NoteUrl });
  }
  const handleUrlDown = () => {
    ClickState.setButtonClickBoundsPx(urlDiv!.getBoundingClientRect());
  };

  const textStyleButtonHandler = () => {
    if (store.overlay.toolbarPopupInfoMaybe.get() != null && store.overlay.toolbarPopupInfoMaybe.get()!.type == ToolbarPopupType.NoteTextStyle) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      return;
    }
    store.overlay.toolbarPopupInfoMaybe.set(
      { topLeftPx: { x: textStyleDiv!.getBoundingClientRect().x, y: textStyleDiv!.getBoundingClientRect().y + 35 }, type: ToolbarPopupType.NoteTextStyle });
  };
  const handleTextStyleDown = () => {
    ClickState.setButtonClickBoundsPx(textStyleDiv!.getBoundingClientRect());
  };

  const indentButtonHandler = () => {
    if (store.overlay.toolbarPopupInfoMaybe.get() != null && store.overlay.toolbarPopupInfoMaybe.get()!.type == ToolbarPopupType.NoteIndent) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      return;
    }
    store.overlay.toolbarPopupInfoMaybe.set(
      { topLeftPx: { x: indentDiv!.getBoundingClientRect().x, y: indentDiv!.getBoundingClientRect().y + 35 }, type: ToolbarPopupType.NoteIndent });
  };
  const handleIndentDown = () => {
    ClickState.setButtonClickBoundsPx(indentDiv!.getBoundingClientRect());
  };

  const textStyleText = () => {
    store.touchToolbarDependency();
    const style = NoteFns.textStyle(noteItem());
    if (style == NoteTextStyle.Heading1) { return "h1"; }
    if (style == NoteTextStyle.Heading2) { return "h2"; }
    if (style == NoteTextStyle.Heading3) { return "h3"; }
    if (style == NoteTextStyle.Heading4) { return "h4"; }
    if (style == NoteTextStyle.Bullet) { return "bullet"; }
    if (style == NoteTextStyle.Numbered) { return "number"; }
    if (style == NoteTextStyle.Code) { return "code"; }
    return "text";
  };

  const renderTextStyleSelector = () =>
    <div ref={textStyleDiv}
      class="inline-block w-[70px] border border-slate-400 rounded-md ml-[3px] cursor-pointer"
      style={`font-size: 13px;`}>
      <div class="inline-block w-[68px] pl-[6px] hover:bg-slate-300"
        onClick={textStyleButtonHandler}
        onMouseDown={handleTextStyleDown}>
        {textStyleText()}
      </div>
    </div>;

  const renderIndentSelector = () =>
    <Show when={NoteFns.textStyle(noteItem()) == NoteTextStyle.Bullet || NoteFns.textStyle(noteItem()) == NoteTextStyle.Numbered}>
      <div ref={indentDiv}
        class="inline-block w-[45px] border border-slate-400 rounded-md ml-[6px] cursor-pointer hover:bg-slate-300"
        style={`font-size: 13px;`}
        onClick={indentButtonHandler}
        onMouseDown={handleIndentDown}>
        <i class="bi-text-indent-left ml-[4px]" />
        <div class="inline-block w-[18px] pl-[4px] text-right">
          {getNoteIndentLevel(noteItem()) + 1}
        </div>
      </div>
    </Show>;

  const renderSingleNoteToolbox = () =>
    <div class="inline-block">
      <Show when={canEdit() && store.user.getUserMaybe() != null && store.user.getUser().userId == noteItem().ownerId}>
        {renderTextStyleSelector()}
        {renderIndentSelector()}
        <div class="inline-block ml-[12px]"></div>
        <InfuIconButton icon="fa fa-bold" highlighted={inlineMarkHighlighted(NoteInlineMarkFlags.Bold)} clickHandler={toggleBold} title="Bold" />
        <InfuIconButton icon="fa fa-italic" highlighted={inlineMarkHighlighted(NoteInlineMarkFlags.Italic)} clickHandler={toggleItalic} title="Italic" />
        <div class="inline-block ml-[12px]"></div>
        <InfuIconButton icon="fa fa-align-left" highlighted={NoteFns.isAlignedLeft(noteItem())} clickHandler={selectAlignLeft} />
        <InfuIconButton icon="fa fa-align-center" highlighted={(noteItem().flags & NoteFlags.AlignCenter) ? true : false} clickHandler={selectAlignCenter} />
        <InfuIconButton icon="fa fa-align-right" highlighted={(noteItem().flags & NoteFlags.AlignRight) ? true : false} clickHandler={selectAlignRight} />
        <InfuIconButton icon="fa fa-align-justify" highlighted={(noteItem().flags & NoteFlags.AlignJustify) ? true : false} clickHandler={selectAlignJustify} />
        <div ref={beforeUrlElement} class="inline-block ml-[12px]"></div>
        <div ref={urlDiv} class="inline-block"
          onMouseDown={handleUrlDown}>
          <InfuIconButton icon="fa fa-link" highlighted={noteUrlHighlighted()} clickHandler={urlButtonHandler} />
        </div>
        <Show when={isInTable()}>
          <InfuIconButton icon="fa fa-copy" highlighted={(noteItem().flags & NoteFlags.ShowCopyIcon) ? true : false} clickHandler={copyButtonHandler} />
        </Show>
        <div ref={popupIconDiv} class="inline-block"
          onMouseDown={handlePopupIconDown}>
          <InfuIconButton icon="fa fa-icons" highlighted={popupIconVisible()} clickHandler={popupIconButtonHandler} title="Item icon" />
        </div>
        <Show when={!isInTable()}>
          <InfuIconButton icon="fa fa-square" highlighted={borderVisible()} clickHandler={borderButtonHandler} />
          <Show when={!isInDocumentPage()}>
            <InfuIconButton icon="fa fa-arrows-v" highlighted={explicitHeightEnabled()} clickHandler={explicitHeightButtonHandler} />
          </Show>
        </Show>
      </Show>

      <Toolbar_ItemOrdering />

      {/* spacer line. TODO (LOW): don't use fixed layout for this. */}
      <div class="fixed border-r border-slate-300" style="height: 25px; right: 151px; top: 7px;"></div>

      <div ref={qrDiv} class="inline-block pl-[20px]" onMouseDown={handleQrDown}>
        <InfuIconButton icon="bi-info-circle-fill" highlighted={false} clickHandler={handleQr} />
      </div>
      <div class="inline-block">
        <InfuIconButton icon="fa fa-hashtag" highlighted={false} clickHandler={handleCopyId} />
      </div>

    </div>;

  const renderCompositeToolbox = () =>
    <div class="inline-block">
      <Show when={canEdit() && store.user.getUserMaybe() != null && store.user.getUser().userId == noteItem().ownerId}>
        {renderTextStyleSelector()}
        {renderIndentSelector()}
        <div class="inline-block ml-[12px]"></div>
        <InfuIconButton icon="fa fa-bold" highlighted={inlineMarkHighlighted(NoteInlineMarkFlags.Bold)} clickHandler={toggleBold} title="Bold" />
        <InfuIconButton icon="fa fa-italic" highlighted={inlineMarkHighlighted(NoteInlineMarkFlags.Italic)} clickHandler={toggleItalic} title="Italic" />
        <div class="inline-block ml-[12px]"></div>
        <InfuIconButton icon="fa fa-align-left" highlighted={NoteFns.isAlignedLeft(noteItem())} clickHandler={selectAlignLeft} />
        <InfuIconButton icon="fa fa-align-center" highlighted={(noteItem().flags & NoteFlags.AlignCenter) ? true : false} clickHandler={selectAlignCenter} />
        <InfuIconButton icon="fa fa-align-right" highlighted={(noteItem().flags & NoteFlags.AlignRight) ? true : false} clickHandler={selectAlignRight} />
        <InfuIconButton icon="fa fa-align-justify" highlighted={(noteItem().flags & NoteFlags.AlignJustify) ? true : false} clickHandler={selectAlignJustify} />
        <div ref={beforeUrlElement} class="inline-block ml-[12px]"></div>
        <div ref={urlDiv} class="inline-block"
          onMouseDown={handleUrlDown}>
          <InfuIconButton icon="fa fa-link" highlighted={noteUrlHighlighted()} clickHandler={urlButtonHandler} />
        </div>
        <Show when={isInTable()}>
          <InfuIconButton icon="fa fa-copy" highlighted={(noteItem().flags & NoteFlags.ShowCopyIcon) ? true : false} clickHandler={copyButtonHandler} />
        </Show>
        <div class="inline-block">
          <InfuIconButton icon="fa fa-square" highlighted={borderVisible()} clickHandler={borderButtonHandler} />
        </div>
      </Show>

      <Toolbar_ItemOrdering />

      {/* spacer line. TODO (LOW): don't use fixed layout for this. */}
      <div class="fixed border-r border-slate-300" style="height: 25px; right: 151px; top: 7px;"></div>

      <div ref={qrDiv} class="inline-block pl-[20px]" onMouseDown={handleQrDown}>
        <InfuIconButton icon="bi-info-circle-fill" highlighted={false} clickHandler={handleQr} />
      </div>
      <div class="inline-block">
        <InfuIconButton icon="fa fa-hashtag" highlighted={false} clickHandler={handleCopyId} />
      </div>

    </div>;

  return (
    <div id="toolbarItemOptionsDiv"
      class="grow-0" style="flex-order: 0">
      <Switch>
        <Match when={compositeItemMaybe() == null}>{renderSingleNoteToolbox()}</Match>
        <Match when={compositeItemMaybe() != null}>{renderCompositeToolbox()}</Match>
      </Switch>
    </div>
  );
}
