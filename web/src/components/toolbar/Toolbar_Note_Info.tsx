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

import { Component, Show } from "solid-js";
import { asNoteItem } from "../../items/note-item";
import { VesCache } from "../../layout/ves-cache";
import { useDesktopStore } from "../../store/DesktopStoreProvider";
import { asCompositeItem, isComposite } from "../../items/composite-item";


export const Toolbar_Note_Info: Component = () => {
  const desktopStore = useDesktopStore();

  const noteVisualElement = () => VesCache.get(desktopStore.noteEditOverlayInfo.get()!.itemPath)!.get();
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

  const copyItemIdClickHandler = (): void => { navigator.clipboard.writeText(noteItem().id); }
  const linkItemIdClickHandler = (): void => { navigator.clipboard.writeText(window.location.origin + "/" + noteItem().id); }

  const copyCompositeIdClickHandler = (): void => { navigator.clipboard.writeText(compositeItemMaybe()!.id); }
  const linkCompositeIdClickHandler = (): void => { navigator.clipboard.writeText(window.location.origin + "/" + compositeItemMaybe()!.id); }

  const renderNoteInfoOverlay = () =>
    <div class="inline-block text-slate-800 text-sm p-[6px]">
      <span class="font-mono text-slate-400">{`I: ${noteItem()!.id}`}</span>
      <i class={`fa fa-copy text-slate-400 cursor-pointer ml-4`} onclick={copyItemIdClickHandler} />
      <i class={`fa fa-link text-slate-400 cursor-pointer ml-1`} onclick={linkItemIdClickHandler} />
    </div>;

  const renderCompositeInfoOverlayMaybe = () =>
    <Show when={compositeItemMaybe() != null}>
      <div class="inline-block text-slate-800 text-sm p-[6px] pl-[20px]">
        <span class="font-mono text-slate-400">{`C: ${compositeItemMaybe()!.id}`}</span>
        <i class={`fa fa-copy text-slate-400 cursor-pointer ml-4`} onclick={copyCompositeIdClickHandler} />
        <i class={`fa fa-link text-slate-400 cursor-pointer ml-1`} onclick={linkCompositeIdClickHandler} />
      </div>
    </Show>;

  return (
    <>
      {renderNoteInfoOverlay()}
      {renderCompositeInfoOverlayMaybe()}
    </>
  );
}
