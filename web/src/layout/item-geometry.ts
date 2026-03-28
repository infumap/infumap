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

import { BoundingBox, Dimensions } from "../util/geometry";
import { Hitbox } from "./hitbox";


/**
 * Specifies the geometry of an item.
 */
export interface ItemGeometry {

  /**
   * The complete bounds of the visual element, relative to the containing visual element's childAreaBoundsPx.
   */
  boundsPx: BoundingBox,

  /**
   * The (outer) bounds of the part of the visual element that contains child visual elements.
   */
  viewportBoundsPx: BoundingBox | null,

  /**
   * Size of a 1x1 bl block in pixels. Not set in all cases.
   */
  blockSizePx: Dimensions,

  /**
   * Optional row/column metadata for the arranged visual element itself.
   * This is used in layouts like document/composite where container children
   * need row/col context even when they arrange as nested pages/tables/composites.
   */
  row?: number,
  col?: number,

  /**
   * Hitboxes.
   * Higher index => higher precedence.
   * Hitbox boundsPx are relative to this item's boundsPx.
   */
  hitboxes: Array<Hitbox>,
}
