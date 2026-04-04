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
import { Page_LineItem } from "./items/Page_LineItem";
import { EMPTY_ITEM, isEmptyItem } from "../items/base/item";
import { isPlaceholder } from "../items/placeholder-item";
import { LinkDefault_Desktop } from "./items/LinkDefault";
import { isLink } from "../items/link-item";
import { isPassword } from "../items/password-item";
import { Password } from "./items/Password";
import { Composite_Desktop } from "./items/Composite";
import { isComposite } from "../items/composite-item";
import { PasswordLineItem } from "./items/Password_LineItem";
import { Placeholder_LineItem } from "./items/Placeholder_LineItem";
import { Rating_LineItem } from "./items/Rating_LineItem";
import { Table_LineItem } from "./items/Table_LineItem";
import { Note_LineItem } from "./items/Note_LineItem";
import { LinkDefault_LineItem } from "./items/LinkDefault_LineItem";
import { Image_LineItem } from "./items/Image_LineItem";
import { FileLineItem } from "./items/File_LineItem";
import { Composite_LineItem } from "./items/Composite_LineItem";
import { useStore } from "../store/StoreProvider";
import { VisualElementFlags, VeFns } from "../layout/visual-element";
import { Z_INDEX_ABOVE_TRANSLUCENT } from "../constants";


export interface VisualElementProps {
  visualElement: VisualElement
}

export const VisualElement_Desktop: Component<VisualElementProps> = (props: VisualElementProps) => {
  const store = useStore();
  const vePath = () => VeFns.veToPath(props.visualElement);
  const warningTopPx = () =>
    props.visualElement.boundsPx.y + ((props.visualElement.flags & VisualElementFlags.Fixed) ? store.topToolbarHeightPx() : 0);

  return (
    <>
      <Switch fallback={<div>VisualElement_Desktop: unknown display item type: '{props.visualElement.displayItem != null ? props.visualElement.displayItem.itemType : "N/A"}'</div>}>
        <Match when={isEmptyItem(props.visualElement.displayItem)}><></></Match>
        <Match when={isLink(props.visualElement.displayItem)}><LinkDefault_Desktop {...props} /></Match>
        <Match when={isPage(props.visualElement.displayItem)}><Page_Desktop {...props} /></Match>
        <Match when={isComposite(props.visualElement.displayItem)}><Composite_Desktop {...props} /></Match>
        <Match when={isNote(props.visualElement.displayItem)}><Note_Desktop {...props} /></Match>
        <Match when={isTable(props.visualElement.displayItem)}><Table_Desktop {...props} /></Match>
        <Match when={isImage(props.visualElement.displayItem)}><Image_Desktop {...props} /></Match>
        <Match when={isFile(props.visualElement.displayItem)}><File {...props} /></Match>
        <Match when={isPassword(props.visualElement.displayItem)}><Password {...props} /></Match>
        <Match when={isRating(props.visualElement.displayItem)}><Rating_Desktop {...props} /></Match>
        <Match when={isPlaceholder(props.visualElement.displayItem)}><Placeholder_Desktop {...props} /></Match>
      </Switch>
      <Show when={store.perVe.getAutoMovedIntoView(vePath())}>
        <div class={`${props.visualElement.flags & VisualElementFlags.Fixed ? 'fixed' : 'absolute'} pointer-events-none rounded-xs`}
          style={`left: ${props.visualElement.boundsPx.x}px; top: ${warningTopPx()}px; width: ${props.visualElement.boundsPx.w}px; height: ${props.visualElement.boundsPx.h}px; ` +
            `border: 2px solid rgba(245, 158, 11, 0.95); ` +
            `background: repeating-linear-gradient(135deg, rgba(245, 158, 11, 0.18), rgba(245, 158, 11, 0.18) 8px, rgba(251, 191, 36, 0.30) 8px, rgba(251, 191, 36, 0.30) 16px); ` +
            `box-shadow: inset 0 0 0 1px rgba(255, 251, 235, 0.8); z-index: ${Z_INDEX_ABOVE_TRANSLUCENT + 2};`} />
      </Show>
    </>
  );
}

export const VisualElement_LineItem: Component<VisualElementProps> = (props: VisualElementProps) => {
  return (
    <Switch fallback={<div>VisualElement_LineItem: unknown display item type '{props.visualElement.displayItem != null ? props.visualElement.displayItem.itemType : "N/A"}'</div>}>
      <Match when={isEmptyItem(props.visualElement.displayItem)}><></></Match>
      <Match when={isLink(props.visualElement.displayItem)}><LinkDefault_LineItem {...props} /></Match>
      <Match when={isPage(props.visualElement.displayItem)}><Page_LineItem {...props} /></Match>
      <Match when={isTable(props.visualElement.displayItem)}><Table_LineItem {...props} /></Match>
      <Match when={isComposite(props.visualElement.displayItem)}><Composite_LineItem {...props} /></Match>
      <Match when={isNote(props.visualElement.displayItem)}><Note_LineItem {...props} /></Match>
      <Match when={isImage(props.visualElement.displayItem)}><Image_LineItem {...props} /></Match>
      <Match when={isFile(props.visualElement.displayItem)}><FileLineItem {...props} /></Match>
      <Match when={isPassword(props.visualElement.displayItem)}><PasswordLineItem {...props} /></Match>
      <Match when={isRating(props.visualElement.displayItem)}><Rating_LineItem {...props} /></Match>
      <Match when={isPlaceholder(props.visualElement.displayItem)}><Placeholder_LineItem {...props} /></Match>
      <Match when={props.visualElement.displayItem == EMPTY_ITEM()}><></></Match> {/* generated only for the hitboxes. */}
    </Switch>
  );
}
