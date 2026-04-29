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

import { VisualElement, VisualElementFlags } from "../../layout/visual-element";


export interface IconMixin {
  emoji: string | null,
  iconMode: ItemIconMode,
}

export enum ItemIconMode {
  Auto = "auto",
  None = "none",
  Symbol = "symbol",
  Favicon = "favicon",
}

export enum ItemIconRenderContext {
  Spatial = "spatial",
  Line = "line",
  TableAttachment = "table-attachment",
}

export function isItemIconMode(value: any): value is ItemIconMode {
  return value == ItemIconMode.Auto ||
    value == ItemIconMode.None ||
    value == ItemIconMode.Symbol ||
    value == ItemIconMode.Favicon;
}

export function itemIconModeFromObject(o: any, allowFavicon: boolean): ItemIconMode {
  if (isItemIconMode(o.iconMode) && (allowFavicon || o.iconMode != ItemIconMode.Favicon)) {
    return o.iconMode;
  }
  const emoji = o.emoji?.trim();
  return emoji && emoji != ""
    ? ItemIconMode.Symbol
    : ItemIconMode.Auto;
}

export function itemIconKind(
  iconMode: ItemIconMode,
  context: ItemIconRenderContext,
  faviconAvailable: boolean,
): ItemIconMode.None | ItemIconMode.Symbol | ItemIconMode.Favicon {
  if (iconMode == ItemIconMode.None) { return ItemIconMode.None; }
  if (iconMode == ItemIconMode.Symbol) { return ItemIconMode.Symbol; }
  if (iconMode == ItemIconMode.Favicon) { return ItemIconMode.Favicon; }
  if (context != ItemIconRenderContext.Line) { return ItemIconMode.None; }
  return faviconAvailable ? ItemIconMode.Favicon : ItemIconMode.Symbol;
}

export function iconRenderContextFromVisualElement(visualElement: VisualElement): ItemIconRenderContext {
  if ((visualElement.flags & VisualElementFlags.InsideTable) && (visualElement.flags & VisualElementFlags.Attachment)) {
    return ItemIconRenderContext.TableAttachment;
  }
  if (visualElement.flags & VisualElementFlags.LineItem) {
    return ItemIconRenderContext.Line;
  }
  return ItemIconRenderContext.Spatial;
}
