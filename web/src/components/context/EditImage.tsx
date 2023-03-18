/*
  Copyright (C) 2023 The Infumap Authors
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

import { Component } from "solid-js";
import { server } from "../../server";
import { useDesktopStore } from "../../store/desktop/DesktopStoreProvider";
import { asImageItem, ImageItem } from "../../store/desktop/items/image-item";
import { useUserStore } from "../../store/UserStoreProvider";
import { InfuButton } from "../library/InfuButton";
import { InfuTextInput } from "../library/InfuTextInput";


export const EditImage: Component<{imageItem: ImageItem}> = (props: {imageItem: ImageItem}) => {
  const userStore = useUserStore();
  const desktopStore = useDesktopStore();

  const imageId = () => props.imageItem.id;

  const handleTitleChange = (v: string) => { desktopStore.updateItem(imageId(), item => asImageItem(item).title = v); };
  const handleTitleChanged = (v: string) => { server.updateItem(userStore.getUser(), desktopStore.getItem(imageId())!); }

  const deleteImage = async () => {
    await server.deleteItem(userStore.getUser(), imageId());
  }

  return (
    <div>
      <div class="text-slate-800 text-sm">Title <InfuTextInput value={props.imageItem.title} onIncrementalChange={handleTitleChange} onChange={handleTitleChanged} /></div>
      <div><InfuButton text="delete" onClick={deleteImage} /></div>
    </div>
  );
}
