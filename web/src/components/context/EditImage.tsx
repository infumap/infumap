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

import { Component, onCleanup } from "solid-js";
import { server } from "../../server";
import { useDesktopStore } from "../../store/DesktopStoreProvider";
import { asImageItem, ImageItem } from "../../items/image-item";
import { InfuButton } from "../library/InfuButton";
import { InfuTextInput } from "../library/InfuTextInput";
import { arrange, rearrangeVisualElementsWithId } from "../../layout/arrange";


export const EditImage: Component<{imageItem: ImageItem}> = (props: {imageItem: ImageItem}) => {
  const desktopStore = useDesktopStore();

  const imageId = props.imageItem.id;
  let deleted = false;

  const handleTitleChange = (v: string) => {
    asImageItem(desktopStore.getItem(imageId)!).title = v;
    rearrangeVisualElementsWithId(desktopStore, imageId);
  };

  const deleteImage = async () => {
    deleted = true;
    await server.deleteItem(imageId); // throws on failure.
    desktopStore.deleteItem(imageId);
    desktopStore.setEditDialogInfo(null);
    arrange(desktopStore);
  }

  onCleanup(() => {
    if (!deleted) {
      server.updateItem(desktopStore.getItem(imageId)!);
    }
  });

  return (
    <div>
      <div class="text-slate-800 text-sm">Title <InfuTextInput value={props.imageItem.title} onInput={handleTitleChange} focus={true} /></div>
      <div><InfuButton text="delete" onClick={deleteImage} /></div>
    </div>
  );
}
