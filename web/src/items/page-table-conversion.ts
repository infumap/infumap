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

import { GRID_SIZE } from "../constants";
import { VisualElementPath } from "../layout/visual-element";
import { initiateLoadItemMaybe } from "../layout/load";
import { server } from "../server";
import { StoreContextModel } from "../store/StoreProvider";
import { Uid } from "../util/uid";
import { SavedPageSettings, SavedTableSettings } from "./base/conversion-settings";
import { PageFlags, TableFlags } from "./base/flags-item";
import { ContainerConversionRejection, applyConvertedItem, containerConversionSource, validateConvertedObject } from "./container-conversion";
import { ArrangeAlgorithm, PageItem, asPageItem, autoPageAspect, isPage } from "./page-item";
import { TableItem, asTableItem, isTable } from "./table-item";

export type PageTableConvertibleItem = PageItem | TableItem;

export type PageTableConversionRejection = ContainerConversionRejection | "not-table-page";

export type PageTableConversionEligibility =
  // Direct links can load the source before its parent; the action resolves the parent before mutating.
  | { allowed: true; source: PageTableConvertibleItem; parent: PageItem | null; parentId: Uid; targetType: "page" | "table" }
  | { allowed: false; reason: PageTableConversionRejection };

/** Eligibility for the original item, as displayed in the current toolbar view. */
export function pageTableConversionEligibility(
  store: StoreContextModel,
  focusPath: VisualElementPath | null,
): PageTableConversionEligibility {
  const common = containerConversionSource(store, focusPath, item => isPage(item) || isTable(item));
  if (!common.allowed) { return common; }
  const source = isPage(common.source) ? asPageItem(common.source) : asTableItem(common.source);
  if (isPage(source) && asPageItem(source).arrangeAlgorithm != ArrangeAlgorithm.Table) {
    return { allowed: false, reason: "not-table-page" };
  }
  return { ...common, source, targetType: isPage(source) ? "table" : "page" };
}

/** Convert the original item, then reconcile its authoritative replacement into the current view. */
export async function convertPageTableAtPath(
  store: StoreContextModel,
  focusPath: VisualElementPath,
): Promise<PageTableConvertibleItem> {
  const eligibility = pageTableConversionEligibility(store, focusPath);
  if (!eligibility.allowed) {
    throw new Error(`Page/table conversion is unavailable: ${eligibility.reason}.`);
  }

  const { source, targetType } = eligibility;
  let parent = eligibility.parent;
  if (parent == null) {
    await initiateLoadItemMaybe(store, eligibility.parentId);
    const rechecked = pageTableConversionEligibility(store, focusPath);
    if (!rechecked.allowed || rechecked.parent == null) {
      throw new Error(`Cannot load an editable parent page for item '${source.id}'.`);
    }
    parent = rechecked.parent;
  }
  const convertedObject = await server.convertPageTable(
    source.id,
    isPage(source) ? "page" : "table",
    targetType,
    targetType == "page" && asTableItem(source).savedPageSettings == null ? autoPageAspect(store) : null,
  );
  validateConvertedObject(source, parent, targetType, convertedObject);
  const converted = await applyConvertedItem(store, source, parent, convertedObject);
  return isPage(converted) ? asPageItem(converted) : asTableItem(converted);
}

/** Fields conversion must carry unchanged. Sizing and last-modified time are handled separately. */
export function pageTableConversionSharedState(source: PageTableConvertibleItem) {
  return {
    ownerId: source.ownerId,
    id: source.id,
    parentId: source.parentId,
    relationshipToParent: source.relationshipToParent,
    groupId: source.groupId,
    creationDate: source.creationDate,
    dateTime: source.dateTime,
    endDateTime: source.endDateTime,
    ordering: new Uint8Array(source.ordering),
    title: source.title,
    spatialPositionGr: { ...source.spatialPositionGr },
    orderChildrenBy: source.orderChildrenBy,
    tableColumns: source.tableColumns.map(column => ({ ...column })),
    numberOfVisibleColumns: source.numberOfVisibleColumns,
    computed_children: [...source.computed_children],
    computed_attachments: [...source.computed_attachments],
    childrenLoaded: source.childrenLoaded,
  };
}

/** Page and table flags with the same meaning, translated on conversion. */
const PAGE_TABLE_FLAG_PAIRS: Array<[PageFlags, TableFlags]> = [
  [PageFlags.ShowTableColHeader, TableFlags.ShowColHeader],
  [PageFlags.TableWrapRows, TableFlags.WrapRows],
];

/** Preserve unrelated flags in the destination while translating column-header visibility and row wrapping. */
export function pageTableConvertedFlags(source: PageTableConvertibleItem, destinationFlags: number): number {
  const sourceIsPage = isPage(source);
  let result = destinationFlags;
  for (const [pageFlag, tableFlag] of PAGE_TABLE_FLAG_PAIRS) {
    const sourceFlag = sourceIsPage ? pageFlag : tableFlag;
    const destinationFlag = sourceIsPage ? tableFlag : pageFlag;
    result = source.flags & sourceFlag ? result | destinationFlag : result & ~destinationFlag;
  }
  return result;
}

export function savedPageSettingsFromPage(page: PageItem): SavedPageSettings {
  return {
    spatialWidthGr: page.spatialWidthGr,
    flags: page.flags,
    permissionFlags: page.permissionFlags,
    naturalAspect: page.naturalAspect,
    backgroundColorIndex: page.backgroundColorIndex,
    innerSpatialWidthGr: page.innerSpatialWidthGr,
    listWidthGr: page.listWidthGr,
    defaultPopupPositionGr: { ...page.defaultPopupPositionGr },
    defaultPopupWidthGr: page.defaultPopupWidthGr,
    popupPositionGr: page.popupPositionGr && { ...page.popupPositionGr },
    popupWidthGr: page.popupWidthGr,
    defaultCellPopupPositionNorm: { ...page.defaultCellPopupPositionNorm },
    defaultCellPopupWidthNorm: page.defaultCellPopupWidthNorm,
    cellPopupPositionNorm: page.cellPopupPositionNorm && { ...page.cellPopupPositionNorm },
    cellPopupWidthNorm: page.cellPopupWidthNorm,
    gridNumberOfColumns: page.gridNumberOfColumns,
    gridCellAspect: page.gridCellAspect,
    docWidthBl: page.docWidthBl,
    justifiedRowAspect: page.justifiedRowAspect,
    calendarDayRowHeightBl: page.calendarDayRowHeightBl,
  };
}

export function savedTableSettingsFromTable(table: TableItem): SavedTableSettings {
  return {
    spatialWidthGr: table.spatialWidthGr,
    spatialHeightGr: table.spatialHeightGr,
    flags: table.flags,
  };
}

/** Fit configured columns where possible, without creating a table wider than the parent page. */
export function embeddedTableSizeFromPage(page: PageItem, parent: PageItem): { w: number; h: number } {
  if (page.savedTableSettings != null) {
    return {
      w: page.savedTableSettings.spatialWidthGr,
      h: page.savedTableSettings.spatialHeightGr,
    };
  }

  const visibleCount = Math.max(0, Math.min(page.numberOfVisibleColumns, page.tableColumns.length));
  const columnsWidthGr = page.tableColumns.slice(0, visibleCount)
    .reduce((width, column) => width + column.widthGr, 0);
  const minimumWidthGr = 8 * GRID_SIZE;
  return {
    w: Math.min(Math.max(minimumWidthGr, columnsWidthGr), Math.max(minimumWidthGr, parent.innerSpatialWidthGr)),
    h: 6 * GRID_SIZE,
  };
}

export function pageWidthFromTable(table: TableItem): number {
  return table.savedPageSettings?.spatialWidthGr ?? 4 * GRID_SIZE;
}
