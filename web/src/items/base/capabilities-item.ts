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

import { ITEM_CAPABILITY_KEYS, Item, ItemCapabilities, ItemTypeMixin } from "./item";

export interface ItemCapabilitiesMixin {
  capabilities?: ItemCapabilities | null,
}

export interface ItemCapabilitiesItem extends ItemCapabilitiesMixin, Item { }

export function normalizeItemCapabilities(value: unknown): ItemCapabilities | null {
  if (value == null || typeof value != "object" || Array.isArray(value)) { return null; }

  const raw = value as Record<string, unknown>;
  const result: ItemCapabilities = {};
  for (const capability of ITEM_CAPABILITY_KEYS) {
    const enabled = raw[capability];
    if (typeof enabled == "boolean") {
      result[capability] = enabled;
    }
  }

  return Object.keys(result).length == 0 ? null : result;
}

export function itemCapabilities(item: ItemTypeMixin | null): ItemCapabilities | null {
  if (item == null) { return null; }
  const capabilities = (item as ItemCapabilitiesItem).capabilities;
  return normalizeItemCapabilities(capabilities);
}

export function itemCanEdit(item: ItemTypeMixin | null): boolean {
  return itemCapabilities(item)?.edit ?? true;
}

export function itemCanMove(item: ItemTypeMixin | null): boolean {
  return itemCapabilities(item)?.move ?? true;
}
