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
import { Note } from "./items/Note";
import { Page } from "./items/Page";
import { Rating } from "./items/Rating";
import { Table } from "./items/Table";
import { Image } from "./items/Image";
import { File } from "./items/File";
import { Link } from "./items/Link";
import { isLink } from "../store/desktop/items/link-item";
import { VisualElement } from "../store/desktop/visual-element";


export interface VisualElementOnDesktopProps {
  visualElement: VisualElement
}

export const VisualElementOnDesktop: Component<VisualElementOnDesktopProps> = (props: VisualElementOnDesktopProps) => {
  return (
    <Switch fallback={<div>unkown item type '{props.visualElement.itemType}'</div>}>
      <Match when={isPage(props.visualElement)}><Page {...props} /></Match>
      <Match when={isNote(props.visualElement)}><Note {...props} /></Match>
      <Match when={isTable(props.visualElement)}><Table {...props} /></Match>
      <Match when={isImage(props.visualElement)}><Image {...props} /></Match>
      <Match when={isFile(props.visualElement)}><File {...props} /></Match>
      <Match when={isRating(props.visualElement)}><Rating {...props} /></Match>
      <Match when={isLink(props.visualElement)}><Link {...props} /></Match>
    </Switch>
  );
}
