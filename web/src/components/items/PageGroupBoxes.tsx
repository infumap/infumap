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

import { Component, For, createMemo } from "solid-js";

import { RelationshipToParent } from "../../layout/relationship-to-parent";
import { VeFns, VisualElement } from "../../layout/visual-element";
import { BoundingBox } from "../../util/geometry";
import { VisualElementSignal } from "../../util/signals";
import { Uid } from "../../util/uid";


interface PageGroupBoxesProps {
  childAreaBoundsPx: BoundingBox;
  childVes: Array<VisualElementSignal>;
  pageItemId: Uid;
}

interface PageGroupBox {
  groupId: Uid;
  boundsPx: BoundingBox;
}

const GROUP_BOX_PADDING_PX = 4;
const GROUP_BOX_BACKGROUND = "rgba(57, 81, 118, 0.045)";
const GROUP_BOX_BORDER = "rgba(57, 81, 118, 0.15)";

function addToBounds(bounds: BoundingBox | null, next: BoundingBox): BoundingBox {
  if (bounds == null) {
    return { ...next };
  }

  const x1 = Math.min(bounds.x, next.x);
  const y1 = Math.min(bounds.y, next.y);
  const x2 = Math.max(bounds.x + bounds.w, next.x + next.w);
  const y2 = Math.max(bounds.y + bounds.h, next.y + next.h);
  return {
    x: x1,
    y: y1,
    w: x2 - x1,
    h: y2 - y1,
  };
}

function paddedAndClampedBounds(bounds: BoundingBox, childAreaBounds: BoundingBox): BoundingBox {
  const x1 = Math.max(0, bounds.x - GROUP_BOX_PADDING_PX);
  const y1 = Math.max(0, bounds.y - GROUP_BOX_PADDING_PX);
  const x2 = Math.min(childAreaBounds.w, bounds.x + bounds.w + GROUP_BOX_PADDING_PX);
  const y2 = Math.min(childAreaBounds.h, bounds.y + bounds.h + GROUP_BOX_PADDING_PX);
  return {
    x: x1,
    y: y1,
    w: Math.max(0, x2 - x1),
    h: Math.max(0, y2 - y1),
  };
}

function childGroupId(ve: VisualElement, pageItemId: Uid): Uid | null {
  const treeItem = VeFns.treeItem(ve);
  if (treeItem.relationshipToParent != RelationshipToParent.Child ||
    treeItem.parentId != pageItemId ||
    treeItem.groupId == null) {
    return null;
  }
  return treeItem.groupId;
}

export const PageGroupBoxes: Component<PageGroupBoxesProps> = (props: PageGroupBoxesProps) => {
  const groupBoxes = createMemo<Array<PageGroupBox>>(() => {
    const groups = new Map<Uid, { boundsPx: BoundingBox | null, count: number }>();

    for (const childVes of props.childVes) {
      const childVe = childVes.get();
      const groupId = childGroupId(childVe, props.pageItemId);
      if (groupId == null) { continue; }

      const group = groups.get(groupId) ?? { boundsPx: null, count: 0 };
      group.boundsPx = addToBounds(group.boundsPx, childVe.boundsPx);
      group.count += 1;
      groups.set(groupId, group);
    }

    const boxes: Array<PageGroupBox> = [];
    for (const [groupId, group] of groups) {
      if (group.count < 2 || group.boundsPx == null) { continue; }

      const boundsPx = paddedAndClampedBounds(group.boundsPx, props.childAreaBoundsPx);
      if (boundsPx.w <= 0 || boundsPx.h <= 0) { continue; }

      boxes.push({ groupId, boundsPx });
    }

    return boxes;
  });

  return (
    <For each={groupBoxes()}>{groupBox =>
      <div class="absolute pointer-events-none"
        data-group-id={groupBox.groupId}
        style={`left: ${groupBox.boundsPx.x}px; ` +
          `top: ${groupBox.boundsPx.y}px; ` +
          `width: ${groupBox.boundsPx.w}px; ` +
          `height: ${groupBox.boundsPx.h}px; ` +
          `background-color: ${GROUP_BOX_BACKGROUND}; ` +
          `border: 1px solid ${GROUP_BOX_BORDER}; ` +
          `border-radius: 6px; ` +
          `box-sizing: border-box; ` +
          `z-index: 0;`} />
    }</For>
  );
};
