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

import { Component, For } from "solid-js";
import { VesCache } from "../../layout/ves-cache";
import { VeFns, VisualElement } from "../../layout/visual-element";
import { VisualElement_Desktop } from "../VisualElement";
import { AttachmentsOverflowMarker } from "./HiddenAttachmentsMarker";


/**
 * The attachments of the item in an attachment cell (column 2+) of a table, drawn as spatial attachments along the
 * top right of the cell. Their bounds are relative to the table child area, so this must be rendered there, after
 * the cell.
 */
export const TableCellAttachments: Component<{ cellVe: VisualElement }> = props => {
  return (
    <>
      <For each={VesCache.render.getAttachments(VeFns.veToPath(props.cellVe))()}>{attachment =>
        <VisualElement_Desktop visualElement={attachment.get()} />
      }</For>
      <AttachmentsOverflowMarker visualElement={props.cellVe} />
    </>
  );
}
