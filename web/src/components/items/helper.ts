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
import { VisualElement } from "../../layout/visual-element";
import { cloneBoundingBox } from "../../util/geometry";


export const createHighlightBoundsPxFn = (ve: VisualElement) => {
  return (() => {
    if (ve.displayItem.relationshipToParent == RelationshipToParent.Child &&
        ve.tableDimensionsPx) { // not set if not in table.
      let r = cloneBoundingBox(ve.boundsPx)!;
      r.w = ve.tableDimensionsPx!.w;
      return r;
    }
    return ve.boundsPx;
  })
}

export const createLineHighlightBoundsPxFn = (ve: VisualElement) => {
  return (() => {
    if (ve.displayItem.relationshipToParent == RelationshipToParent.Attachment &&
        ve.tableDimensionsPx) { // not set if not in table.
      let r = cloneBoundingBox(ve.boundsPx)!;
      r.x = 0;
      r.w = ve.tableDimensionsPx!.w;
      return r;
    }
    return null;
  })
}
