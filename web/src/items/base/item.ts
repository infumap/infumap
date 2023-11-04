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

import { RelationshipToParent } from '../../layout/relationship-to-parent';
import { EMPTY_UID, Uid } from '../../util/uid';


export const ItemType = {
  None: "none",
  Page: "page",
  Table: "table",
  Composite: "composite",
  Note: "note",
  File: "file",
  Password: "password",
  Image: "image",
  Rating: "rating",
  Link: "link",
  Placeholder: "placeholder"
};


export interface ItemTypeMixin {
  itemType: string,
}

export interface Measurable extends ItemTypeMixin { }

export interface Item extends ItemTypeMixin {
  origin: string | null,
  ownerId: Uid,
  id: Uid,
  parentId: Uid,
  relationshipToParent: string,
  creationDate: number,
  lastModifiedDate: number,
  ordering: Uint8Array,
}

export const EMPTY_ITEM = () => ({
  origin: null,
  itemType: ItemType.None,
  ownerId: EMPTY_UID,
  id: EMPTY_UID,
  parentId: EMPTY_UID,
  relationshipToParent: RelationshipToParent.Child,
  creationDate: 0,
  lastModifiedDate: 0,
  ordering: Uint8Array.from([]),
});
