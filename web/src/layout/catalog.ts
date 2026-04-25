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

export const CATALOG_DETAIL_COLUMN_PADDING_PX = 14;
export const CATALOG_HORIZONTAL_MARGIN_PX = 12;

export function calcCatalogContentWidthPx(pageWidthPx: number): number {
  return Math.max(0, pageWidthPx - CATALOG_HORIZONTAL_MARGIN_PX * 2);
}

export function calcCatalogPreviewColumnWidthPx(pageWidthPx: number): number {
  const preferredWidthPx = Math.round(calcCatalogContentWidthPx(pageWidthPx) * 0.22);
  return Math.max(150, Math.min(260, preferredWidthPx));
}

export function calcCatalogRowHeightPx(previewColumnWidthPx: number, gridCellAspect: number): number {
  const safeAspect = Math.max(gridCellAspect, 0.25);
  return Math.max(48, Math.round(previewColumnWidthPx / safeAspect));
}
