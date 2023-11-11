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
import { useUserStore } from "../../../store/UserStoreProvider";
import { NoteFns, asNoteItem } from "../../../items/note-item";
import { CompositeFlags, NoteFlags } from "../../../items/base/flags-item";
import { VesCache } from "../../../layout/ves-cache";
import { useDesktopStore } from "../../../store/DesktopStoreProvider";
import { VeFns, VisualElementFlags } from "../../../layout/visual-element";
import { arrange } from "../../../layout/arrange";
import { asCompositeItem, isComposite } from "../../../items/composite-item";
import { PlaceholderFns } from "../../../items/placeholder-item";
import { RelationshipToParent } from "../../../layout/relationship-to-parent";
import { itemState } from "../../../store/ItemState";
import { server } from "../../../server";


export const Toolbar_TextEdit: Component = () => {
  const desktopStore = useDesktopStore();
  const userStore = useUserStore();

  const noteVisualElement = () => VesCache.get(desktopStore.textEditOverlayInfo()!.itemPath)!.get();
  const noteItem = () => asNoteItem(noteVisualElement().displayItem);
  const noteItemOnInitialize = noteItem();

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
    const compositeItemOnInitializeMaybe = compositeItemMaybe();

  const isInTable = (): boolean => {
    return VeFns.isInTable(noteVisualElement());
  }

  const selectNormalText = () => { NoteFns.clearTextStyleFlags(noteItem()); arrange(desktopStore); };
  const selectHeading1 = () => { NoteFns.clearTextStyleFlags(noteItem()); noteItem().flags |= NoteFlags.Heading1; arrange(desktopStore); };
  const selectHeading2 = () => { NoteFns.clearTextStyleFlags(noteItem()); noteItem().flags |= NoteFlags.Heading2; arrange(desktopStore); };
  const selectHeading3 = () => { NoteFns.clearTextStyleFlags(noteItem()); noteItem().flags |= NoteFlags.Heading3; arrange(desktopStore); };
  const selectBullet1 = () => { NoteFns.clearTextStyleFlags(noteItem()); noteItem().flags |= NoteFlags.Bullet1; arrange(desktopStore); };
  const selectCode = () => { NoteFns.clearTextStyleFlags(noteItem()); noteItem().flags |= NoteFlags.Code; arrange(desktopStore); };

  const selectAlignLeft = () => { NoteFns.clearAlignmentFlags(noteItem()); arrange(desktopStore); };
  const selectAlignCenter = () => { NoteFns.clearAlignmentFlags(noteItem()); noteItem().flags |= NoteFlags.AlignCenter; arrange(desktopStore); };
  const selectAlignRight = () => { NoteFns.clearAlignmentFlags(noteItem()); noteItem().flags |= NoteFlags.AlignRight; arrange(desktopStore); };
  const selectAlignJustify = () => { NoteFns.clearAlignmentFlags(noteItem()); noteItem().flags |= NoteFlags.AlignJustify; arrange(desktopStore); };

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
    arrange(desktopStore);
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
    arrange(desktopStore);
  };

  let deleted = false;

  const deleteButtonHandler = async (): Promise<void> => {
    if (compositeItemMaybe() != null) {
      console.log("TODO: delete composite");
      // TODO (HIGH)

    } else {
      const noteParentVe = VesCache.get(noteVisualElement().parentPath!);
      if (noteParentVe!.get().flags & VisualElementFlags.InsideTable) {
        // must be an attachment item in a table.
        const placeholder = PlaceholderFns.create(noteParentVe!.get().displayItem.ownerId, noteParentVe!.get().displayItem.id, RelationshipToParent.Attachment, noteItem().ordering);
        itemState.add(placeholder);
        server.addItem(placeholder, null);
      }

      server.deleteItem(noteItem().id); // throws on failure.
      itemState.delete(noteItem().id);

      deleted = true;
      desktopStore.setTextEditOverlayInfo(null);
      arrange(desktopStore);
    }
  };


  const renderSingleNoteToolbox = () =>
    <div class="inline-block">
      <Show when={userStore.getUserMaybe() != null && userStore.getUser().userId == noteItem().ownerId}>
        <InfuIconButton icon="font" highlighted={NoteFns.isStyleNormalText(noteItem())} clickHandler={selectNormalText} />
        <Show when={!isInTable()}>
          <InfuIconButton icon="header-1" highlighted={(noteItem().flags & NoteFlags.Heading1) ? true : false} clickHandler={selectHeading1} />
          <InfuIconButton icon="header-2" highlighted={(noteItem().flags & NoteFlags.Heading2) ? true : false} clickHandler={selectHeading2} />
        </Show>
        <InfuIconButton icon="header-3" highlighted={(noteItem().flags & NoteFlags.Heading3) ? true : false} clickHandler={selectHeading3} />
        <Show when={!isInTable()}>
          <InfuIconButton icon="list" highlighted={(noteItem().flags & NoteFlags.Bullet1) ? true : false} clickHandler={selectBullet1} />
        </Show>
        <InfuIconButton icon="code" highlighted={(noteItem().flags & NoteFlags.Code) ? true : false} clickHandler={selectCode} />
        <div class="inline-block ml-[12px]"></div>
        <InfuIconButton icon="align-left" highlighted={NoteFns.isAlignedLeft(noteItem())} clickHandler={selectAlignLeft} />
        <InfuIconButton icon="align-center" highlighted={(noteItem().flags & NoteFlags.AlignCenter) ? true : false} clickHandler={selectAlignCenter} />
        <InfuIconButton icon="align-right" highlighted={(noteItem().flags & NoteFlags.AlignRight) ? true : false} clickHandler={selectAlignRight} />
        <InfuIconButton icon="align-justify" highlighted={(noteItem().flags & NoteFlags.AlignJustify) ? true : false} clickHandler={selectAlignJustify} />
        <div class="inline-block ml-[12px]"></div>
        {/* <InfuIconButton icon={`asterisk`} highlighted={false} clickHandler={formatHandler} />
        <InfuIconButton icon="link" highlighted={noteItem().url != ""} clickHandler={urlButtonHandler} /> */}
        <Show when={isInTable()}>
          <InfuIconButton icon="copy" highlighted={(noteItem().flags & NoteFlags.ShowCopyIcon) ? true : false} clickHandler={copyButtonHandler} />
        </Show>
        <Show when={!isInTable()}>
          <InfuIconButton icon="square" highlighted={borderVisible()} clickHandler={borderButtonHandler} />
        </Show>
      </Show>
      <Show when={userStore.getUserMaybe() != null && userStore.getUser().userId == noteItem().ownerId && noteVisualElement().linkItemMaybe == null}>
        <InfuIconButton icon="trash" highlighted={false} clickHandler={deleteButtonHandler} />
      </Show>
    </div>;

  const renderCompositeToolbox = () =>
    <>
      <div class="inline-block">
        <InfuIconButton icon="square" highlighted={borderVisible()} clickHandler={borderButtonHandler} />
        <Show when={userStore.getUserMaybe() != null && userStore.getUser().userId == noteItem().ownerId}>
          <InfuIconButton icon="trash" highlighted={false} clickHandler={deleteButtonHandler} />
        </Show>
      </div>
      <div class="inline-block">
        <Show when={userStore.getUserMaybe() != null && userStore.getUser().userId == noteItem().ownerId}>
          <InfuIconButton icon="font" highlighted={NoteFns.isStyleNormalText(noteItem())} clickHandler={selectNormalText} />
          <InfuIconButton icon="header-1" highlighted={(noteItem().flags & NoteFlags.Heading1) ? true : false} clickHandler={selectHeading1} />
          <InfuIconButton icon="header-2" highlighted={(noteItem().flags & NoteFlags.Heading2) ? true : false} clickHandler={selectHeading2} />
          <InfuIconButton icon="header-3" highlighted={(noteItem().flags & NoteFlags.Heading3) ? true : false} clickHandler={selectHeading3} />
          <InfuIconButton icon="list" highlighted={(noteItem().flags & NoteFlags.Bullet1) ? true : false} clickHandler={selectBullet1} />
          <InfuIconButton icon="code" highlighted={(noteItem().flags & NoteFlags.Code) ? true : false} clickHandler={selectCode} />
          <div class="inline-block ml-[12px]"></div>
          <InfuIconButton icon="align-left" highlighted={NoteFns.isAlignedLeft(noteItem())} clickHandler={selectAlignLeft} />
          <InfuIconButton icon="align-center" highlighted={(noteItem().flags & NoteFlags.AlignCenter) ? true : false} clickHandler={selectAlignCenter} />
          <InfuIconButton icon="align-right" highlighted={(noteItem().flags & NoteFlags.AlignRight) ? true : false} clickHandler={selectAlignRight} />
          <InfuIconButton icon="align-justify" highlighted={(noteItem().flags & NoteFlags.AlignJustify) ? true : false} clickHandler={selectAlignJustify} />
          <div class="inline-block ml-[12px]"></div>
          {/* <InfuIconButton icon={`asterisk`} highlighted={false} clickHandler={formatHandler} />
          <InfuIconButton icon="link" highlighted={noteItem().url != ""} clickHandler={urlButtonHandler} /> */}
          <Show when={isInTable()}>
            <InfuIconButton icon="copy" highlighted={(noteItem().flags & NoteFlags.ShowCopyIcon) ? true : false} clickHandler={copyButtonHandler} />
          </Show>
        </Show>
        <Show when={userStore.getUserMaybe() != null && userStore.getUser().userId == noteItem().ownerId}>
          <InfuIconButton icon="trash" highlighted={false} clickHandler={deleteButtonHandler} />
        </Show>
      </div>
    </>;

  return (
    <div class="inline-block p-[4px] flex-grow-0">
      <Switch>
        <Match when={compositeItemMaybe() == null}>{renderSingleNoteToolbox()}</Match>
        <Match when={compositeItemMaybe() != null}>{renderCompositeToolbox()}</Match>
      </Switch>
    </div>
  );
}
