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
import { ShadowDomElement } from "./shadow-dom";


export interface VisualElement {
  itemType: string,
  itemId: Uid,
  resizingFromBoundsPx: BoundingBox | null, // if set, the element is currently being resized, and these were the original bounds.
  isTopLevel: boolean,
  boundsPx: () => BoundingBox, // relative to containing visual element childAreaBoundsPx.
  childAreaBoundsPx: () => BoundingBox | null,
  hitboxes: () => Array<Hitbox>, // higher index => takes precedence.
  children: () => Array<VisualElement>,
  attachments: () => Array<VisualElement>,
  parent: () => VisualElement | null,
}


export function findNearestContainerVe(visualElement: ShadowDomElement): ShadowDomElement {
  if (isContainer(visualElement)) { return visualElement; }
  const parentId = visualElement.parentId;
  if (parent == null) { panic(); }
  const el = document.getElementById(parentId!) as any;
  const se = el.data as ShadowDomElement;
  if (isContainer(se)) { return se; }
  panic();
}
