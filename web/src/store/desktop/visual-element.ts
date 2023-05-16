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

import { Accessor } from "solid-js";
import { BoundingBox } from "../../util/geometry";
import { EMPTY_UID } from "../../util/uid";
import { Uid } from "../../util/uid";
import { Hitbox } from "./hitbox";
import { ITEM_TYPE_NONE, ItemTypeMixin } from "./items/base/item";
import { VisualElementSignal } from "../../util/signals";


export interface VisualElement extends ItemTypeMixin {
  itemId: Uid,
  resizingFromBoundsPx: BoundingBox | null, // if set, the element is currently being resized, and these were the original bounds.
  isInteractive: boolean,
  boundsPx: BoundingBox, // relative to containing visual element childAreaBoundsPx.
  childAreaBoundsPx: BoundingBox | null,
  hitboxes: Array<Hitbox>, // higher index => takes precedence.
  children: Array<VisualElementSignal>,
  attachments: Array<VisualElementSignal>,
  parent: Accessor<VisualElement> | null,
}

/**
 * Used to represent that there is no root visual element. This makes the typing much easier to deal with
 * than using VisualElement | null
 */
export const NONE_VISUAL_ELEMENT: VisualElement = {
  itemType: ITEM_TYPE_NONE,
  itemId: EMPTY_UID,
  resizingFromBoundsPx: null,
  isInteractive: false,
  boundsPx: { x: 0, y: 0, w: 0, h: 0 },
  childAreaBoundsPx: null,
  hitboxes: [],
  children: [],
  attachments: [],
  parent: null,
};
