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

import { Component, Match, Switch } from "solid-js";
import { isFile } from "../items/file-item";
import { isImage } from "../items/image-item";
import { isNote } from "../items/note-item";
import { isPage } from "../items/page-item";
import { isRating } from "../items/rating-item";
import { isTable } from "../items/table-item";
import { Note_Desktop } from "./items/Note";
import { Page_Desktop } from "./items/Page";
import { Rating_Desktop } from "./items/Rating";
import { Table_Desktop } from "./items/Table";
import { Image_Desktop } from "./items/Image";
import { File } from "./items/File";
import { VisualElement } from "../layout/visual-element";
import { Placeholder_Desktop } from "./items/Placeholder";
import { FileLineItem } from "./items/File";
import { Image_LineItem } from "./items/Image";
import { Note_LineItem } from "./items/Note";
import { Page_LineItem } from "./items/Page";
import { Rating_LineItem } from "./items/Rating";
import { Table_LineItem } from "./items/Table";
import { EMPTY_ITEM } from "../items/base/item";
import { isPlaceholder } from "../items/placeholder-item";
import { Placeholder_LineItem } from "./items/Placeholder";


export interface VisualElementProps_Desktop {
  visualElement: VisualElement
}

export const VisualElement_Desktop: Component<VisualElementProps_Desktop> = (props: VisualElementProps_Desktop) => {
  return (
    <Switch fallback={<div>VisualElementOnDesktop: unknown item type: '{props.visualElement.item.itemType}'</div>}>
      <Match when={isPage(props.visualElement.item)}><Page_Desktop {...props} /></Match>
      <Match when={isNote(props.visualElement.item)}><Note_Desktop {...props} /></Match>
      <Match when={isTable(props.visualElement.item)}><Table_Desktop {...props} /></Match>
      <Match when={isImage(props.visualElement.item)}><Image_Desktop {...props} /></Match>
      <Match when={isFile(props.visualElement.item)}><File {...props} /></Match>
      <Match when={isRating(props.visualElement.item)}><Rating_Desktop {...props} /></Match>
      <Match when={isPlaceholder(props.visualElement.item)}><Placeholder_Desktop {...props} /></Match>
    </Switch>
  );
}


export interface VisualElementProps_LineItem {
  visualElement: VisualElement,
}

export const VisualElement_LineItem: Component<VisualElementProps_LineItem> = (props: VisualElementProps_LineItem) => {
  return (
    <Switch fallback={<div>VisualElementInTable: unknown item type '{props.visualElement.item.itemType}'</div>}>
      <Match when={props.visualElement.item == EMPTY_ITEM}><></></Match> {/* generated only for the hitboxes. */}
      <Match when={isPage(props.visualElement.item)}><Page_LineItem {...props} /></Match>
      <Match when={isTable(props.visualElement.item)}><Table_LineItem {...props} /></Match>
      <Match when={isNote(props.visualElement.item)}><Note_LineItem {...props} /></Match>
      <Match when={isImage(props.visualElement.item)}><Image_LineItem {...props} /></Match>
      <Match when={isFile(props.visualElement.item)}><FileLineItem {...props} /></Match>
      <Match when={isRating(props.visualElement.item)}><Rating_LineItem {...props} /></Match>
      <Match when={isPlaceholder(props.visualElement.item)}><Placeholder_LineItem {...props} /></Match>
    </Switch>
  );
}