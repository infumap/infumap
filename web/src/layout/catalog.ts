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
export const CATALOG_VERTICAL_MARGIN_PX = CATALOG_HORIZONTAL_MARGIN_PX;
// Below this width (at full size), the detail column is too narrow to be useful, so is not shown.
export const CATALOG_MIN_DETAIL_COLUMN_WIDTH_PX = 150;

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

export interface CatalogLayout {
  // If false, the page is too narrow for the detail column, and the preview column spans the content width.
  showDetailColumn: boolean,
  horizontalMarginPx: number,
  verticalMarginPx: number,
  contentWidthPx: number,
  previewColumnWidthPx: number,
  rowHeightPx: number,
  cellMarginPx: number,
}

/**
 * Layout of a catalog page of the given width, drawn at the given scale: the layout of a page of width
 * pageWidthPx / scale, scaled down. So a catalog page drawn small (e.g. translucent) is a miniature of the full page.
 */
export function calcCatalogLayout(pageWidthPx: number, gridCellAspect: number, scale: number): CatalogLayout {
  const virtualPageWidthPx = pageWidthPx / scale;
  const contentWidthPx = calcCatalogContentWidthPx(virtualPageWidthPx);
  const detailColumnWidthPx = contentWidthPx - calcCatalogPreviewColumnWidthPx(virtualPageWidthPx) - CATALOG_DETAIL_COLUMN_PADDING_PX * 2;
  const showDetailColumn = detailColumnWidthPx >= CATALOG_MIN_DETAIL_COLUMN_WIDTH_PX;
  const previewColumnWidthPx = showDetailColumn ? calcCatalogPreviewColumnWidthPx(virtualPageWidthPx) : contentWidthPx;
  return {
    showDetailColumn,
    horizontalMarginPx: CATALOG_HORIZONTAL_MARGIN_PX * scale,
    verticalMarginPx: CATALOG_VERTICAL_MARGIN_PX * scale,
    contentWidthPx: contentWidthPx * scale,
    previewColumnWidthPx: previewColumnWidthPx * scale,
    rowHeightPx: calcCatalogRowHeightPx(previewColumnWidthPx, gridCellAspect) * scale,
    cellMarginPx: Math.max(1, Math.round(previewColumnWidthPx * 0.01)) * scale,
  };
}
