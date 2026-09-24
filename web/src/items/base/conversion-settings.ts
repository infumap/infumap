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

import { Vector } from "../../util/geometry";

/** Page-only settings retained while the item is a table. Shared tabular fields stay active. */
export interface SavedPageSettings {
  spatialWidthGr: number;
  flags: number;
  permissionFlags: number;
  naturalAspect: number;
  backgroundColorIndex: number;
  innerSpatialWidthGr: number;
  listWidthGr: number | null;
  defaultPopupPositionGr: Vector;
  defaultPopupWidthGr: number;
  popupPositionGr: Vector | null;
  popupWidthGr: number | null;
  defaultCellPopupPositionNorm: Vector | null;
  defaultCellPopupWidthNorm: number | null;
  cellPopupPositionNorm: Vector | null;
  cellPopupWidthNorm: number | null;
  gridNumberOfColumns: number;
  gridCellAspect: number;
  docWidthBl: number;
  justifiedRowAspect: number;
  calendarDayRowHeightBl: number | null;
}

/** Table-only settings retained while the item is a page. */
export interface SavedTableSettings {
  spatialWidthGr: number;
  spatialHeightGr: number;
  flags: number;
}
