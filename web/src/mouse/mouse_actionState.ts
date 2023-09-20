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

import { AttachmentsItem } from "../items/base/attachments-item";
import { CompositeItem } from "../items/composite-item";
import { PlaceholderItem } from "../items/placeholder-item";
import { HitboxMeta, HitboxType } from "../layout/hitbox";
import { VisualElementPath } from "../layout/visual-element";
import { Vector } from "../util/geometry";
import { panic } from "../util/lang";

export enum MouseAction {
  Ambiguous,
  Moving,
  MovingPopup,
  Resizing,
  ResizingColumn,
  ResizingPopup,
}

export interface MouseActionState {
  hitboxTypeOnMouseDown: HitboxType,
  compositeHitboxTypeMaybeOnMouseDown: HitboxType,

  hitMeta: HitboxMeta | null,

  activeElement: VisualElementPath,
  activeCompositeElementMaybe: VisualElementPath | null,

  activeRoot: VisualElementPath,

  moveOver_containerElement: VisualElementPath | null,
  moveOver_attachHitboxElement: VisualElementPath | null,
  moveOver_attachCompositeHitboxElement: VisualElementPath | null,
  moveOver_scaleDefiningElement: VisualElementPath | null,

  startPx: Vector,
  startPosBl: Vector | null,
  startWidthBl: number | null,
  startHeightBl: number | null,

  startAttachmentsItem: AttachmentsItem | null,     // when taking an attachment out of a table.
  startCompositeItem: CompositeItem | null,         // when taking an item out of a composite item.

  clickOffsetProp: Vector | null,

  action: MouseAction,

  onePxSizeBl: Vector,
  newPlaceholderItem: PlaceholderItem | null,
}


let mouseActionState: MouseActionState | null = null;

export let MouseActionState = {
  set: (state: MouseActionState | null): void => { mouseActionState = state; },
  empty: (): boolean => { return mouseActionState == null; },
  get: (): MouseActionState => { if (mouseActionState == null) { panic!(); } return mouseActionState!; }
}
