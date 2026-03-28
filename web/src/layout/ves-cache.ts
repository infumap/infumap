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

import { createSignal, Accessor, Setter } from "solid-js";
import { asContainerItem, isContainer } from "../items/base/container-item";
import { ItemFns } from "../items/base/item-polymorphism";
import { StoreContextModel } from "../store/StoreProvider";
import { compareBoundingBox, compareDimensions } from "../util/geometry";
import { panic } from "../util/lang";
import { VisualElementSignal, createVisualElementSignal } from "../util/signals";
import { Uid } from "../util/uid";
import { HitboxFns } from "./hitbox";
import { VeFns, Veid, VisualElement, VisualElementFlags, VisualElementPath, VisualElementRelationships, VisualElementSpec } from "./visual-element";

/*
  Explanation:

  at this end i have my "virtual dom diffing" equivalent code going for 
  the main display. what i have feels good enough to go with. whenever 
  there is a change to an item, i need to manually call 'arrange', and it 
  does the virtual diff and optimally updates a separate 'visual element' 
  tree comprising solidjs signals which the dom then micro-reactively 
  responds to when they change. the key benefit of the approach is that 
  in many scenarios, i could call an alternative method "arrangeWithId" or 
  some other variant, which bypasses almost all of the diffing computation.
  This should make most animation / visual mouse interaction super
  performant. The reason i need the full diffing is that sometimes a
  change to one item could impact the arrangement of many others in complex
  ways. but in such cases i don't want to wipe away all existing dom
  elements and replace them.
*/

// Reactive map for popupVes
// We store [read, write] signal pairs for each path.
let reactivePopups = new Map<VisualElementPath, [Accessor<VisualElementSignal | null>, Setter<VisualElementSignal | null>]>();

function getReactivePopupSignal(path: VisualElementPath) {
  let entry = reactivePopups.get(path);
  if (!entry) {
    entry = createSignal<VisualElementSignal | null>(null);
    reactivePopups.set(path, entry);
  }
  return entry;
}

function updateReactivePopup(path: VisualElementPath, value: VisualElementSignal | null) {
  const [read, write] = getReactivePopupSignal(path);
  if (read() !== value) {
    write(value);
  }
}

// Reactive map for selectedVes
let reactiveSelecteds = new Map<VisualElementPath, [Accessor<VisualElementSignal | null>, Setter<VisualElementSignal | null>]>();

function getReactiveSelectedSignal(path: VisualElementPath) {
  let entry = reactiveSelecteds.get(path);
  if (!entry) {
    entry = createSignal<VisualElementSignal | null>(null);
    reactiveSelecteds.set(path, entry);
  }
  return entry;
}

function updateReactiveSelected(path: VisualElementPath, value: VisualElementSignal | null) {
  const [read, write] = getReactiveSelectedSignal(path);
  if (read() !== value) {
    write(value);
  }
}

// Reactive map for dockVes
let reactiveDocks = new Map<VisualElementPath, [Accessor<VisualElementSignal | null>, Setter<VisualElementSignal | null>]>();

function getReactiveDockSignal(path: VisualElementPath) {
  let entry = reactiveDocks.get(path);
  if (!entry) {
    entry = createSignal<VisualElementSignal | null>(null);
    reactiveDocks.set(path, entry);
  }
  return entry;
}

function updateReactiveDock(path: VisualElementPath, value: VisualElementSignal | null) {
  const [read, write] = getReactiveDockSignal(path);
  if (read() !== value) {
    write(value);
  }
}

// Reactive map for focusedChildItemMaybe
// Storing Item | null
import { Item } from "../items/base/item";
let reactiveFocused = new Map<VisualElementPath, [Accessor<Item | null>, Setter<Item | null>]>();

function getReactiveFocusedSignal(path: VisualElementPath) {
  let entry = reactiveFocused.get(path);
  if (!entry) {
    entry = createSignal<Item | null>(null);
    reactiveFocused.set(path, entry);
  }
  return entry;
}

function updateReactiveFocused(path: VisualElementPath, value: Item | null) {
  let [read, write] = getReactiveFocusedSignal(path);
  const current = read();
  if (current?.id !== value?.id) {
    write(value);
  } else if (current !== value) {
    // Same ID, but object ref changed. Updating strictly might trigger signal.
    // We prefer to update IF object changed, relying on downstream to handle "same-id" efficiency if needed?
    // User requested "optimize reactivity".
    // If ID is same, we should probably NOT update signal to prevent downstream re-renders.
    // BUT if Item properties changed (e.g. background color), we NEED to update.
    // The previous implementation in VisualElement triggered on ref change.
    // The previous "Fix" (ID check) suppressed updates even if properties changed (bad?).
    // Wait. `focusedChildItemMaybe` is used for `backgroundColorIndex`.
    // If background color changed, ID is same.
    // We MUST update if properties changed.
    // So `if (read() !== value) write(value)`.
    // BUT we want to avoid "Mouse Move" causing "New Object with SAME Props".
    // Does mouse move cause new Item object?
    // `itemState.get(id)` usually returns same object unless Store updated.
    // User said "mouse move... focus changed probably".
    // If focus changed to SAME ID? No.
    // If focus changed to DIFFERENT ID? Yes.
    // So strict equality is fine, IF the Item objects are stable.
    write(value);
  }
}

// Reactive map for attachmentsVes
let reactiveAttachments = new Map<VisualElementPath, [Accessor<Array<VisualElementSignal>>, Setter<Array<VisualElementSignal>>]>();

function getReactiveAttachmentsSignal(path: VisualElementPath) {
  let entry = reactiveAttachments.get(path);
  if (!entry) {
    entry = createSignal<Array<VisualElementSignal>>([]);
    reactiveAttachments.set(path, entry);
  }
  return entry;
}

function updateReactiveAttachments(path: VisualElementPath, value: Array<VisualElementSignal> | undefined) {
  const actualValue = value ?? [];
  const [read, write] = getReactiveAttachmentsSignal(path);
  const current = read();
  if (current.length !== actualValue.length) {
    write(actualValue);
    return;
  }
  for (let i = 0; i < current.length; i++) {
    if (current[i] !== actualValue[i]) {
      write(actualValue);
      return;
    }
  }
}

// Reactive map for childrenVes
let reactiveChildren = new Map<VisualElementPath, [Accessor<Array<VisualElementSignal>>, Setter<Array<VisualElementSignal>>]>();

function getReactiveChildrenSignal(path: VisualElementPath) {
  let entry = reactiveChildren.get(path);
  if (!entry) {
    entry = createSignal<Array<VisualElementSignal>>([]);
    reactiveChildren.set(path, entry);
  }
  return entry;
}

function updateReactiveChildren(path: VisualElementPath, value: Array<VisualElementSignal> | undefined) {
  const actualValue = value ?? [];
  const [read, write] = getReactiveChildrenSignal(path);
  const current = read();
  if (current.length !== actualValue.length) {
    write(actualValue);
    return;
  }
  for (let i = 0; i < current.length; i++) {
    if (current[i] !== actualValue[i]) {
      write(actualValue);
      return;
    }
  }
}

// Reactive map for lineChildrenVes
let reactiveLineChildren = new Map<VisualElementPath, [Accessor<Array<VisualElementSignal>>, Setter<Array<VisualElementSignal>>]>();

function getReactiveLineChildrenSignal(path: VisualElementPath) {
  let entry = reactiveLineChildren.get(path);
  if (!entry) {
    entry = createSignal<Array<VisualElementSignal>>([]);
    reactiveLineChildren.set(path, entry);
  }
  return entry;
}

function updateReactiveLineChildren(path: VisualElementPath, value: Array<VisualElementSignal> | undefined) {
  const actualValue = value ?? [];
  const [read, write] = getReactiveLineChildrenSignal(path);
  const current = read();
  if (current.length !== actualValue.length) {
    write(actualValue);
    return;
  }
  for (let i = 0; i < current.length; i++) {
    if (current[i] !== actualValue[i]) {
      write(actualValue);
      return;
    }
  }
}

// Reactive map for desktopChildrenVes
let reactiveDesktopChildren = new Map<VisualElementPath, [Accessor<Array<VisualElementSignal>>, Setter<Array<VisualElementSignal>>]>();

function getReactiveDesktopChildrenSignal(path: VisualElementPath) {
  let entry = reactiveDesktopChildren.get(path);
  if (!entry) {
    entry = createSignal<Array<VisualElementSignal>>([]);
    reactiveDesktopChildren.set(path, entry);
  }
  return entry;
}

function updateReactiveDesktopChildren(path: VisualElementPath, value: Array<VisualElementSignal> | undefined) {
  const actualValue = value ?? [];
  const [read, write] = getReactiveDesktopChildrenSignal(path);
  const current = read();
  if (current.length !== actualValue.length) {
    write(actualValue);
    return;
  }
  for (let i = 0; i < current.length; i++) {
    if (current[i] !== actualValue[i]) {
      write(actualValue);
      return;
    }
  }
}

// Reactive map for nonMovingChildrenVes
let reactiveNonMovingChildren = new Map<VisualElementPath, [Accessor<Array<VisualElementSignal>>, Setter<Array<VisualElementSignal>>]>();

function getReactiveNonMovingChildrenSignal(path: VisualElementPath) {
  let entry = reactiveNonMovingChildren.get(path);
  if (!entry) {
    entry = createSignal<Array<VisualElementSignal>>([]);
    reactiveNonMovingChildren.set(path, entry);
  }
  return entry;
}

function updateReactiveNonMovingChildren(path: VisualElementPath, value: Array<VisualElementSignal> | undefined) {
  const actualValue = value ?? [];
  const [read, write] = getReactiveNonMovingChildrenSignal(path);
  const current = read();
  if (current.length !== actualValue.length) {
    write(actualValue);
    return;
  }
  for (let i = 0; i < current.length; i++) {
    if (current[i] !== actualValue[i]) {
      write(actualValue);
      return;
    }
  }
}

// Static map for tableVesRows (Not reactive, just storage)
let staticTableVesRows = new Map<VisualElementPath, Array<number> | null>();

let currentlyInFullArrange = false;

type VesAuxData = {
  displayItemFingerprint: Map<VisualElementPath, string>;
  attachmentsVes: Map<VisualElementPath, Array<VisualElementSignal>>;
  popupVes: Map<VisualElementPath, VisualElementSignal | null>;
  selectedVes: Map<VisualElementPath, VisualElementSignal | null>;
  dockVes: Map<VisualElementPath, VisualElementSignal | null>;
  childrenVes: Map<VisualElementPath, Array<VisualElementSignal>>;
  lineChildrenVes: Map<VisualElementPath, Array<VisualElementSignal>>;
  desktopChildrenVes: Map<VisualElementPath, Array<VisualElementSignal>>;
  nonMovingChildrenVes: Map<VisualElementPath, Array<VisualElementSignal>>;
  tableVesRows: Map<VisualElementPath, Array<number> | null>;
  focusedChildItemMaybe: Map<VisualElementPath, Item | null>;
}

type VirtualAuxData = {
  displayItemFingerprint: Map<VisualElementPath, string>;
  attachmentsVes: Map<VisualElementPath, Array<VisualElement>>;
  popupVes: Map<VisualElementPath, VisualElement | null>;
  selectedVes: Map<VisualElementPath, VisualElement | null>;
  dockVes: Map<VisualElementPath, VisualElement | null>;
  childrenVes: Map<VisualElementPath, Array<VisualElement>>;
  lineChildrenVes: Map<VisualElementPath, Array<VisualElement>>;
  desktopChildrenVes: Map<VisualElementPath, Array<VisualElement>>;
  nonMovingChildrenVes: Map<VisualElementPath, Array<VisualElement>>;
  tableVesRows: Map<VisualElementPath, Array<number> | null>;
  focusedChildItemMaybe: Map<VisualElementPath, Item | null>;
}

function createEmptyAuxData(): VesAuxData {
  return {
    displayItemFingerprint: new Map(),
    attachmentsVes: new Map(),
    popupVes: new Map(),
    selectedVes: new Map(),
    dockVes: new Map(),
    childrenVes: new Map(),
    lineChildrenVes: new Map(),
    desktopChildrenVes: new Map(),
    nonMovingChildrenVes: new Map(),
    tableVesRows: new Map(),
    focusedChildItemMaybe: new Map(),
  };
}

function createEmptyVirtualAuxData(): VirtualAuxData {
  return {
    displayItemFingerprint: new Map(),
    attachmentsVes: new Map(),
    popupVes: new Map(),
    selectedVes: new Map(),
    dockVes: new Map(),
    childrenVes: new Map(),
    lineChildrenVes: new Map(),
    desktopChildrenVes: new Map(),
    nonMovingChildrenVes: new Map(),
    tableVesRows: new Map(),
    focusedChildItemMaybe: new Map(),
  };
}

type SceneState = {
  cache: Map<VisualElementPath, VisualElementSignal>;
  vessVsDisplayId: Map<Uid, Array<VisualElementPath>>;
  childrenByParent: Map<VisualElementPath, Array<VisualElementSignal>>;
  vessByVeid: Map<string, Array<VisualElementSignal>>;
  aux: VesAuxData;
}

type VirtualSceneState = {
  cache: Map<VisualElementPath, VisualElement>;
  vessVsDisplayId: Map<Uid, Array<VisualElementPath>>;
  childrenByParent: Map<VisualElementPath, Array<VisualElement>>;
  vessByVeid: Map<string, Array<VisualElement>>;
  aux: VirtualAuxData;
}

function createEmptySceneState(): SceneState {
  return {
    cache: new Map<VisualElementPath, VisualElementSignal>(),
    vessVsDisplayId: new Map<Uid, Array<VisualElementPath>>(),
    childrenByParent: new Map<VisualElementPath, Array<VisualElementSignal>>(),
    vessByVeid: new Map<string, Array<VisualElementSignal>>(),
    aux: createEmptyAuxData(),
  };
}

function createEmptyVirtualSceneState(): VirtualSceneState {
  return {
    cache: new Map<VisualElementPath, VisualElement>(),
    vessVsDisplayId: new Map<Uid, Array<VisualElementPath>>(),
    childrenByParent: new Map<VisualElementPath, Array<VisualElement>>(),
    vessByVeid: new Map<string, Array<VisualElement>>(),
    aux: createEmptyVirtualAuxData(),
  };
}

type SceneOutputs = {
  topTitledPages: Array<VisualElementPath>;
  watchContainerUidsByOrigin: Map<string | null, Set<Uid>>;
}

function createEmptySceneOutputs(): SceneOutputs {
  return {
    topTitledPages: [],
    watchContainerUidsByOrigin: new Map<string | null, Set<Uid>>(),
  };
}

let currentScene = createEmptySceneState();
let virtualScene = createEmptyVirtualSceneState();
let underConstructionScene = createEmptySceneState();
let currentSceneOutputs = createEmptySceneOutputs();
let underConstructionSceneOutputs = createEmptySceneOutputs();

function getSceneNode(scene: SceneState, path: VisualElementPath): VisualElementSignal | undefined {
  return scene.cache.get(path);
}

function setSceneNode(scene: SceneState, path: VisualElementPath, ves: VisualElementSignal) {
  scene.cache.set(path, ves);
}

function deleteSceneNode(scene: SceneState, path: VisualElementPath): boolean {
  return scene.cache.delete(path);
}

function sceneHasNode(scene: SceneState, path: VisualElementPath): boolean {
  return scene.cache.has(path);
}

function getSceneParentPath(scene: SceneState, path: VisualElementPath): VisualElementPath | null {
  return getSceneNode(scene, path)?.get().parentPath ?? VeFns.parentPath(path) ?? null;
}

function getSceneIndexedChildren(scene: SceneState, parentPath: VisualElementPath): Array<VisualElementSignal> {
  return (scene.childrenByParent.get(parentPath) ?? []).slice();
}

function getSceneStructuralChildren(scene: SceneState, parentPath: VisualElementPath): Array<VisualElementSignal> {
  return (scene.aux.childrenVes.get(parentPath) ?? []).slice();
}

function getSceneSiblings(scene: SceneState, path: VisualElementPath): Array<VisualElementSignal> {
  const parentPath = getSceneParentPath(scene, path);
  if (parentPath == null) {
    return [];
  }
  return getSceneIndexedChildren(scene, parentPath)
    .filter(ves => VeFns.veToPath(ves.get()) != path);
}

function getScenePathsForDisplayId(scene: SceneState, displayId: Uid): Array<VisualElementPath> | undefined {
  return scene.vessVsDisplayId.get(displayId);
}

function addScenePathForDisplayId(scene: SceneState, displayId: Uid, path: VisualElementPath) {
  const existing = scene.vessVsDisplayId.get(displayId);
  if (!existing) {
    scene.vessVsDisplayId.set(displayId, [path]);
    return;
  }
  existing.push(path);
}

function getSceneVeidMatches(scene: SceneState, veid: Veid): Array<VisualElementSignal> {
  return (scene.vessByVeid.get(veidIndexKey(veid)) ?? []).slice();
}

function getSceneDisplayItemFingerprint(scene: SceneState, path: VisualElementPath): string | undefined {
  return scene.aux.displayItemFingerprint.get(path);
}

function getSceneTableRows(scene: SceneState, path: VisualElementPath): Array<number> | null {
  return scene.aux.tableVesRows.get(path) ?? null;
}

function readSceneNode(scene: SceneState, path: VisualElementPath): VisualElement | undefined {
  return getSceneNode(scene, path)?.get();
}

function readSceneIndexedChildren(scene: SceneState, parentPath: VisualElementPath): Array<VisualElement> {
  return getSceneIndexedChildren(scene, parentPath).map(ves => ves.get());
}

function readSceneStructuralChildren(scene: SceneState, parentPath: VisualElementPath): Array<VisualElement> {
  return getSceneStructuralChildren(scene, parentPath).map(ves => ves.get());
}

function readSceneSiblings(scene: SceneState, path: VisualElementPath): Array<VisualElement> {
  return getSceneSiblings(scene, path).map(ves => ves.get());
}

function cloneVisualElementSnapshot(ve: VisualElement): VisualElement {
  return {
    ...ve,
    resizingFromBoundsPx: ve.resizingFromBoundsPx ? { ...ve.resizingFromBoundsPx } : null,
    boundsPx: { ...ve.boundsPx },
    viewportBoundsPx: ve.viewportBoundsPx ? { ...ve.viewportBoundsPx } : null,
    childAreaBoundsPx: ve.childAreaBoundsPx ? { ...ve.childAreaBoundsPx } : null,
    listViewportBoundsPx: ve.listViewportBoundsPx ? { ...ve.listViewportBoundsPx } : null,
    listChildAreaBoundsPx: ve.listChildAreaBoundsPx ? { ...ve.listChildAreaBoundsPx } : null,
    tableDimensionsPx: ve.tableDimensionsPx ? { ...ve.tableDimensionsPx } : null,
    blockSizePx: ve.blockSizePx ? { ...ve.blockSizePx } : null,
    cellSizePx: ve.cellSizePx ? { ...ve.cellSizePx } : null,
    hitboxes: ve.hitboxes.slice(),
  };
}

function snapshotVirtualScene(scene: SceneState): VirtualSceneState {
  const snapshot = createEmptyVirtualSceneState();

  for (const [path, ves] of scene.cache) {
    snapshot.cache.set(path, cloneVisualElementSnapshot(ves.get()));
  }

  for (const [displayId, paths] of scene.vessVsDisplayId) {
    snapshot.vessVsDisplayId.set(displayId, paths.slice());
  }

  const detachedNodes = new Map<VisualElementPath, VisualElement>();
  const resolveVirtualNode = (ves: VisualElementSignal | null): VisualElement | null => {
    if (ves == null) {
      return null;
    }
    const path = VeFns.veToPath(ves.get());
    const existing = snapshot.cache.get(path) ?? detachedNodes.get(path);
    if (existing) {
      return existing;
    }
    const detached = cloneVisualElementSnapshot(ves.get());
    detachedNodes.set(path, detached);
    return detached;
  };
  const resolveVirtualNodes = (list: Array<VisualElementSignal> | undefined): Array<VisualElement> => {
    if (!list) {
      return [];
    }
    return list.map(ves => resolveVirtualNode(ves)!);
  };

  for (const [parentPath, children] of scene.childrenByParent) {
    snapshot.childrenByParent.set(parentPath, resolveVirtualNodes(children));
  }

  for (const [veidKey, matches] of scene.vessByVeid) {
    snapshot.vessByVeid.set(veidKey, resolveVirtualNodes(matches));
  }

  for (const [path, fingerprint] of scene.aux.displayItemFingerprint) {
    snapshot.aux.displayItemFingerprint.set(path, fingerprint);
  }
  for (const [path, attachments] of scene.aux.attachmentsVes) {
    snapshot.aux.attachmentsVes.set(path, resolveVirtualNodes(attachments));
  }
  for (const [path, popup] of scene.aux.popupVes) {
    snapshot.aux.popupVes.set(path, resolveVirtualNode(popup));
  }
  for (const [path, selected] of scene.aux.selectedVes) {
    snapshot.aux.selectedVes.set(path, resolveVirtualNode(selected));
  }
  for (const [path, dock] of scene.aux.dockVes) {
    snapshot.aux.dockVes.set(path, resolveVirtualNode(dock));
  }
  for (const [path, children] of scene.aux.childrenVes) {
    snapshot.aux.childrenVes.set(path, resolveVirtualNodes(children));
  }
  for (const [path, children] of scene.aux.lineChildrenVes) {
    snapshot.aux.lineChildrenVes.set(path, resolveVirtualNodes(children));
  }
  for (const [path, children] of scene.aux.desktopChildrenVes) {
    snapshot.aux.desktopChildrenVes.set(path, resolveVirtualNodes(children));
  }
  for (const [path, children] of scene.aux.nonMovingChildrenVes) {
    snapshot.aux.nonMovingChildrenVes.set(path, resolveVirtualNodes(children));
  }
  for (const [path, rows] of scene.aux.tableVesRows) {
    snapshot.aux.tableVesRows.set(path, rows ? rows.slice() : null);
  }
  for (const [path, item] of scene.aux.focusedChildItemMaybe) {
    snapshot.aux.focusedChildItemMaybe.set(path, item);
  }

  return snapshot;
}

function readVirtualSceneNode(path: VisualElementPath): VisualElement | undefined {
  return virtualScene.cache.get(path);
}

function readVirtualSceneIndexedChildren(parentPath: VisualElementPath): Array<VisualElement> {
  return (virtualScene.childrenByParent.get(parentPath) ?? []).slice();
}

function readVirtualSceneStructuralChildren(parentPath: VisualElementPath): Array<VisualElement> {
  return (virtualScene.aux.childrenVes.get(parentPath) ?? []).slice();
}

function readVirtualSceneSiblings(path: VisualElementPath): Array<VisualElement> {
  const parentPath = readVirtualSceneNode(path)?.parentPath ?? VeFns.parentPath(path) ?? null;
  if (parentPath == null) {
    return [];
  }
  return readVirtualSceneIndexedChildren(parentPath)
    .filter(ve => VeFns.veToPath(ve) != path);
}

function readVirtualSceneVeidMatches(veid: Veid): Array<VisualElement> {
  return (virtualScene.vessByVeid.get(veidIndexKey(veid)) ?? []).slice();
}

function findCurrentSceneMatches(veid: Veid): Array<VisualElementSignal> {
  const result: Array<VisualElementSignal> = [];
  for (const ves of getSceneVeidMatches(underConstructionScene, veid)) {
    result.push(ves);
  }
  for (const ves of getSceneVeidMatches(currentScene, veid)) {
    if (!result.find(r => r == ves)) {
      result.push(ves);
    }
  }
  return result;
}

function findSingleCurrentSceneMatch(veid: Veid): VisualElementSignal {
  const underConstructionMatches = getSceneVeidMatches(underConstructionScene, veid);
  if (underConstructionMatches.length > 1) {
    throw new Error(`multiple visual elements found: ${veid.itemId}/${veid.linkIdMaybe}.`);
  }
  if (underConstructionMatches.length == 1) {
    return underConstructionMatches[0];
  }
  const currentMatches = getSceneVeidMatches(currentScene, veid);
  if (currentMatches.length > 1) {
    throw new Error(`multiple visual elements found: ${veid.itemId}/${veid.linkIdMaybe}.`);
  }
  if (currentMatches.length == 0) {
    throw new Error(`${veid.itemId}/${veid.linkIdMaybe} not present in VesCache.`);
  }
  return currentMatches[0];
}

function writeScenePath(
  scene: SceneState,
  path: VisualElementPath,
  ves: VisualElementSignal,
  relationships: VisualElementRelationships,
) {
  setSceneNode(scene, path, ves);
  syncAuxData(scene.aux, path, ves.get(), relationships);
  indexVisualElement(scene, path, ves);
}

function syncReactiveStateForPath(scene: SceneState, path: VisualElementPath) {
  updateReactivePopup(path, scene.aux.popupVes.get(path) ?? null);
  updateReactiveSelected(path, scene.aux.selectedVes.get(path) ?? null);
  updateReactiveDock(path, scene.aux.dockVes.get(path) ?? null);
  updateReactiveAttachments(path, scene.aux.attachmentsVes.get(path));
  updateReactiveChildren(path, scene.aux.childrenVes.get(path));
  updateReactiveLineChildren(path, scene.aux.lineChildrenVes.get(path));
  updateReactiveDesktopChildren(path, scene.aux.desktopChildrenVes.get(path));
  updateReactiveNonMovingChildren(path, scene.aux.nonMovingChildrenVes.get(path));
  updateReactiveFocused(path, scene.aux.focusedChildItemMaybe.get(path) ?? null);
  staticTableVesRows.set(path, getSceneTableRows(scene, path));
}

function clearReactiveStateForPath(path: VisualElementPath) {
  updateReactivePopup(path, null);
  updateReactiveSelected(path, null);
  updateReactiveDock(path, null);
  updateReactiveAttachments(path, []);
  updateReactiveChildren(path, []);
  updateReactiveLineChildren(path, []);
  updateReactiveDesktopChildren(path, []);
  updateReactiveNonMovingChildren(path, []);
  updateReactiveFocused(path, null);
  staticTableVesRows.delete(path);
}

function addSceneWatchContainerUid(outputs: SceneOutputs, uid: Uid, origin: string | null) {
  if (!outputs.watchContainerUidsByOrigin.has(origin)) {
    outputs.watchContainerUidsByOrigin.set(origin, new Set<Uid>());
  }
  outputs.watchContainerUidsByOrigin.get(origin)!.add(uid);
}

function pushTopTitledPage(outputs: SceneOutputs, vePath: VisualElementPath) {
  outputs.topTitledPages.push(vePath);
}

function removeSceneWatchContainerUid(outputs: SceneOutputs, uid: Uid, origin: string | null) {
  const uidSet = outputs.watchContainerUidsByOrigin.get(origin);
  if (!uidSet) {
    return;
  }
  uidSet.delete(uid);
  if (uidSet.size === 0) {
    outputs.watchContainerUidsByOrigin.delete(origin);
  }
}

function veidIndexKey(veid: Veid): string {
  return `${veid.itemId}\u0000${veid.linkIdMaybe ?? ""}`;
}

function veidIndexKeyFromPath(path: VisualElementPath): string {
  return veidIndexKey(VeFns.veidFromPath(path));
}

function addToIndex<K>(index: Map<K, Array<VisualElementSignal>>, key: K, ves: VisualElementSignal) {
  const existing = index.get(key);
  if (!existing) {
    index.set(key, [ves]);
    return;
  }
  existing.push(ves);
}

function removeFromIndex<K>(index: Map<K, Array<VisualElementSignal>>, key: K | null | undefined, ves: VisualElementSignal) {
  if (key == null) {
    return;
  }
  const existing = index.get(key);
  if (!existing) {
    panic(`missing index entry for '${String(key)}'.`);
  }
  const existingIndex = existing.findIndex(v => v === ves);
  if (existingIndex === -1) {
    panic(`signal missing from index entry for '${String(key)}'.`);
  }
  existing.splice(existingIndex, 1);
  if (existing.length === 0) {
    index.delete(key);
  }
}

function indexVisualElement(
  scene: SceneState,
  path: VisualElementPath,
  ves: VisualElementSignal,
) {
  const parentPath = ves.get().parentPath;
  if (parentPath != null) {
    addToIndex(scene.childrenByParent, parentPath, ves);
  }
  addToIndex(scene.vessByVeid, veidIndexKeyFromPath(path), ves);
}

function deindexVisualElement(
  scene: SceneState,
  path: VisualElementPath,
  ves: VisualElementSignal,
) {
  removeFromIndex(scene.childrenByParent, ves.get().parentPath, ves);
  removeFromIndex(scene.vessByVeid, veidIndexKeyFromPath(path), ves);
}

function splitChildrenVesByRenderBehavior(childrenVes: Array<VisualElementSignal> | undefined) {
  const allChildren = childrenVes ?? [];
  const lineChildren: Array<VisualElementSignal> = [];
  const desktopChildren: Array<VisualElementSignal> = [];
  const nonMovingChildren: Array<VisualElementSignal> = [];

  for (const childVe of allChildren) {
    const flags = childVe.get().flags;
    if (flags & VisualElementFlags.LineItem) {
      lineChildren.push(childVe);
    } else {
      desktopChildren.push(childVe);
    }
    if (!(flags & VisualElementFlags.Moving)) {
      nonMovingChildren.push(childVe);
    }
  }

  return {
    allChildren,
    lineChildren,
    desktopChildren,
    nonMovingChildren,
  };
}

function syncAuxData(aux: VesAuxData, path: VisualElementPath, ve: VisualElement, relationships: VisualElementRelationships | null) {
  const childBuckets = splitChildrenVesByRenderBehavior(relationships?.childrenVes);
  aux.displayItemFingerprint.set(path, ve.displayItemFingerprint);
  aux.attachmentsVes.set(path, relationships?.attachmentsVes ?? []);
  aux.popupVes.set(path, relationships?.popupVes ?? null);
  aux.selectedVes.set(path, relationships?.selectedVes ?? null);
  aux.dockVes.set(path, relationships?.dockVes ?? null);
  aux.childrenVes.set(path, childBuckets.allChildren);
  aux.lineChildrenVes.set(path, childBuckets.lineChildren);
  aux.desktopChildrenVes.set(path, childBuckets.desktopChildren);
  aux.nonMovingChildrenVes.set(path, childBuckets.nonMovingChildren);
  aux.tableVesRows.set(path, relationships?.tableVesRows ?? null);
  aux.focusedChildItemMaybe.set(path, relationships?.focusedChildItemMaybe ?? null);
}

function deleteAuxData(aux: VesAuxData, path: VisualElementPath) {
  aux.displayItemFingerprint.delete(path);
  aux.attachmentsVes.delete(path);
  aux.popupVes.delete(path);
  aux.selectedVes.delete(path);
  aux.dockVes.delete(path);
  aux.childrenVes.delete(path);
  aux.lineChildrenVes.delete(path);
  aux.desktopChildrenVes.delete(path);
  aux.nonMovingChildrenVes.delete(path);
  aux.tableVesRows.delete(path);
  aux.focusedChildItemMaybe.delete(path);
}

// Diagnostic counters for performance analysis
const LOG_ARRANGE_STATS = true;
let arrangeStats = { recycled: 0, dirty: 0, new: 0, dirtyReasons: new Map<string, number>() };
function resetArrangeStats() {
  arrangeStats = { recycled: 0, dirty: 0, new: 0, dirtyReasons: new Map<string, number>() };
}
function logDirtyReason(reason: string) {
  arrangeStats.dirty++;
  arrangeStats.dirtyReasons.set(reason, (arrangeStats.dirtyReasons.get(reason) || 0) + 1);
}
function logArrangeStats() {
  if (!LOG_ARRANGE_STATS) return;
  // console.log(`[VesCache] Arrange stats: recycled=${arrangeStats.recycled}, dirty=${arrangeStats.dirty}, new=${arrangeStats.new}`);
  if (arrangeStats.dirty > 0) {
    // console.log(`[VesCache] Dirty reasons:`, Object.fromEntries(arrangeStats.dirtyReasons));
  }
}

function logOrphanedVes(cache: Map<VisualElementPath, VisualElementSignal>, context: string) {
  // Diagnostic helper: reports any visual elements whose parentPath is missing from the cache.
  const orphans: Array<{ path: VisualElementPath, parentPath: VisualElementPath, itemId: string, flags: number }> = [];
  for (const [path, ves] of cache.entries()) {
    const ve = ves.get();
    if (ve.parentPath == null) { continue; }
    if (!cache.has(ve.parentPath)) {
      orphans.push({
        path,
        parentPath: ve.parentPath,
        itemId: ve.displayItem.id,
        flags: ve.flags,
      });
    }
  }
  if (orphans.length > 0) {
    console.warn("[VES_CACHE_DEBUG] Orphaned visual elements detected", { context, count: orphans.length, orphans });
  }
}

function syncReactiveStateFromScene(scene: SceneState) {
  for (const [path, signal] of scene.aux.popupVes) {
    updateReactivePopup(path, signal);
  }
  for (const [path, _] of reactivePopups) {
    if (!scene.aux.popupVes.has(path)) {
      updateReactivePopup(path, null);
    }
  }

  for (const [path, signal] of scene.aux.selectedVes) {
    updateReactiveSelected(path, signal);
  }
  for (const [path, _] of reactiveSelecteds) {
    if (!scene.aux.selectedVes.has(path)) {
      updateReactiveSelected(path, null);
    }
  }

  for (const [path, signal] of scene.aux.dockVes) {
    updateReactiveDock(path, signal);
  }
  for (const [path, _] of reactiveDocks) {
    if (!scene.aux.dockVes.has(path)) {
      updateReactiveDock(path, null);
    }
  }

  for (const [path, list] of scene.aux.attachmentsVes) {
    updateReactiveAttachments(path, list);
  }
  for (const [path, _] of reactiveAttachments) {
    if (!scene.aux.attachmentsVes.has(path)) {
      updateReactiveAttachments(path, []);
    }
  }

  for (const [path, list] of scene.aux.childrenVes) {
    updateReactiveChildren(path, list);
  }
  for (const [path, _] of reactiveChildren) {
    if (!scene.aux.childrenVes.has(path)) {
      updateReactiveChildren(path, []);
    }
  }

  for (const [path, list] of scene.aux.lineChildrenVes) {
    updateReactiveLineChildren(path, list);
  }
  for (const [path, _] of reactiveLineChildren) {
    if (!scene.aux.lineChildrenVes.has(path)) {
      updateReactiveLineChildren(path, []);
    }
  }

  for (const [path, list] of scene.aux.desktopChildrenVes) {
    updateReactiveDesktopChildren(path, list);
  }
  for (const [path, _] of reactiveDesktopChildren) {
    if (!scene.aux.desktopChildrenVes.has(path)) {
      updateReactiveDesktopChildren(path, []);
    }
  }

  for (const [path, list] of scene.aux.nonMovingChildrenVes) {
    updateReactiveNonMovingChildren(path, list);
  }
  for (const [path, _] of reactiveNonMovingChildren) {
    if (!scene.aux.nonMovingChildrenVes.has(path)) {
      updateReactiveNonMovingChildren(path, []);
    }
  }

  staticTableVesRows.clear();
  for (const [path, rows] of scene.aux.tableVesRows) {
    staticTableVesRows.set(path, rows);
  }

  for (const [path, item] of scene.aux.focusedChildItemMaybe) {
    updateReactiveFocused(path, item);
  }
  for (const [path, _] of reactiveFocused) {
    if (!scene.aux.focusedChildItemMaybe.has(path)) {
      updateReactiveFocused(path, null);
    }
  }
}

function promoteVirtualScene(scene: SceneState) {
  virtualScene = snapshotVirtualScene(scene);
}

function promoteCurrentScene(store: StoreContextModel, scene: SceneState, outputs: SceneOutputs) {
  currentScene = scene;
  currentSceneOutputs = outputs;
  store.topTitledPages.set(outputs.topTitledPages);
  logOrphanedVes(scene.cache, "full_finalizeArrange");
  logArrangeStats();
  syncReactiveStateFromScene(scene);
}

const currentSceneQueries = {
  getNode: (path: VisualElementPath): VisualElementSignal | undefined => {
    return getSceneNode(currentScene, path);
  },

  readNode: (path: VisualElementPath): VisualElement | undefined => {
    return readSceneNode(currentScene, path);
  },

  getIndexedChildren: (parentPath: VisualElementPath): Array<VisualElementSignal> => {
    return getSceneIndexedChildren(currentScene, parentPath);
  },

  readIndexedChildren: (parentPath: VisualElementPath): Array<VisualElement> => {
    return readSceneIndexedChildren(currentScene, parentPath);
  },

  getStructuralChildren: (parentPath: VisualElementPath): Array<VisualElementSignal> => {
    return getSceneStructuralChildren(currentScene, parentPath);
  },

  readStructuralChildren: (parentPath: VisualElementPath): Array<VisualElement> => {
    return readSceneStructuralChildren(currentScene, parentPath);
  },

  getSiblings: (path: VisualElementPath): Array<VisualElementSignal> => {
    return getSceneSiblings(currentScene, path);
  },

  readSiblings: (path: VisualElementPath): Array<VisualElement> => {
    return readSceneSiblings(currentScene, path);
  },

  find: (veid: Veid): Array<VisualElementSignal> => {
    return findCurrentSceneMatches(veid);
  },

  findNodes: (veid: Veid): Array<VisualElement> => {
    return findCurrentSceneMatches(veid).map(ves => ves.get());
  },

  findSingle: (veid: Veid): VisualElementSignal => {
    return findSingleCurrentSceneMatch(veid);
  },
};

const virtualSceneQueries = {
  readNode: (path: VisualElementPath): VisualElement | undefined => {
    return readVirtualSceneNode(path);
  },

  readIndexedChildren: (parentPath: VisualElementPath): Array<VisualElement> => {
    return readVirtualSceneIndexedChildren(parentPath);
  },

  readStructuralChildren: (parentPath: VisualElementPath): Array<VisualElement> => {
    return readVirtualSceneStructuralChildren(parentPath);
  },

  readSiblings: (path: VisualElementPath): Array<VisualElement> => {
    return readVirtualSceneSiblings(path);
  },

  findNodes: (veid: Veid): Array<VisualElement> => {
    return readVirtualSceneVeidMatches(veid);
  },
};

export let VesCache = {

  current: currentSceneQueries,

  virtual: virtualSceneQueries,

  /**
   * Re-initialize - clears all cached data.
   */
  clear: (): void => {
    currentScene = createEmptySceneState();
    currentSceneOutputs = createEmptySceneOutputs();
    staticTableVesRows = new Map<VisualElementPath, Array<number> | null>();
    virtualScene = createEmptyVirtualSceneState();
    underConstructionScene = createEmptySceneState();
    underConstructionSceneOutputs = createEmptySceneOutputs();

  },

  get: (path: VisualElementPath): VisualElementSignal | undefined => {
    return currentSceneQueries.getNode(path);
  },

  getSiblings: (path: VisualElementPath): Array<VisualElementSignal> => {
    return currentSceneQueries.getSiblings(path);
  },

  getPathsForDisplayId: (displayId: Uid): Array<VisualElementPath> => {
    return getScenePathsForDisplayId(currentScene, displayId)!;
  },

  addWatchContainerUid: (uid: Uid, origin: string | null): void => {
    addSceneWatchContainerUid(currentSceneOutputs, uid, origin);
  },



  getCurrentWatchContainerUidsByOrigin: (): Map<string | null, Set<Uid>> => {
    return currentSceneOutputs.watchContainerUidsByOrigin;
  },

  full_initArrange: (): void => {
    currentlyInFullArrange = true;
    resetArrangeStats();
  },

  full_finalizeArrange: (store: StoreContextModel, umbrellaSpec: VisualElementSpec, umbrellaRelationships: VisualElementRelationships, umbrellaPath: VisualElementPath, virtualUmbrellaVes?: VisualElementSignal): void => {
    if (umbrellaSpec.displayItemFingerprint) { panic("displayItemFingerprint is already set."); }
    umbrellaSpec.displayItemFingerprint = ItemFns.getFingerprint(umbrellaSpec.displayItem); // TODO (LOW): Modifying the input object is a bit nasty.
    const umbrellaVeSpec = { ...umbrellaSpec, ...umbrellaRelationships };

    if (virtualUmbrellaVes) {
      setSceneNode(underConstructionScene, umbrellaPath, virtualUmbrellaVes);
      // When restoring virtual, we don't have the spec easily, but virtualUmbrellaVes already has state.
      // Wait, syncAuxData reads from spec for popupVes.
      // If we are restoring from virtual, the virtual signal should be correct.
      // But VisualElement no longer has popupVes.
      // So where is popupVes? The virtual signal *contained* a VE.
      // If we are passing virtualUmbrellaVes, it is a VisualElementSignal.
      // The VE inside it doesn't have popupVes.
      // We need to fetch popupVes from somewhere.
      // But wait! If we pass `null` as spec, `syncAuxData` sets `popupVes` to `null`.
      // This is WRONG if the virtual element actually has a popup.
      // However, `full_finalizeArrange` with `virtualUmbrellaVes` is usually for restoring... 
      // Actually `virtualUmbrellaVes` is passed from `full_initArrange`? No.
      // It is optional.
      // Note: `virtualScene.cache` is where we store pre-calculated stuff?
      // If `virtualUmbrellaVes` comes from `virtualScene.cache` previously?
      // For now, I'll pass umbrellaVeSpec which is available in the function arguments.
      syncAuxData(underConstructionScene.aux, umbrellaPath, virtualUmbrellaVes.get(), umbrellaVeSpec);
      promoteVirtualScene(underConstructionScene);
    } else {
      setSceneNode(underConstructionScene, umbrellaPath, store.umbrellaVisualElement);  // TODO (MEDIUM): full property reconciliation, to avoid this update.
      store.umbrellaVisualElement.set(VeFns.create(umbrellaVeSpec));
      syncAuxData(underConstructionScene.aux, umbrellaPath, store.umbrellaVisualElement.get(), umbrellaVeSpec);
      promoteCurrentScene(store, underConstructionScene, underConstructionSceneOutputs);
    }

    underConstructionScene = createEmptySceneState();
    underConstructionSceneOutputs = createEmptySceneOutputs();

    currentlyInFullArrange = false;
  },

  isCurrentlyInFullArrange: (): boolean => {
    return currentlyInFullArrange;
  },

  /**
   * Creates or recycles an existing VisualElementSignal, if one exists for the specified path.
   * In the case of recycling, the overridden values (only) are checked against the existing visual element values.
   * I.e. a previously overridden value that is not overridden in the new ve spec will not be detected.
   * Note that this check always includes the display item fingerprint, to pick up on any non-geometric changes that still affect the item render.
   * I think the above strategy should always work in practice, but a more comprehensive (and expensive) comparison may be required in some instances.
   * The entire cache should cleared on page change (since there will be little or no overlap anyway).
   * This is achieved using initFullArrange and finalizeFullArrange methods.
   */
  full_createOrRecycleVisualElementSignal: (spec: VisualElementSpec, relationships: VisualElementRelationships, path: VisualElementPath): VisualElementSignal => {
    return createOrRecycleVisualElementSignalImpl(spec, relationships, path);
  },

  /**
   * Create a new VisualElementSignal and insert it into the current cache.
   */
  partial_create: (spec: VisualElementSpec, relationships: VisualElementRelationships, path: VisualElementPath): VisualElementSignal => {
    const visualElementOverride = { ...spec, ...relationships };
    const newElement = createVisualElementSignal(VeFns.create(visualElementOverride));
    writeScenePath(currentScene, path, newElement, relationships);
    syncReactiveStateForPath(currentScene, path);


    if (isContainer(visualElementOverride.displayItem) &&
      (visualElementOverride.flags! & VisualElementFlags.ShowChildren) &&
      asContainerItem(visualElementOverride.displayItem).childrenLoaded) {
      addSceneWatchContainerUid(currentSceneOutputs, visualElementOverride.displayItem.id, visualElementOverride.displayItem.origin);
    }
    const displayItemId = newElement.get().displayItem.id;

    addScenePathForDisplayId(currentScene, displayItemId, path);

    return newElement;
  },

  /**
   * Overwrites the provided ves with the provided override (which is generally expected to be for a new path).
   * Deletes any attachments of the existing ves.
   *
   * TODO (HIGH): should also delete children..., though this is never used
   */
  partial_overwriteVisualElementSignal: (spec: VisualElementSpec, relationships: VisualElementRelationships, newPath: VisualElementPath, vesToOverwrite: VisualElementSignal) => {
    const visualElementOverride = { ...spec, ...relationships };
    const veToOverwrite = vesToOverwrite.get();
    const existingPath = VeFns.veToPath(veToOverwrite);

    // Debug logging for potential path conflicts
    if (existingPath === newPath) {
      console.debug("[VES_CACHE_DEBUG] Overwriting visual element with same path:", {
        path: existingPath,
        displayItemId: veToOverwrite.displayItem.id,
        itemType: veToOverwrite.displayItem.itemType,
        timestamp: new Date().toISOString()
      });
    } else if (sceneHasNode(currentScene, newPath)) {
      console.error("[VES_CACHE_DEBUG] Path conflict detected - newPath already exists:", {
        existingPath: existingPath,
        newPath: newPath,
        existingDisplayItemId: veToOverwrite.displayItem.id,
        newDisplayItemId: visualElementOverride.displayItem.id,
        existingItemType: veToOverwrite.displayItem.itemType,
        newItemType: visualElementOverride.displayItem.itemType,
        timestamp: new Date().toISOString()
      });
    }

    const existingAttachments = VesCache.getAttachmentsVes(existingPath)();
    for (let i = 0; i < existingAttachments.length; ++i) {
      const attachmentVe = existingAttachments[i].get();
      const attachmentVePath = VeFns.veToPath(attachmentVe);
      if (sceneHasNode(currentScene, attachmentVePath)) {
        VesCache.removeByPath(attachmentVePath);
      }
    }

    if (!deleteSceneNode(currentScene, existingPath)) {
      console.error("[VES_CACHE_DEBUG] Failed to delete existing path:", {
        existingPath: existingPath,
        newPath: newPath,
        displayItemId: veToOverwrite.displayItem.id,
        cacheSize: currentScene.cache.size,
        timestamp: new Date().toISOString()
      });
      throw "vesToOverwrite did not exist";
    }
    deleteFromVessVsDisplayIdLookup(currentScene, existingPath);
    deindexVisualElement(currentScene, existingPath, vesToOverwrite);
    deleteAuxData(currentScene.aux, existingPath);
    if (existingPath != newPath) {
      clearReactiveStateForPath(existingPath);
    }
    VeFns.clearAndOverwrite(veToOverwrite, visualElementOverride);
    vesToOverwrite.set(veToOverwrite);
    writeScenePath(currentScene, newPath, vesToOverwrite, relationships);
    syncReactiveStateForPath(currentScene, newPath);


    if (isContainer(visualElementOverride.displayItem) &&
      (visualElementOverride.flags! & VisualElementFlags.ShowChildren) &&
      asContainerItem(visualElementOverride.displayItem).childrenLoaded) {
      addSceneWatchContainerUid(underConstructionSceneOutputs, spec.displayItem.id, visualElementOverride.displayItem.origin);
    }

    addScenePathForDisplayId(currentScene, VeFns.itemIdFromPath(newPath), newPath);
  },

  /**
   * Find all current cached visual element signals with the specified veid.
   * 
   * There may be more than one, because elements can be visible inside linked to containers.
   * 
   * The result includes any ves created in the current arrange pass (if one is underway) in addition to
   * any from the last completed one.
   */
  find: (veid: Veid): Array<VisualElementSignal> => {
    return currentSceneQueries.find(veid);
  },

  /**
   * Find the single cached visual element with the specified veid. If other than one (none, or more than one)
   * corresponding ves exists, throw an exception.
   * 
   * The search includes any ves created in the current arrange pass (if one is underway) in addition to
   * any from the last completed one.
   */
  findSingle: (veid: Veid): VisualElementSignal => {
    return currentSceneQueries.findSingle(veid);
  },

  removeByPath: (path: VisualElementPath): void => {
    const ve = getSceneNode(currentScene, path); // TODO (LOW): displayItem.id can be determined from the path.
    if (ve && isContainer(ve.get().displayItem) && asContainerItem(ve.get().displayItem).childrenLoaded) {
      removeSceneWatchContainerUid(currentSceneOutputs, ve.get().displayItem.id, ve.get().displayItem.origin);
    }
    if (ve) {
      deindexVisualElement(currentScene, path, ve);
    }
    if (!deleteSceneNode(currentScene, path)) { panic(`item ${path} is not in ves cache.`); }
    deleteAuxData(currentScene.aux, path);
    clearReactiveStateForPath(path);

    deleteFromVessVsDisplayIdLookup(currentScene, path);
  },

  debugLog: (): void => {
    console.debug("--- start ves cache entry list");
    for (let v of currentScene.cache) { console.debug(v[0]); }
    console.debug("--- end ves cache entry list");
  },

  pushTopTitledPage: (vePath: VisualElementPath) => {
    pushTopTitledPage(underConstructionSceneOutputs, vePath);
  },

  clearPopupVes: (path: VisualElementPath) => {
    currentScene.aux.popupVes.set(path, null);
    updateReactivePopup(path, null);
  },

  getDisplayItemFingerprint: (path: VisualElementPath): string | undefined => {
    if (currentlyInFullArrange && underConstructionScene.aux.displayItemFingerprint.has(path)) {
      return getSceneDisplayItemFingerprint(underConstructionScene, path);
    }
    return getSceneDisplayItemFingerprint(currentScene, path);
  },

  getAttachmentsVes: (path: VisualElementPath): Accessor<Array<VisualElementSignal>> => {
    return getReactiveAttachmentsSignal(path)[0];
  },

  getPopupVes: (path: VisualElementPath): Accessor<VisualElementSignal | null> => {
    // Return the reactive accessor
    return getReactivePopupSignal(path)[0];
  },

  getSelectedVes: (path: VisualElementPath): Accessor<VisualElementSignal | null> => {
    return getReactiveSelectedSignal(path)[0];
  },

  getDockVes: (path: VisualElementPath): Accessor<VisualElementSignal | null> => {
    return getReactiveDockSignal(path)[0];
  },

  getChildrenVes: (path: VisualElementPath): Accessor<Array<VisualElementSignal>> => {
    return getReactiveChildrenSignal(path)[0];
  },

  getLineChildrenVes: (path: VisualElementPath): Accessor<Array<VisualElementSignal>> => {
    return getReactiveLineChildrenSignal(path)[0];
  },

  getDesktopChildrenVes: (path: VisualElementPath): Accessor<Array<VisualElementSignal>> => {
    return getReactiveDesktopChildrenSignal(path)[0];
  },

  getNonMovingChildrenVes: (path: VisualElementPath): Accessor<Array<VisualElementSignal>> => {
    return getReactiveNonMovingChildrenSignal(path)[0];
  },

  getFocusedChild: (path: VisualElementPath): Accessor<Item | null> => {
    return getReactiveFocusedSignal(path)[0];
  },

  getTableVesRows: (path: VisualElementPath): Array<number> | null => {
    if (currentlyInFullArrange && underConstructionScene.aux.tableVesRows.has(path)) {
      return getSceneTableRows(underConstructionScene, path);
    }
    return staticTableVesRows.get(path) ?? getSceneTableRows(currentScene, path);
  },
}


function createOrRecycleVisualElementSignalImpl(spec: VisualElementSpec, relationships: VisualElementRelationships, path: VisualElementPath): VisualElementSignal {
  const visualElementOverride = { ...spec, ...relationships };

  const debug = false; // VeFns.veidFromPath(path).itemId == "<id of item of interest here>";

  if (spec.displayItemFingerprint) { panic("displayItemFingerprint is already set."); }
  spec.displayItemFingerprint = ItemFns.getFingerprint(spec.displayItem); // TODO (LOW): Modifying the input object is a bit dirty.
  visualElementOverride.displayItemFingerprint = spec.displayItemFingerprint;

  if (isContainer(spec.displayItem) &&
    (spec.flags! & VisualElementFlags.ShowChildren) &&
    asContainerItem(spec.displayItem).childrenLoaded) {
    addSceneWatchContainerUid(underConstructionSceneOutputs, visualElementOverride.displayItem.id, spec.displayItem.origin);
  }

  function compareArrays(oldArray: Array<VisualElementSignal>, newArray: Array<VisualElementSignal>): number {
    if (oldArray.length != newArray.length) { return 1; }
    for (let i = 0; i < oldArray.length; ++i) {
      if (oldArray[i] != newArray[i]) { return 1; }
    }
    return 0;
  }

  function addVesVsDisplayItem(displayItemId: Uid, path: VisualElementPath) {
    addScenePathForDisplayId(underConstructionScene, displayItemId, path);
  }

  function addUnderConstructionIndexes(path: VisualElementPath, ves: VisualElementSignal) {
    indexVisualElement(underConstructionScene, path, ves);
  }

  const existing = getSceneNode(currentScene, path);
  if (existing) {
    const existingVe = existing.get();
    if (existingVe.displayItemFingerprint != visualElementOverride.displayItemFingerprint) {
      existing.set(VeFns.create(visualElementOverride));
      if (debug) { console.debug("display item fingerprint changed", existingVe.displayItemFingerprint, visualElementOverride.displayItemFingerprint); }
      logDirtyReason("fingerprint");
      setSceneNode(underConstructionScene, path, existing);
      syncAuxData(underConstructionScene.aux, path, existing.get(), relationships);
      addVesVsDisplayItem(existing.get().displayItem.id, path);
      addUnderConstructionIndexes(path, existing);
      return existing;
    }

    // Check if the LineItem flag is changing. If it is, we should not recycle
    // the visual element because the rendering path will be completely different
    // (VisualElement_LineItem vs VisualElement_Desktop), so there's no DOM reuse
    // benefit. Creating a new visual element ensures a clean state transition.
    const oldHasLineItemFlag = !!(existingVe.flags & VisualElementFlags.LineItem);
    const newHasLineItemFlag = !!((visualElementOverride.flags || VisualElementFlags.None) & VisualElementFlags.LineItem);

    if (oldHasLineItemFlag !== newHasLineItemFlag) {
      if (debug) { console.debug("LineItem flag changed, creating new visual element instead of recycling:", path); }
      logDirtyReason("lineItemChange");
      arrangeStats.new++; // This creates a new signal rather than recycling
      const newElement = createVisualElementSignal(VeFns.create(visualElementOverride));
      setSceneNode(underConstructionScene, path, newElement);
      syncAuxData(underConstructionScene.aux, path, newElement.get(), relationships);
      addVesVsDisplayItem(newElement.get().displayItem.id, path);
      addUnderConstructionIndexes(path, newElement);
      return newElement;
    }

    const newVals: any = visualElementOverride;
    const oldVals: any = existingVe;
    const newProps = Object.getOwnPropertyNames(visualElementOverride);
    let dirty = false;
    if (debug) { console.debug(newProps, oldVals, visualElementOverride); }
    for (let i = 0; i < newProps.length; ++i) {
      if (debug) { console.debug("considering", newProps[i]); }
      if (newProps[i] == "childrenVes" ||
        newProps[i] == "attachmentsVes" ||
        newProps[i] == "tableVesRows" ||
        newProps[i] == "popupVes" ||
        newProps[i] == "selectedVes" ||
        newProps[i] == "dockVes" ||
        newProps[i] == "focusedChildItemMaybe") {
        continue;
      }

      if (typeof (oldVals[newProps[i]]) == 'undefined') {
        if (debug) { console.debug('no current ve property for:', newProps[i]); }
        dirty = true;
        break;
      }
      const oldVal = oldVals[newProps[i]];
      const newVal = newVals[newProps[i]];

      if (newProps[i] == "resizingFromBoundsPx" ||
        newProps[i] == "boundsPx" ||
        newProps[i] == "viewportBoundsPx" ||
        newProps[i] == "listViewportBoundsPx" ||
        newProps[i] == "childAreaBoundsPx" ||
        newProps[i] == "listChildAreaBoundsPx") {
        if (compareBoundingBox(oldVal, newVal) != 0) {
          if (debug) { console.debug("ve property changed: ", newProps[i]); }
          dirty = true;
          break;
        } else {
          if (debug) { console.debug("ve property didn't change: ", newProps[i]); }
        }
      } else if (newProps[i] == "tableDimensionsPx" ||
        newProps[i] == "blockSizePx" ||
        newProps[i] == "cellSizePx") {
        if (compareDimensions(oldVal, newVal) != 0) {
          if (debug) { console.debug("ve property changed: ", newProps[i]); }
          dirty = true;
          break;
        } else {
          if (debug) { console.debug("ve property didn't change: ", newProps[i]); }
        }
      } else if (newProps[i] == "hitboxes") {
        if (HitboxFns.ArrayCompare(oldVal, newVal) != 0) {
          if (debug) { console.debug("ve property changed: ", newProps[i]); }
          dirty = true;
          break;
        } else {
          if (debug) { console.debug("ve property didn't change: ", newProps[i]); }
        }
      } else if (newProps[i] == "linkItemMaybe") {
        // If this is an infumap-generated link, object ref might have changed, and it doesn't matter.
        // TODO (MEDIUM): rethink this through.
      } else if (newProps[i] == "displayItem" ||
        newProps[i] == "actualLinkItemMaybe" ||
        newProps[i] == "flags" ||
        newProps[i] == "_arrangeFlags_useForPartialRearrangeOnly" ||
        newProps[i] == "row" ||
        newProps[i] == "col" ||
        newProps[i] == "numRows" ||
        newProps[i] == "indentBl" ||
        newProps[i] == "parentPath" ||
        newProps[i] == "evaluatedTitle" ||
        newProps[i] == "displayItemFingerprint") {
        if (oldVal != newVal) {
          if (debug) { console.debug("ve property changed: ", newProps[i]); }
          dirty = true;
          break;
        } else {
          if (debug) { console.debug("ve property didn't change: ", newProps[i]); }
        }
      } else {
        if (debug) { console.debug("ve property changed: ", newProps[i], oldVal, newVal); }
        dirty = true;
        break;
      }
    }

    // properties that can become unset.
    // TODO (MEDIUM): something less of a hack here.
    if (!dirty) {
      if (debug) { console.debug("not dirty:", path); }
      arrangeStats.recycled++;
      setSceneNode(underConstructionScene, path, existing);
      syncAuxData(underConstructionScene.aux, path, existing.get(), relationships);
      addVesVsDisplayItem(existingVe.displayItem.id, path);
      addUnderConstructionIndexes(path, existing);
      return existing;
    }
    if (debug) { console.debug("dirty:", path); }
    arrangeStats.dirty++;

    // Recycle the existing visual element
    existing.set(VeFns.create(visualElementOverride));
    setSceneNode(underConstructionScene, path, existing);
    syncAuxData(underConstructionScene.aux, path, existing.get(), relationships);
    addVesVsDisplayItem(existing.get().displayItem.id, path);
    addUnderConstructionIndexes(path, existing);
    return existing;
  }

  if (debug) { console.debug("creating:", path); }
  arrangeStats.new++;
  const newElement = createVisualElementSignal(VeFns.create(visualElementOverride));
  setSceneNode(underConstructionScene, path, newElement);
  syncAuxData(underConstructionScene.aux, path, newElement.get(), relationships);
  addVesVsDisplayItem(newElement.get().displayItem.id, path);
  addUnderConstructionIndexes(path, newElement);
  return newElement;
}

function deleteFromVessVsDisplayIdLookup(scene: SceneState, path: string) {
  const displayItemId = VeFns.itemIdFromPath(path);
  let ves = scene.vessVsDisplayId.get(displayItemId);
  if (!ves) { panic(`displayItemId ${displayItemId} is not in the displayItemId -> vesPath cache.`); }
  let foundIdx = ves.findIndex((v) => { return v == path });
  if (foundIdx == -1) { panic(`path ${path} was not in the displayItemId -> vesPath cache.`); }
  ves.splice(foundIdx, 1);
  if (ves.length == 0) {
    if (!scene.vessVsDisplayId.delete(displayItemId)) { panic!("logic error deleting displayItemId."); }
  }
}
