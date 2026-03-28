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

import { Component, For, Show, createEffect, createSignal } from "solid-js";
import { VisualElement_Desktop } from "../VisualElement";
import { PageVisualElementProps } from "./Page";
import { VesCache } from "../../layout/ves-cache";
import { VeFns, VisualElement } from "../../layout/visual-element";


// REMINDER: it is not valid to access VesCache in the item components (will result in heisenbugs)

const MAX_PRESERVED_UMBRELLA_CHILDREN = 4;

interface PreservedChildEntry {
  key: string,
  visualElement: VisualElement,
}

export const Page_Umbrella: Component<PageVisualElementProps> = (props: PageVisualElementProps) => {
  const preserveMountedSubtrees = () => Boolean((globalThis as any).__INFUMAP_PRESERVE_PAGE_SUBTREE_DEBUG__);
  const childSignals = () => VesCache.render.getChildren(VeFns.veToPath(props.visualElement))();
  const childKey = (visualElement: VisualElement) => VeFns.actualVeidFromVe(visualElement).itemId;
  const activeChildKeys = () => new Set(childSignals().map(childVes => childKey(childVes.get())));
  const [preservedChildren, setPreservedChildren] = createSignal<PreservedChildEntry[]>([]);

  createEffect(() => {
    if (!preserveMountedSubtrees()) {
      setPreservedChildren([]);
      return;
    }

    const currentChildren = childSignals().map(childVes => childVes.get());
    if (currentChildren.length == 0) {
      return;
    }

    setPreservedChildren((prev) => {
      let next = prev.slice();
      for (const childVe of currentChildren) {
        next = next.filter(entry => entry.key !== childKey(childVe));
        next.push({
          key: childKey(childVe),
          visualElement: childVe,
        });
      }
      return next.slice(-MAX_PRESERVED_UMBRELLA_CHILDREN);
    });
  });

  return (
    <div class={`absolute`}
      style={`left: ${props.pageFns.boundsPx().x}px; top: ${props.pageFns.boundsPx().y}px; width: ${props.pageFns.boundsPx().w}px; height: ${props.pageFns.boundsPx().h}px; ` +
        `background-color: #ffffff;`}>
      <Show when={preserveMountedSubtrees()} fallback={
        <For each={childSignals()}>{childVes =>
          <VisualElement_Desktop visualElement={childVes.get()} />
        }</For>
      }>
        <For each={preservedChildren()}>{childEntry =>
          <div style={`display: ${activeChildKeys().has(childEntry.key) ? "block" : "none"};`}>
            <VisualElement_Desktop visualElement={childEntry.visualElement} />
          </div>
        }</For>
      </Show>
      <Show when={VesCache.render.getDock(VeFns.veToPath(props.visualElement))() != null && VesCache.render.getDock(VeFns.veToPath(props.visualElement))()!.get() != null}>
        <VisualElement_Desktop visualElement={VesCache.render.getDock(VeFns.veToPath(props.visualElement))()!.get()!} />
      </Show>
    </div>
  );
}
