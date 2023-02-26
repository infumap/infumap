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

import { Accessor, createSignal, Setter } from "solid-js";
import { BoundingBox } from "../../util/geometry";
import { panic } from "../../util/lang";
import { Uid } from "../../util/uid";
import { Hitbox } from "./hitbox";
import { isContainer } from "./items/base/container-item";
import { ItemTypeMixin } from "./items/base/item";


export interface VisualElement extends ItemTypeMixin {
  itemId: Uid,
  boundsPx: BoundingBox, // relative to containing visual element childAreaBoundsPx.
  childAreaBoundsPx: BoundingBox | null,
  hitboxes: Array<Hitbox>, // higher index => takes precedence.
  children: Array<VisualElementSignal>,
  attachments: Array<VisualElementSignal>,
  parent: VisualElementSignal | null,
  isTopLevel: boolean,
};


export interface VisualElementSignal {
  get: Accessor<VisualElement>,
  set: Setter<VisualElement>,
  update: (f: (visualElement: VisualElement) => void) => void,
}


export function createVisualElementSignal(initialVisualElement: VisualElement) {
  const [get, set] = createSignal(initialVisualElement, { equals: false });
  const update = (f: (visualElement: VisualElement) => void) => {
    set(prev => {
      f(prev);
      return prev;
    })
  }
  return ({ get, set, update });
}


export function findNearestContainerVes(visualElementSignal: VisualElementSignal): VisualElementSignal {
  if (isContainer(visualElementSignal.get())) { return visualElementSignal; }
  const parent = visualElementSignal.get().parent;
  if (parent == null) { panic(); }
  if (isContainer(parent.get())) { return parent; }
  panic();
}
