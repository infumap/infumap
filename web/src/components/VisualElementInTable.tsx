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

import { Component, Match, Switch } from "solid-js";
import { isFile } from "../store/desktop/items/file-item";
import { isImage } from "../store/desktop/items/image-item";
import { isNote } from "../store/desktop/items/note-item";
import { isPage } from "../store/desktop/items/page-item";
import { isRating } from "../store/desktop/items/rating-item";
import { isTable } from "../store/desktop/items/table-item";
import { VisualElement } from "../store/desktop/visual-element";
import { FileInTable } from "./items/File";
import { ImageInTable } from "./items/Image";
import { NoteInTable } from "./items/Note";
import { PageInTable } from "./items/Page";
import { RatingInTable } from "./items/Rating";
import { TableInTable } from "./items/Table";


export interface VisualElementInTableProps {
  visualElement: VisualElement,
  parentVisualElement: VisualElement,
}

export const VisualElementInTable: Component<VisualElementInTableProps> = (props: VisualElementInTableProps) => {
  return (
    <Switch fallback={<div>unkown item type '{props.visualElement.item.itemType}'</div>}>
      <Match when={isPage(props.visualElement.item)}><PageInTable {...props} /></Match>
      <Match when={isTable(props.visualElement.item)}><TableInTable {...props} /></Match>
      <Match when={isNote(props.visualElement.item)}><NoteInTable {...props} /></Match>
      <Match when={isImage(props.visualElement.item)}><ImageInTable {...props} /></Match>
      <Match when={isFile(props.visualElement.item)}><FileInTable {...props} /></Match>
      <Match when={isRating(props.visualElement.item)}><RatingInTable {...props} /></Match>
    </Switch>
  );
}
