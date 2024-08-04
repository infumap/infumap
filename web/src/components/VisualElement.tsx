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
import { Expression_Desktop } from "./items/Expression";
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
import { Expression_LineItem } from "./items/Expression";
import { Page_LineItem } from "./items/Page_LineItem";
import { Rating_LineItem } from "./items/Rating";
import { Table_LineItem } from "./items/Table";
import { EMPTY_ITEM, isEmptyItem } from "../items/base/item";
import { isPlaceholder } from "../items/placeholder-item";
import { Placeholder_LineItem } from "./items/Placeholder";
import { LinkDefault_Desktop, LinkDefault_LineItem } from "./items/LinkDefault";
import { isLink } from "../items/link-item";
import { isPassword } from "../items/password-item";
import { Password, PasswordLineItem } from "./items/Password";
import { Composite_Desktop, Composite_LineItem } from "./items/Composite";
import { isComposite } from "../items/composite-item";
import { isExpression } from "../items/expression-item";


export interface VisualElementProps {
  visualElement: VisualElement
}

export const VisualElement_Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  return (
    <Switch fallback={<div>VisualElementOnDesktop: unknown display item type: '{props.visualElement.displayItem != null ? props.visualElement.displayItem.itemType : "N/A"}'</div>}>
      <Match when={isEmptyItem(props.visualElement.displayItem)}><></></Match>
      <Match when={isLink(props.visualElement.displayItem)}><LinkDefault_Desktop {...props} /></Match>
      <Match when={isPage(props.visualElement.displayItem)}><Page_Desktop {...props} /></Match>
      <Match when={isComposite(props.visualElement.displayItem)}><Composite_Desktop {...props} /></Match>
      <Match when={isNote(props.visualElement.displayItem)}><Note_Desktop {...props} /></Match>
      <Match when={isExpression(props.visualElement.displayItem)}><Expression_Desktop {...props} /></Match>
      <Match when={isTable(props.visualElement.displayItem)}><Table_Desktop {...props} /></Match>
      <Match when={isImage(props.visualElement.displayItem)}><Image_Desktop {...props} /></Match>
      <Match when={isFile(props.visualElement.displayItem)}><File {...props} /></Match>
      <Match when={isPassword(props.visualElement.displayItem)}><Password {...props} /></Match>
      <Match when={isRating(props.visualElement.displayItem)}><Rating_Desktop {...props} /></Match>
      <Match when={isPlaceholder(props.visualElement.displayItem)}><Placeholder_Desktop {...props} /></Match>
    </Switch>
  );
}

export const VisualElement_LineItem: Component<VisualElementProps> = (props: VisualElementProps) => {
  return (
    <Switch fallback={<div>VisualElementInTable: unknown display item type '{props.visualElement.displayItem != null ? props.visualElement.displayItem.itemType : "N/A"}'</div>}>
      <Match when={isEmptyItem(props.visualElement.displayItem)}><></></Match>
      <Match when={isLink(props.visualElement.displayItem)}><LinkDefault_LineItem {...props} /></Match>
      <Match when={isPage(props.visualElement.displayItem)}><Page_LineItem {...props} /></Match>
      <Match when={isTable(props.visualElement.displayItem)}><Table_LineItem {...props} /></Match>
      <Match when={isComposite(props.visualElement.displayItem)}><Composite_LineItem {...props} /></Match>
      <Match when={isNote(props.visualElement.displayItem)}><Note_LineItem {...props} /></Match>
      <Match when={isExpression(props.visualElement.displayItem)}><Expression_LineItem {...props} /></Match>
      <Match when={isImage(props.visualElement.displayItem)}><Image_LineItem {...props} /></Match>
      <Match when={isFile(props.visualElement.displayItem)}><FileLineItem {...props} /></Match>
      <Match when={isPassword(props.visualElement.displayItem)}><PasswordLineItem {...props} /></Match>
      <Match when={isRating(props.visualElement.displayItem)}><Rating_LineItem {...props} /></Match>
      <Match when={isPlaceholder(props.visualElement.displayItem)}><Placeholder_LineItem {...props} /></Match>
      <Match when={props.visualElement.displayItem == EMPTY_ITEM()}><></></Match> {/* generated only for the hitboxes. */}
    </Switch>
  );
}
