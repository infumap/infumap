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
import { NoteFns, asNoteItem } from "../../../items/note-item";
import { CompositeFlags, NoteFlags } from "../../../items/base/flags-item";
import { useStore } from "../../../store/StoreProvider";
import { asCompositeItem, isComposite } from "../../../items/composite-item";
import { ToolbarPopupType } from "../../../store/StoreProvider_Overlay";
import { ClickState } from "../../../input/state";
import { requestArrange } from "../../../layout/arrange";
import { TransientMessageType } from "../../../store/StoreProvider_Overlay";
import { GRID_SIZE } from "../../../constants";
import { itemState } from "../../../store/ItemState";
import { isTable } from "../../../items/table-item";


export const Toolbar_Note: Component = () => {
  const store = useStore();

  let beforeFormatElement: HTMLDivElement | undefined;
  let qrDiv: HTMLDivElement | undefined;
  let formatDiv: HTMLDivElement | undefined;
  let urlDiv: HTMLDivElement | undefined;

  const noteItem = () => {
    store.touchToolbarDependency();
    return asNoteItem(store.history.getFocusItem());
  };
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

  const selectNormalText = () => { NoteFns.clearTextStyleFlags(noteItem()); requestArrange(store, "toolbar-note-text-style"); touchToolbar(); };
  const selectHeading1 = () => { NoteFns.clearTextStyleFlags(noteItem()); noteItem().flags |= NoteFlags.Heading1; requestArrange(store, "toolbar-note-text-style"); touchToolbar(); };
  const selectHeading2 = () => { NoteFns.clearTextStyleFlags(noteItem()); noteItem().flags |= NoteFlags.Heading2; requestArrange(store, "toolbar-note-text-style"); touchToolbar(); };
  const selectHeading3 = () => { NoteFns.clearTextStyleFlags(noteItem()); noteItem().flags |= NoteFlags.Heading3; requestArrange(store, "toolbar-note-text-style"); touchToolbar(); };
  const selectHeading4 = () => { NoteFns.clearTextStyleFlags(noteItem()); noteItem().flags |= NoteFlags.Heading4; requestArrange(store, "toolbar-note-text-style"); touchToolbar(); };
  const selectBullet1 = () => { NoteFns.clearTextStyleFlags(noteItem()); noteItem().flags |= NoteFlags.Bullet1; requestArrange(store, "toolbar-note-text-style"); touchToolbar(); };
  const selectCode = () => { NoteFns.clearTextStyleFlags(noteItem()); noteItem().flags |= NoteFlags.Code; requestArrange(store, "toolbar-note-text-style"); touchToolbar(); };

  const selectAlignLeft = () => { NoteFns.clearAlignmentFlags(noteItem()); requestArrange(store, "toolbar-note-alignment"); touchToolbar(); };
  const selectAlignCenter = () => { NoteFns.clearAlignmentFlags(noteItem()); noteItem().flags |= NoteFlags.AlignCenter; requestArrange(store, "toolbar-note-alignment"); touchToolbar(); };
  const selectAlignRight = () => { NoteFns.clearAlignmentFlags(noteItem()); noteItem().flags |= NoteFlags.AlignRight; requestArrange(store, "toolbar-note-alignment"); touchToolbar(); };
  const selectAlignJustify = () => { NoteFns.clearAlignmentFlags(noteItem()); noteItem().flags |= NoteFlags.AlignJustify; requestArrange(store, "toolbar-note-alignment"); touchToolbar(); };

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

  const desktopPopupIconVisible = (): boolean => {
    return NoteFns.showsDesktopPopupIcon(noteItem());
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

  const desktopPopupIconButtonHandler = (): void => {
    if (desktopPopupIconVisible()) {
      noteItem().flags &= ~NoteFlags.ShowDesktopPopupIcon;
    } else {
      noteItem().flags |= NoteFlags.ShowDesktopPopupIcon;
    }
    requestArrange(store, "toolbar-note-desktop-popup-icon");
    touchToolbar();
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
      { topLeftPx: { x: beforeFormatElement!.getBoundingClientRect().x, y: beforeFormatElement!.getBoundingClientRect().y + 20 }, type: ToolbarPopupType.NoteUrl });
  }
  const handleUrlDown = () => {
    ClickState.setButtonClickBoundsPx(urlDiv!.getBoundingClientRect());
  };

  // Format
  const formatHandler = () => {
    if (store.overlay.toolbarPopupInfoMaybe.get() != null && store.overlay.toolbarPopupInfoMaybe.get()!.type == ToolbarPopupType.NoteFormat) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      return;
    }
    store.overlay.toolbarPopupInfoMaybe.set(
      { topLeftPx: { x: beforeFormatElement!.getBoundingClientRect().x, y: beforeFormatElement!.getBoundingClientRect().y + 20 }, type: ToolbarPopupType.NoteFormat });
  }
  const handleFormatDown = () => {
    ClickState.setButtonClickBoundsPx(formatDiv!.getBoundingClientRect());
  };

  const renderSingleNoteToolbox = () =>
    <div class="inline-block">
      <Show when={store.user.getUserMaybe() != null && store.user.getUser().userId == noteItem().ownerId}>
        <InfuIconButton icon="fa fa-font" highlighted={NoteFns.isStyleNormalText(noteItem())} clickHandler={selectNormalText} />
        <Show when={!isInTable()}>
          <InfuIconButton icon="bi-type-h1" highlighted={(noteItem().flags & NoteFlags.Heading1) ? true : false} clickHandler={selectHeading1} />
          <InfuIconButton icon="bi-type-h2" highlighted={(noteItem().flags & NoteFlags.Heading2) ? true : false} clickHandler={selectHeading2} />
        </Show>
        <InfuIconButton icon="bi-type-h3" highlighted={(noteItem().flags & NoteFlags.Heading3) ? true : false} clickHandler={selectHeading3} />
        <InfuIconButton icon="bi-type-h4" highlighted={(noteItem().flags & NoteFlags.Heading4) ? true : false} clickHandler={selectHeading4} />
        <Show when={!isInTable()}>
          <InfuIconButton icon="fa fa-list" highlighted={(noteItem().flags & NoteFlags.Bullet1) ? true : false} clickHandler={selectBullet1} />
        </Show>
        <InfuIconButton icon="fa fa-code" highlighted={(noteItem().flags & NoteFlags.Code) ? true : false} clickHandler={selectCode} />
        <div class="inline-block ml-[20px]"></div>
        <InfuIconButton icon="fa fa-align-left" highlighted={NoteFns.isAlignedLeft(noteItem())} clickHandler={selectAlignLeft} />
        <InfuIconButton icon="fa fa-align-center" highlighted={(noteItem().flags & NoteFlags.AlignCenter) ? true : false} clickHandler={selectAlignCenter} />
        <InfuIconButton icon="fa fa-align-right" highlighted={(noteItem().flags & NoteFlags.AlignRight) ? true : false} clickHandler={selectAlignRight} />
        <InfuIconButton icon="fa fa-align-justify" highlighted={(noteItem().flags & NoteFlags.AlignJustify) ? true : false} clickHandler={selectAlignJustify} />
        <div ref={beforeFormatElement} class="inline-block ml-[12px]"></div>
        <div ref={formatDiv} class="inline-block"
          onMouseDown={handleFormatDown}>
          <InfuIconButton icon={`fa fa-asterisk`} highlighted={false} clickHandler={formatHandler} />
        </div>
        <div ref={urlDiv} class="inline-block"
          onMouseDown={handleUrlDown}>
          <InfuIconButton icon="fa fa-link" highlighted={noteItem().url != ""} clickHandler={urlButtonHandler} />
        </div>
        <Show when={isInTable()}>
          <InfuIconButton icon="fa fa-copy" highlighted={(noteItem().flags & NoteFlags.ShowCopyIcon) ? true : false} clickHandler={copyButtonHandler} />
        </Show>
        <Show when={!isInTable()}>
          <InfuIconButton icon="fa fa-sticky-note" highlighted={desktopPopupIconVisible()} clickHandler={desktopPopupIconButtonHandler} />
          <InfuIconButton icon="fa fa-square" highlighted={borderVisible()} clickHandler={borderButtonHandler} />
          <InfuIconButton icon="fa fa-arrows-v" highlighted={explicitHeightEnabled()} clickHandler={explicitHeightButtonHandler} />
        </Show>
      </Show>

      {/* spacer line. TODO (LOW): don't use fixed layout for this. */}
      <div class="fixed border-r border-slate-300" style="height: 25px; right: 151px; top: 7px;"></div>

      <div ref={qrDiv} class="inline-block pl-[18px]" onMouseDown={handleQrDown}>
        <InfuIconButton icon="bi-info-circle-fill" highlighted={false} clickHandler={handleQr} />
      </div>
      <div class="inline-block">
        <InfuIconButton icon="fa fa-hashtag" highlighted={false} clickHandler={handleCopyId} />
      </div>

    </div>;

  const renderCompositeToolbox = () =>
    <div class="inline-block">
      <Show when={store.user.getUserMaybe() != null && store.user.getUser().userId == noteItem().ownerId}>
        <InfuIconButton icon="fa fa-font" highlighted={NoteFns.isStyleNormalText(noteItem())} clickHandler={selectNormalText} />
        <InfuIconButton icon="bi-type-h1" highlighted={(noteItem().flags & NoteFlags.Heading1) ? true : false} clickHandler={selectHeading1} />
        <InfuIconButton icon="bi-type-h2" highlighted={(noteItem().flags & NoteFlags.Heading2) ? true : false} clickHandler={selectHeading2} />
        <InfuIconButton icon="bi-type-h3" highlighted={(noteItem().flags & NoteFlags.Heading3) ? true : false} clickHandler={selectHeading3} />
        <InfuIconButton icon="bi-type-h4" highlighted={(noteItem().flags & NoteFlags.Heading4) ? true : false} clickHandler={selectHeading4} />
        <InfuIconButton icon="fa fa-list" highlighted={(noteItem().flags & NoteFlags.Bullet1) ? true : false} clickHandler={selectBullet1} />
        <InfuIconButton icon="fa fa-code" highlighted={(noteItem().flags & NoteFlags.Code) ? true : false} clickHandler={selectCode} />
        <div class="inline-block ml-[20px]"></div>
        <InfuIconButton icon="fa fa-align-left" highlighted={NoteFns.isAlignedLeft(noteItem())} clickHandler={selectAlignLeft} />
        <InfuIconButton icon="fa fa-align-center" highlighted={(noteItem().flags & NoteFlags.AlignCenter) ? true : false} clickHandler={selectAlignCenter} />
        <InfuIconButton icon="fa fa-align-right" highlighted={(noteItem().flags & NoteFlags.AlignRight) ? true : false} clickHandler={selectAlignRight} />
        <InfuIconButton icon="fa fa-align-justify" highlighted={(noteItem().flags & NoteFlags.AlignJustify) ? true : false} clickHandler={selectAlignJustify} />
        <div ref={beforeFormatElement} class="inline-block ml-[12px]"></div>
        <div ref={formatDiv} class="inline-block"
          onMouseDown={handleFormatDown}>
          <InfuIconButton icon={`fa fa-asterisk`} highlighted={false} clickHandler={formatHandler} />
        </div>
        <div ref={urlDiv} class="inline-block"
          onMouseDown={handleUrlDown}>
          <InfuIconButton icon="fa fa-link" highlighted={noteItem().url != ""} clickHandler={urlButtonHandler} />
        </div>
        <Show when={isInTable()}>
          <InfuIconButton icon="fa fa-copy" highlighted={(noteItem().flags & NoteFlags.ShowCopyIcon) ? true : false} clickHandler={copyButtonHandler} />
        </Show>
        <div class="inline-block">
          <InfuIconButton icon="fa fa-square" highlighted={borderVisible()} clickHandler={borderButtonHandler} />
        </div>
      </Show>

      {/* spacer line. TODO (LOW): don't use fixed layout for this. */}
      <div class="fixed border-r border-slate-300" style="height: 25px; right: 151px; top: 7px;"></div>

      <div ref={qrDiv} class="inline-block pl-[18px]" onMouseDown={handleQrDown}>
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
