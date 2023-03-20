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
import { isLink } from "../store/desktop/items/link-item";
import { isNote } from "../store/desktop/items/note-item";
import { isPage } from "../store/desktop/items/page-item";
import { isRating } from "../store/desktop/items/rating-item";
import { isTable } from "../store/desktop/items/table-item";
import { VisualElementFn } from "../store/desktop/visual-element";
import { FileInTableFn } from "./items/File";
import { ImageInTableFn } from "./items/Image";
import { LinkInTableFn } from "./items/Link";
import { NoteInTableFn } from "./items/Note";
import { PageInTableFn } from "./items/Page";
import { RatingInTableFn } from "./items/Rating";
import { TableInTableFn } from "./items/Table";


export interface VisualElementInTablePropsFn {
  visualElement: VisualElementFn,
  parentVisualElement: VisualElementFn,
}

export const VisualElementInTableFn: Component<VisualElementInTablePropsFn> = (props: VisualElementInTablePropsFn) => {
  return (
    <Switch fallback={<div>unkown item type '{props.visualElement.itemType}'</div>}>
      <Match when={isPage(props.visualElement)}><PageInTableFn {...props} /></Match>
      <Match when={isTable(props.visualElement)}><TableInTableFn {...props} /></Match>
      <Match when={isNote(props.visualElement)}><NoteInTableFn {...props} /></Match>
      <Match when={isImage(props.visualElement)}><ImageInTableFn {...props} /></Match>
      <Match when={isFile(props.visualElement)}><FileInTableFn {...props} /></Match>
      <Match when={isRating(props.visualElement)}><RatingInTableFn {...props} /></Match>
      <Match when={isLink(props.visualElement)}><LinkInTableFn {...props} /></Match>
    </Switch>
  );
}
