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
import { InfuIconButton } from "../library/InfuIconButton";
import { NoteFns, asNoteItem } from "../../items/note-item";
import { CompositeFlags, NoteFlags } from "../../items/base/flags-item";
import { VesCache } from "../../layout/ves-cache";
import { useStore } from "../../store/StoreProvider";
import { VeFns } from "../../layout/visual-element";
import { arrange } from "../../layout/arrange";
import { asCompositeItem, isComposite } from "../../items/composite-item";
import { ToolbarOverlayType } from "../../store/StoreProvider_Overlay";

export const Toolbar_Note: Component = () => {
  const store = useStore();

  let beforeFormatElement : HTMLDivElement | undefined;

  const noteVisualElement = () => VesCache.get(store.overlay.noteEditOverlayInfo.get()!.itemPath)!.get();
  const noteItem = () => asNoteItem(noteVisualElement().displayItem);

  const compositeVisualElementMaybe = () => {
    const parentVe = VesCache.get(noteVisualElement().parentPath!)!.get();
    if (!isComposite(parentVe.displayItem)) { return null; }
    return parentVe;
  };
  const compositeItemMaybe = () => {
    const compositeVeMaybe = compositeVisualElementMaybe();
    if (compositeVeMaybe == null) { return null; }
    return asCompositeItem(compositeVeMaybe.displayItem);
  };

  const isInTable = (): boolean => {
    return VeFns.isInTable(noteVisualElement());
  }

  const selectNormalText = () => { NoteFns.clearTextStyleFlags(noteItem()); arrange(store); };
  const selectHeading1 = () => { NoteFns.clearTextStyleFlags(noteItem()); noteItem().flags |= NoteFlags.Heading1; arrange(store); };
  const selectHeading2 = () => { NoteFns.clearTextStyleFlags(noteItem()); noteItem().flags |= NoteFlags.Heading2; arrange(store); };
  const selectHeading3 = () => { NoteFns.clearTextStyleFlags(noteItem()); noteItem().flags |= NoteFlags.Heading3; arrange(store); };
  const selectBullet1 = () => { NoteFns.clearTextStyleFlags(noteItem()); noteItem().flags |= NoteFlags.Bullet1; arrange(store); };
  const selectCode = () => { NoteFns.clearTextStyleFlags(noteItem()); noteItem().flags |= NoteFlags.Code; arrange(store); };

  const selectAlignLeft = () => { NoteFns.clearAlignmentFlags(noteItem()); arrange(store); };
  const selectAlignCenter = () => { NoteFns.clearAlignmentFlags(noteItem()); noteItem().flags |= NoteFlags.AlignCenter; arrange(store); };
  const selectAlignRight = () => { NoteFns.clearAlignmentFlags(noteItem()); noteItem().flags |= NoteFlags.AlignRight; arrange(store); };
  const selectAlignJustify = () => { NoteFns.clearAlignmentFlags(noteItem()); noteItem().flags |= NoteFlags.AlignJustify; arrange(store); };

  const urlButtonHandler = () => { store.overlay.toolbarOverlayInfoMaybe.set({ topLeftPx: { x: beforeFormatElement!.getBoundingClientRect().x, y: beforeFormatElement!.getBoundingClientRect().y }, type: ToolbarOverlayType.NoteUrl }); }

  const formatHandler = () => { store.overlay.toolbarOverlayInfoMaybe.set({ topLeftPx: { x: beforeFormatElement!.getBoundingClientRect().x, y: beforeFormatElement!.getBoundingClientRect().y }, type: ToolbarOverlayType.NoteFormat }); }

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
    arrange(store);
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
    arrange(store);
  };

  const handleQr = () => {
    store.overlay.toolbarOverlayInfoMaybe.set(
      { topLeftPx: { x: 0, y: 0 }, type: ToolbarOverlayType.Ids });
  }

  const renderSingleNoteToolbox = () =>
    <div class="inline-block">
      <Show when={store.user.getUserMaybe() != null && store.user.getUser().userId == noteItem().ownerId}>
        <InfuIconButton icon="fa fa-font" highlighted={NoteFns.isStyleNormalText(noteItem())} clickHandler={selectNormalText} />
        <Show when={!isInTable()}>
          <InfuIconButton icon="bi-type-h1" highlighted={(noteItem().flags & NoteFlags.Heading1) ? true : false} clickHandler={selectHeading1} />
          <InfuIconButton icon="bi-type-h2" highlighted={(noteItem().flags & NoteFlags.Heading2) ? true : false} clickHandler={selectHeading2} />
        </Show>
        <InfuIconButton icon="bi-type-h3" highlighted={(noteItem().flags & NoteFlags.Heading3) ? true : false} clickHandler={selectHeading3} />
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
        <InfuIconButton icon={`fa fa-asterisk`} highlighted={false} clickHandler={formatHandler} />
        <InfuIconButton icon="fa fa-link" highlighted={noteItem().url != ""} clickHandler={urlButtonHandler} />
        <Show when={isInTable()}>
          <InfuIconButton icon="fa fa-copy" highlighted={(noteItem().flags & NoteFlags.ShowCopyIcon) ? true : false} clickHandler={copyButtonHandler} />
        </Show>
        <Show when={!isInTable()}>
          <InfuIconButton icon="fa fa-square" highlighted={borderVisible()} clickHandler={borderButtonHandler} />
        </Show>
      </Show>
      <div class="pl-[4px] inline-block">
        <InfuIconButton icon="bi-qr-code" highlighted={false} clickHandler={handleQr} />
      </div>
    </div>;

  const renderCompositeToolbox = () =>
    <>
      <div class="inline-block">
        <Show when={store.user.getUserMaybe() != null && store.user.getUser().userId == noteItem().ownerId}>
          <InfuIconButton icon="fa fa-font" highlighted={NoteFns.isStyleNormalText(noteItem())} clickHandler={selectNormalText} />
          <InfuIconButton icon="bi-type-h1" highlighted={(noteItem().flags & NoteFlags.Heading1) ? true : false} clickHandler={selectHeading1} />
          <InfuIconButton icon="bi-type-h2" highlighted={(noteItem().flags & NoteFlags.Heading2) ? true : false} clickHandler={selectHeading2} />
          <InfuIconButton icon="bi-type-h3" highlighted={(noteItem().flags & NoteFlags.Heading3) ? true : false} clickHandler={selectHeading3} />
          <InfuIconButton icon="fa fa-list" highlighted={(noteItem().flags & NoteFlags.Bullet1) ? true : false} clickHandler={selectBullet1} />
          <InfuIconButton icon="fa fa-code" highlighted={(noteItem().flags & NoteFlags.Code) ? true : false} clickHandler={selectCode} />
          <div class="inline-block ml-[20px]"></div>
          <InfuIconButton icon="fa fa-align-left" highlighted={NoteFns.isAlignedLeft(noteItem())} clickHandler={selectAlignLeft} />
          <InfuIconButton icon="fa fa-align-center" highlighted={(noteItem().flags & NoteFlags.AlignCenter) ? true : false} clickHandler={selectAlignCenter} />
          <InfuIconButton icon="fa fa-align-right" highlighted={(noteItem().flags & NoteFlags.AlignRight) ? true : false} clickHandler={selectAlignRight} />
          <InfuIconButton icon="fa fa-align-justify" highlighted={(noteItem().flags & NoteFlags.AlignJustify) ? true : false} clickHandler={selectAlignJustify} />
          <div ref={beforeFormatElement} class="inline-block ml-[12px]"></div>
          <InfuIconButton icon={`fa fa-asterisk`} highlighted={false} clickHandler={formatHandler} />
          <InfuIconButton icon="fa fa-link" highlighted={noteItem().url != ""} clickHandler={urlButtonHandler} />
          <Show when={isInTable()}>
            <InfuIconButton icon="fa fa-copy" highlighted={(noteItem().flags & NoteFlags.ShowCopyIcon) ? true : false} clickHandler={copyButtonHandler} />
          </Show>
          <div class="inline-block">
            <InfuIconButton icon="fa fa-square" highlighted={borderVisible()} clickHandler={borderButtonHandler} />
          </div>
        </Show>
        <div class="pl-[4px] inline-block">
          <InfuIconButton icon="bi-qr-code" highlighted={false} clickHandler={handleQr} />
        </div>
      </div>
    </>;

  return (
    <>
      <div class="flex-grow-0" style="flex-order: 0">
        <Switch>
          <Match when={compositeItemMaybe() == null}>{renderSingleNoteToolbox()}</Match>
          <Match when={compositeItemMaybe() != null}>{renderCompositeToolbox()}</Match>
        </Switch>
      </div>
    </>
  );
}
