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

import { Item } from "../../items/base/item";
import { asXSizableItem, isXSizableItem } from "../../items/base/x-sizeable-item";
import { LinkFns, LinkItem, asLinkItem, isLink } from "../../items/link-item";
import { StoreContextModel } from "../../store/StoreProvider";
import { itemState } from "../../store/ItemState";
import { EMPTY_UID } from "../../util/uid";
import { initiateLoadItemMaybe, initiateLoadItemFromRemoteMaybe } from "../load";


export interface VePropertiesForItem {
  displayItem: Item,
  linkItemMaybe: LinkItem | null,
  spatialWidthGr: number,
};


/**
 * Given an item, calculate the visual element display item (what is visually depicted), linkItemMaybe and spatialWidthGr.
 */
export function getVePropertiesForItem(store: StoreContextModel, item: Item): VePropertiesForItem {
  let displayItem = item;
  let linkItemMaybe: LinkItem | null = null;
  let spatialWidthGr = isXSizableItem(displayItem)
    ? asXSizableItem(displayItem).spatialWidthGr
    : 0;
  if (!isLink(item)) {
    return { displayItem, linkItemMaybe, spatialWidthGr };
  }

  linkItemMaybe = asLinkItem(item);
  const linkToId = LinkFns.getLinkToId(linkItemMaybe);
  const displayItemMaybe = itemState.get(linkToId)!;
  if (displayItemMaybe != null) {
    displayItem = displayItemMaybe!;
    if (isXSizableItem(displayItem)) {
      spatialWidthGr = linkItemMaybe.spatialWidthGr;
    }
  } else {
    if (linkItemMaybe.linkTo != EMPTY_UID) {
      if (linkItemMaybe.linkToBaseUrl == "") {
        if (linkItemMaybe.origin == null) {
          initiateLoadItemMaybe(store, linkItemMaybe.linkTo);
        } else {
          initiateLoadItemFromRemoteMaybe(store, linkItemMaybe.linkTo, linkItemMaybe.origin, linkItemMaybe.id);
        }
      } else {
        initiateLoadItemFromRemoteMaybe(store, linkItemMaybe.linkTo, linkItemMaybe.linkToBaseUrl, linkItemMaybe.id);
      }
    }
  }

  return { displayItem, linkItemMaybe, spatialWidthGr };
}
