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

import { Component, For, Show, createMemo, createUniqueId, onCleanup } from "solid-js";

import { Z_INDEX_GLOBAL_ITEMS } from "../../constants";
import { RelationshipToParent } from "../../layout/relationship-to-parent";
import { VeFns, VisualElement } from "../../layout/visual-element";
import { useStore } from "../../store/StoreProvider";
import { GroupInspection } from "../../store/StoreProvider_Overlay";
import { BoundingBox } from "../../util/geometry";
import { InfuSignal, VisualElementSignal } from "../../util/signals";
import { Uid } from "../../util/uid";


interface PageGroupBoxesProps {
  childAreaBoundsPx: BoundingBox;
  childVes: Array<VisualElementSignal>;
  pageItemId: Uid;
}

const GROUP_BOX_PADDING_PX = 4;
const GROUP_BOX_BACKGROUND = "rgba(57, 81, 118, 0.045)";
const GROUP_BOX_BORDER = "rgba(57, 81, 118, 0.15)";
const GROUP_ACTIVE_BORDER = "rgba(57, 81, 118, 0.75)";
const GROUP_MEMBER_BACKGROUND = "rgba(57, 81, 118, 0.12)";

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
  const store = useStore();
  const ownerId = createUniqueId();
  const clearInspection = (signal: InfuSignal<GroupInspection | null>, groupId?: Uid) => {
    const current = signal.get();
    if (current?.ownerId == ownerId && (groupId == null || current.groupId == groupId)) {
      signal.set(null);
    }
  };
  const inspect = (signal: InfuSignal<GroupInspection | null>, groupId: Uid) => {
    signal.set({ pageItemId: props.pageItemId, groupId, ownerId });
  };
  onCleanup(() => {
    clearInspection(store.overlay.hoveredGroup);
    clearInspection(store.overlay.focusedGroup);
  });

  const activeGroupId = createMemo(() => {
    if (store.anItemIsMoving.get() || store.overlay.selectionMarqueePx.get() != null) { return null; }
    const inspection = store.overlay.hoveredGroup.get() ?? store.overlay.focusedGroup.get();
    return inspection?.pageItemId == props.pageItemId ? inspection.groupId : null;
  });

  const groups = createMemo(() => {
    const result = new Map<Uid, { boundsPx: BoundingBox, members: Array<BoundingBox> }>();

    for (const childVes of props.childVes) {
      const childVe = childVes.get();
      const groupId = childGroupId(childVe, props.pageItemId);
      if (groupId == null) { continue; }

      const group = result.get(groupId) ?? { boundsPx: childVe.boundsPx, members: [] };
      group.boundsPx = addToBounds(group.boundsPx, childVe.boundsPx);
      group.members.push(childVe.boundsPx);
      result.set(groupId, group);
    }
    return result;
  });

  // Key by group ID so rearranging items does not replace a focused/hovered outline.
  const groupIds = createMemo(() => [...groups()].filter(([, group]) =>
    group.members.length >= 2).map(([id]) => id));
  const highlightedMembers = createMemo(() => {
    const groupId = activeGroupId();
    return groupId == null ? [] : groups().get(groupId)?.members ?? [];
  });

  return (
    <>
      <For each={groupIds()}>{groupId => {
        const bounds = () => paddedAndClampedBounds(groups().get(groupId)!.boundsPx, props.childAreaBoundsPx);
        const positionStyle = () => `left: ${bounds().x}px; top: ${bounds().y}px; ` +
          `width: ${bounds().w}px; height: ${bounds().h}px; `;
        onCleanup(() => {
          clearInspection(store.overlay.hoveredGroup, groupId);
          clearInspection(store.overlay.focusedGroup, groupId);
        });
        return <Show when={bounds().w > 0 && bounds().h > 0}>
          <div class="absolute pointer-events-none"
            data-group-id={groupId}
            style={positionStyle() +
              `background-color: ${GROUP_BOX_BACKGROUND}; border: 1px solid ${GROUP_BOX_BORDER}; ` +
              `border-radius: 6px; box-sizing: border-box; z-index: 0;`} />
          <div class="absolute pointer-events-none"
            tabIndex={0}
            role="group"
            aria-label={`Item group, ${groups().get(groupId)!.members.length} visible members`}
            contentEditable={false}
            data-group-outline={groupId}
            style={positionStyle() + `outline: none; z-index: ${Z_INDEX_GLOBAL_ITEMS + 1};`}
            onFocus={() => inspect(store.overlay.focusedGroup, groupId)}
            onBlur={() => clearInspection(store.overlay.focusedGroup, groupId)}
            on:keydown={ev => {
              // Preserve native Tab navigation; inspecting a group must not run item commands.
              ev.stopPropagation();
              if (ev.key == "Escape") {
                ev.preventDefault();
                ev.currentTarget.blur();
              }
            }}
            on:keyup={ev => ev.stopPropagation()}>
            <svg width="100%" height="100%" class="absolute overflow-visible" aria-hidden="true">
              <rect x="0.5" y="0.5" width={Math.max(0, bounds().w - 1)} height={Math.max(0, bounds().h - 1)}
                rx="5.5" fill="none" stroke={activeGroupId() == groupId ? GROUP_ACTIVE_BORDER : "none"} />
              {/* Only the narrow border accepts pointer events, never the enclosed content. */}
              <rect x="0.5" y="0.5" width={Math.max(0, bounds().w - 1)} height={Math.max(0, bounds().h - 1)}
                rx="5.5" fill="none" stroke="transparent" stroke-width="6"
                style="pointer-events: stroke;"
                onPointerEnter={() => inspect(store.overlay.hoveredGroup, groupId)}
                onPointerLeave={() => clearInspection(store.overlay.hoveredGroup, groupId)}
                onMouseDown={ev => ev.preventDefault()} />
            </svg>
          </div>
        </Show>;
      }}</For>
      <For each={highlightedMembers()}>{bounds =>
        <div class="absolute pointer-events-none"
          aria-hidden="true"
          data-group-member-highlight={activeGroupId()}
          style={`left: ${bounds.x}px; top: ${bounds.y}px; width: ${bounds.w}px; height: ${bounds.h}px; ` +
            `background-color: ${GROUP_MEMBER_BACKGROUND}; border: 1px solid ${GROUP_ACTIVE_BORDER}; ` +
            `border-radius: 4px; box-sizing: border-box; z-index: ${Z_INDEX_GLOBAL_ITEMS + 1};`} />
      }</For>
    </>
  );
};
