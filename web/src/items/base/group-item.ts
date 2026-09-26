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


import { RelationshipToParent } from "../../layout/relationship-to-parent";
import { itemState } from "../../store/ItemState";
import { Uid } from "../../util/uid";
import { Item } from "./item";


// A group exists only while at least two children of the same container share
// a groupId. When other members are moved out or deleted, the groupId left on
// a single remaining child is inert: it is not a group, and readers must treat
// it as such.
export const GroupFns = {

  memberIds: (parentId: Uid, groupId: Uid): Array<Uid> => {
    const parent = itemState.getAsContainerItem(parentId);
    if (parent == null) { return []; }
    return parent.computed_children.filter(childId => itemState.get(childId)?.groupId == groupId);
  },

  effectiveGroupId: (item: Item): Uid | null => {
    if (item.groupId == null || item.relationshipToParent != RelationshipToParent.Child) { return null; }
    return GroupFns.memberIds(item.parentId, item.groupId).length >= 2 ? item.groupId : null;
  },

};
