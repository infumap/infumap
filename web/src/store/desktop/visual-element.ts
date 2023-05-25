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

import { BoundingBox } from "../../util/geometry";
import { Hitbox } from "./hitbox";
import { Item, EMPTY_ITEM } from "./items/base/item";
import { BooleanSignal, VisualElementSignal, createBooleanSignal } from "../../util/signals";
import { LinkItem } from "./items/link-item";


export interface VisualElement {
  item: Item,

  // If the VisualElement corresponds to a link item, "item" is the linked-to item, and
  // "linkItemMaybe" is the link item itself.
  linkItemMaybe: LinkItem | null,

  // If set, the element is currently being resized, and these were the original bounds.
  resizingFromBoundsPx: BoundingBox | null,

  
  isInteractive: boolean,
  isPopup: boolean,
  
  // boundsPx and childAreaBoundsPx are relative to containing visual element's childAreaBoundsPx.
  boundsPx: BoundingBox,
  childAreaBoundsPx: BoundingBox | null,

  // higher index => higher precedence.
  hitboxes: Array<Hitbox>,

  children: Array<VisualElementSignal>,
  attachments: Array<VisualElementSignal>,
  parent: VisualElementSignal | null,

  computed_mouseIsOver: BooleanSignal,

  // For containers only
  computed_movingItemIsOver: BooleanSignal;
}


/**
 * Used when there is no top level visual element. This makes the typing much easier to deal with
 * than using VisualElement | null
 */
export const NONE_VISUAL_ELEMENT: VisualElement = {
  item: EMPTY_ITEM,
  linkItemMaybe: null,
  resizingFromBoundsPx: null,
  isInteractive: false,
  isPopup: false,
  boundsPx: { x: 0, y: 0, w: 0, h: 0 },
  childAreaBoundsPx: null,
  hitboxes: [],
  children: [],
  attachments: [],
  parent: null,


  computed_mouseIsOver: createBooleanSignal(false),
  computed_movingItemIsOver: createBooleanSignal(false),
};
