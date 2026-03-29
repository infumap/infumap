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

import { Accessor, Setter } from "solid-js";
import { Item } from "../../items/base/item";
import { VisualElement, VisualElementPath } from "../visual-element";
import { VisualElementSignal } from "../../util/signals";
import { Uid } from "../../util/uid";

export type ReactiveSlot<T> = {
  value: T;
  signal: [Accessor<T>, Setter<T>] | null;
}

export type ReactiveEntry = {
  node: ReactiveSlot<VisualElementSignal | undefined>;
  popup: ReactiveSlot<VisualElementSignal | null>;
  selected: ReactiveSlot<VisualElementSignal | null>;
  dock: ReactiveSlot<VisualElementSignal | null>;
  focused: ReactiveSlot<Item | null>;
  attachments: ReactiveSlot<Array<VisualElementSignal>>;
  children: ReactiveSlot<Array<VisualElementSignal>>;
  lineChildren: ReactiveSlot<Array<VisualElementSignal>>;
  desktopChildren: ReactiveSlot<Array<VisualElementSignal>>;
  nonMovingChildren: ReactiveSlot<Array<VisualElementSignal>>;
  tableRows: Array<number> | null;
}

export type SceneRelationshipData = {
  attachments: Array<VisualElementPath>;
  popup: VisualElementPath | null;
  selected: VisualElementPath | null;
  dock: VisualElementPath | null;
  children: Array<VisualElementPath>;
  lineChildren: Array<VisualElementPath>;
  desktopChildren: Array<VisualElementPath>;
  nonMovingChildren: Array<VisualElementPath>;
  focusedChildItemMaybe: Item | null;
}

export type SceneRelationshipsByPath = Map<VisualElementPath, SceneRelationshipData>;

export type SceneState = {
  cache: Map<VisualElementPath, VisualElement>;
  vessVsDisplayId: Map<Uid, Array<VisualElementPath>>;
  childrenByParent: Map<VisualElementPath, Array<VisualElementPath>>;
  vessByVeid: Map<string, Array<VisualElementPath>>;
  relationshipsByPath: SceneRelationshipsByPath;
}

export type VirtualSceneState = SceneState;

export type SceneOutputs = {
  topTitledPages: Array<VisualElementPath>;
  watchContainerUidsByOrigin: Map<string | null, Set<Uid>>;
}

export function createEmptySceneState(): SceneState {
  return {
    cache: new Map<VisualElementPath, VisualElement>(),
    vessVsDisplayId: new Map<Uid, Array<VisualElementPath>>(),
    childrenByParent: new Map<VisualElementPath, Array<VisualElementPath>>(),
    vessByVeid: new Map<string, Array<VisualElementPath>>(),
    relationshipsByPath: new Map(),
  };
}

export function createEmptyVirtualSceneState(): VirtualSceneState {
  return createEmptySceneState();
}

export function createEmptySceneOutputs(): SceneOutputs {
  return {
    topTitledPages: [],
    watchContainerUidsByOrigin: new Map<string | null, Set<Uid>>(),
  };
}

export type VesCacheState = {
  reactiveEntriesByPath: Map<VisualElementPath, ReactiveEntry>;
  currentlyInFullArrange: boolean;
  currentScene: SceneState;
  virtualScene: VirtualSceneState;
  underConstructionScene: SceneState;
  underConstructionArrangeSignalsByPath: Map<VisualElementPath, VisualElementSignal>;
  underConstructionReactiveTableRowsByPath: Map<VisualElementPath, Array<number>>;
  currentSceneOutputs: SceneOutputs;
  underConstructionSceneOutputs: SceneOutputs;
}

export function createVesCacheState(): VesCacheState {
  return {
    reactiveEntriesByPath: new Map<VisualElementPath, ReactiveEntry>(),
    currentlyInFullArrange: false,
    currentScene: createEmptySceneState(),
    virtualScene: createEmptyVirtualSceneState(),
    underConstructionScene: createEmptySceneState(),
    underConstructionArrangeSignalsByPath: new Map<VisualElementPath, VisualElementSignal>(),
    underConstructionReactiveTableRowsByPath: new Map<VisualElementPath, Array<number>>(),
    currentSceneOutputs: createEmptySceneOutputs(),
    underConstructionSceneOutputs: createEmptySceneOutputs(),
  };
}
