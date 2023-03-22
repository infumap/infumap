/*
  Copyright (C) 2022-2023 The Infumap Authors
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

import { BooleanSignal } from '../../../../util/signals';
import { Uid } from '../../../../util/uid';
import { PositionalMixin } from './positional-item';


export const ITEM_TYPE_PAGE = "page";
export const ITEM_TYPE_TABLE = "table";
export const ITEM_TYPE_NOTE = "note";
export const ITEM_TYPE_FILE = "file";
export const ITEM_TYPE_IMAGE = "image";
export const ITEM_TYPE_RATING = "rating";
export const ITEM_TYPE_LINK = "link";

export interface ItemTypeMixin {
  itemType: string,
}

export interface Measurable extends ItemTypeMixin { }

export interface Item extends ItemTypeMixin, PositionalMixin {
  ownerId: Uid,
  id: Uid,
  parentId: Uid,
  relationshipToParent: string,
  creationDate: number,
  lastModifiedDate: number,
  ordering: Uint8Array,

  computed_mouseIsOver: BooleanSignal,
}
