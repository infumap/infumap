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
import { NoteFn } from "./items/Note";
import { PageFn } from "./items/Page";
import { RatingFn } from "./items/Rating";
import { TableFn } from "./items/Table";
import { ImageFn } from "./items/Image";
import { FileFn } from "./items/File";
import { LinkFn } from "./items/Link";
import { isLink } from "../store/desktop/items/link-item";
import { VisualElementFn } from "../store/desktop/visual-element";


export interface VisualElementOnDesktopPropsFn {
  visualElement: VisualElementFn
}

export const VisualElementOnDesktopFn: Component<VisualElementOnDesktopPropsFn> = (props: VisualElementOnDesktopPropsFn) => {
  return (
    <Switch fallback={<div>unkown item type '{props.visualElement.itemType}'</div>}>
      <Match when={isPage(props.visualElement)}><PageFn {...props} /></Match>
      <Match when={isNote(props.visualElement)}><NoteFn {...props} /></Match>
      <Match when={isTable(props.visualElement)}><TableFn {...props} /></Match>
      <Match when={isImage(props.visualElement)}><ImageFn {...props} /></Match>
      <Match when={isFile(props.visualElement)}><FileFn {...props} /></Match>
      <Match when={isRating(props.visualElement)}><RatingFn {...props} /></Match>
      <Match when={isLink(props.visualElement)}><LinkFn {...props} /></Match>
    </Switch>
  );
}
