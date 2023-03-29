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
import { panic } from "../../util/lang";
import { Uid } from "../../util/uid";
import { Hitbox } from "./hitbox";
import { isContainer } from "./items/base/container-item";
import { ItemTypeMixin } from "./items/base/item";


// A visual element tree is constructed corresponding for the currently visible items. Note that items
// may be represented on the screen more than once because there may be links.
//
// There are two types of visual element object:
//   VisualElement_Reactive: Used for rendering - to enable SolidJS micro-reactivity.
//   VisualElement_Concrete: Used to cache the current rendered visual tree, used during user interaction.
// 
// I wanted to maintain the concrete visual elements in a separate structure, however I had a bit of trouble
// keeping it synced correctly, and ended up attaching them the the actual DOM elements and traversing this
// as required. This is a bit of a dirty hack but not very consequential and fine for now.
//
// The concrete visual elements are cached using boundsPx() as a hook - again, seems a bit of a hack, but
// ok for now.


export interface VisualElement_Reactive extends ItemTypeMixin {
  itemId: Uid,
  resizingFromBoundsPx: BoundingBox | null, // if set, the element is currently being resized, and these were the original bounds.
  isInteractive: boolean,
  boundsPx: () => BoundingBox, // relative to containing visual element childAreaBoundsPx.
  childAreaBoundsPx: () => BoundingBox | null,
  hitboxes: () => Array<Hitbox>, // higher index => takes precedence.
  children: () => Array<VisualElement_Reactive>,
  attachments: () => Array<VisualElement_Reactive>,
  parent: () => VisualElement_Reactive | null,
}


export interface VisualElement_Concrete extends ItemTypeMixin {
  itemId: Uid,
  parentId: Uid | null,
  boundsPx: BoundingBox,
  childAreaBoundsPx: BoundingBox | null,
  hitboxes: Array<Hitbox>,
}


export function findNearestContainerVe(visualElement: VisualElement_Concrete): VisualElement_Concrete {
  if (isContainer(visualElement)) { return visualElement; }
  const parentId = visualElement.parentId;
  if (parent == null) { panic(); }
  const el = document.getElementById(parentId!) as any;
  const se = el.data as VisualElement_Concrete;
  if (isContainer(se)) { return se; }
  panic();
}
