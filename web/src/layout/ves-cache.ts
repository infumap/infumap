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

import { Item } from "../items/base/item";
type RenderProjectionEntry = {
  node: [Accessor<VisualElementSignal | undefined>, Setter<VisualElementSignal | undefined>];
  popup: [Accessor<VisualElementSignal | null>, Setter<VisualElementSignal | null>];
  selected: [Accessor<VisualElementSignal | null>, Setter<VisualElementSignal | null>];
  dock: [Accessor<VisualElementSignal | null>, Setter<VisualElementSignal | null>];
  focused: [Accessor<Item | null>, Setter<Item | null>];
  attachments: [Accessor<Array<VisualElementSignal>>, Setter<Array<VisualElementSignal>>];
  children: [Accessor<Array<VisualElementSignal>>, Setter<Array<VisualElementSignal>>];
  lineChildren: [Accessor<Array<VisualElementSignal>>, Setter<Array<VisualElementSignal>>];
  desktopChildren: [Accessor<Array<VisualElementSignal>>, Setter<Array<VisualElementSignal>>];
  nonMovingChildren: [Accessor<Array<VisualElementSignal>>, Setter<Array<VisualElementSignal>>];
  tableRows: Array<number> | null;
}

let renderProjectionByPath = new Map<VisualElementPath, RenderProjectionEntry>();

function createRenderProjectionEntry(): RenderProjectionEntry {
  return {
    node: createSignal<VisualElementSignal | undefined>(undefined),
    popup: createSignal<VisualElementSignal | null>(null),
    selected: createSignal<VisualElementSignal | null>(null),
    dock: createSignal<VisualElementSignal | null>(null),
    focused: createSignal<Item | null>(null),
    attachments: createSignal<Array<VisualElementSignal>>([]),
    children: createSignal<Array<VisualElementSignal>>([]),
    lineChildren: createSignal<Array<VisualElementSignal>>([]),
    desktopChildren: createSignal<Array<VisualElementSignal>>([]),
    nonMovingChildren: createSignal<Array<VisualElementSignal>>([]),
    tableRows: null,
  };
}

function getRenderProjection(path: VisualElementPath): RenderProjectionEntry {
  let entry = renderProjectionByPath.get(path);
  if (!entry) {
    entry = createRenderProjectionEntry();
    renderProjectionByPath.set(path, entry);
  }
  return entry;
}

function updateRenderProjectionSignal<T>(signal: [Accessor<T>, Setter<T>], value: T, shouldUpdate?: (current: T, next: T) => boolean) {
  const [read, write] = signal;
  const current = read();
  if (shouldUpdate ? shouldUpdate(current, value) : current !== value) {
    write(value);
  }
}

function shouldUpdateSignalList(current: Array<VisualElementSignal>, next: Array<VisualElementSignal>): boolean {
  if (current.length !== next.length) {
    return true;
  }
  for (let i = 0; i < current.length; i++) {
    if (current[i] !== next[i]) {
      return true;
    }
  }
  return false;
}

function updateRenderProjectionPopup(path: VisualElementPath, value: VisualElementSignal | null) {
  updateRenderProjectionSignal(getRenderProjection(path).popup, value);
}

function updateRenderProjectionNode(path: VisualElementPath, value: VisualElementSignal | undefined) {
  updateRenderProjectionSignal(getRenderProjection(path).node, value);
}

function updateRenderProjectionSelected(path: VisualElementPath, value: VisualElementSignal | null) {
  updateRenderProjectionSignal(getRenderProjection(path).selected, value);
}

function updateRenderProjectionDock(path: VisualElementPath, value: VisualElementSignal | null) {
  updateRenderProjectionSignal(getRenderProjection(path).dock, value);
}

function updateRenderProjectionFocused(path: VisualElementPath, value: Item | null) {
  updateRenderProjectionSignal(getRenderProjection(path).focused, value, (current, next) => {
    if (current?.id !== next?.id) {
      return true;
    }
    return current !== next;
  });
}

function updateRenderProjectionAttachments(path: VisualElementPath, value: Array<VisualElementSignal> | undefined) {
  const actualValue = value ?? [];
  updateRenderProjectionSignal(getRenderProjection(path).attachments, actualValue, shouldUpdateSignalList);
}

function updateRenderProjectionChildren(path: VisualElementPath, value: Array<VisualElementSignal> | undefined) {
  const actualValue = value ?? [];
  updateRenderProjectionSignal(getRenderProjection(path).children, actualValue, shouldUpdateSignalList);
}

function updateRenderProjectionLineChildren(path: VisualElementPath, value: Array<VisualElementSignal> | undefined) {
  const actualValue = value ?? [];
  updateRenderProjectionSignal(getRenderProjection(path).lineChildren, actualValue, shouldUpdateSignalList);
}

function updateRenderProjectionDesktopChildren(path: VisualElementPath, value: Array<VisualElementSignal> | undefined) {
  const actualValue = value ?? [];
  updateRenderProjectionSignal(getRenderProjection(path).desktopChildren, actualValue, shouldUpdateSignalList);
}

function updateRenderProjectionNonMovingChildren(path: VisualElementPath, value: Array<VisualElementSignal> | undefined) {
  const actualValue = value ?? [];
  updateRenderProjectionSignal(getRenderProjection(path).nonMovingChildren, actualValue, shouldUpdateSignalList);
}

function setRenderProjectionTableRows(path: VisualElementPath, rows: Array<number> | null) {
  getRenderProjection(path).tableRows = rows ? rows.slice() : null;
}

function setUnderConstructionRenderTableRows(path: VisualElementPath, rows: Array<number> | null | undefined) {
  if (rows == null) {
    underConstructionRenderTableRowsByPath.delete(path);
    return;
  }
  underConstructionRenderTableRowsByPath.set(path, rows.slice());
}

function prepareVisualElementSpec(spec: VisualElementSpec): VisualElementSpec {
  if (spec.displayItemFingerprint) {
    panic("displayItemFingerprint is already set.");
  }
  return {
    ...spec,
    displayItemFingerprint: ItemFns.getFingerprint(spec.displayItem),
  };
}

function maybeTrackLoadedContainer(outputs: SceneOutputs, spec: VisualElementSpec) {
  if (isContainer(spec.displayItem) &&
    ((spec.flags ?? VisualElementFlags.None) & VisualElementFlags.ShowChildren) &&
    asContainerItem(spec.displayItem).childrenLoaded) {
    addSceneWatchContainerUid(outputs, spec.displayItem.id, spec.displayItem.origin);
  }
}

let currentlyInFullArrange = false;

type SceneRelationshipData = {
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

type SceneRelationshipsByPath = Map<VisualElementPath, SceneRelationshipData>;

type SceneState = {
  cache: Map<VisualElementPath, VisualElement>;
  vessVsDisplayId: Map<Uid, Array<VisualElementPath>>;
  childrenByParent: Map<VisualElementPath, Array<VisualElementPath>>;
  vessByVeid: Map<string, Array<VisualElementPath>>;
  relationshipsByPath: SceneRelationshipsByPath;
}

type VirtualSceneState = {
  cache: Map<VisualElementPath, VisualElement>;
  vessVsDisplayId: Map<Uid, Array<VisualElementPath>>;
  childrenByParent: Map<VisualElementPath, Array<VisualElementPath>>;
  vessByVeid: Map<string, Array<VisualElementPath>>;
  relationshipsByPath: SceneRelationshipsByPath;
}

function createEmptySceneState(): SceneState {
  return {
    cache: new Map<VisualElementPath, VisualElement>(),
    vessVsDisplayId: new Map<Uid, Array<VisualElementPath>>(),
    childrenByParent: new Map<VisualElementPath, Array<VisualElementPath>>(),
    vessByVeid: new Map<string, Array<VisualElementPath>>(),
    relationshipsByPath: new Map(),
  };
}

function createEmptyVirtualSceneState(): VirtualSceneState {
  return {
    cache: new Map<VisualElementPath, VisualElement>(),
    vessVsDisplayId: new Map<Uid, Array<VisualElementPath>>(),
    childrenByParent: new Map<VisualElementPath, Array<VisualElementPath>>(),
    vessByVeid: new Map<string, Array<VisualElementPath>>(),
    relationshipsByPath: new Map(),
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
let underConstructionArrangeSignalsByPath = new Map<VisualElementPath, VisualElementSignal>();
let underConstructionRenderTableRowsByPath = new Map<VisualElementPath, Array<number>>();
let currentSceneOutputs = createEmptySceneOutputs();
let underConstructionSceneOutputs = createEmptySceneOutputs();

function getSceneNode(scene: SceneState, path: VisualElementPath): VisualElement | undefined {
  return scene.cache.get(path);
}

function setSceneNode(scene: SceneState, path: VisualElementPath, ve: VisualElement) {
  scene.cache.set(path, ve);
}

function deleteSceneNode(scene: SceneState, path: VisualElementPath): boolean {
  return scene.cache.delete(path);
}

function sceneHasNode(scene: SceneState, path: VisualElementPath): boolean {
  return scene.cache.has(path);
}

function getSceneParentPath(scene: SceneState, path: VisualElementPath): VisualElementPath | null {
  return getSceneNode(scene, path)?.parentPath ?? VeFns.parentPath(path) ?? null;
}

function getSceneIndexedChildren(scene: SceneState, parentPath: VisualElementPath): Array<VisualElementSignal> {
  return resolveSceneNodePaths(scene, scene.childrenByParent.get(parentPath));
}

function getSceneStructuralChildren(scene: SceneState, parentPath: VisualElementPath): Array<VisualElementSignal> {
  return resolveSceneNodePaths(scene, scene.relationshipsByPath.get(parentPath)?.children);
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

function getSceneVeidMatchPaths(scene: SceneState, veid: Veid): Array<VisualElementPath> {
  return (scene.vessByVeid.get(veidIndexKey(veid)) ?? []).slice();
}

function getSceneDisplayItemFingerprint(scene: SceneState, path: VisualElementPath): string | undefined {
  return getSceneNode(scene, path)?.displayItemFingerprint;
}

function getRenderNode(path: VisualElementPath): VisualElementSignal | undefined {
  return getRenderProjection(path).node[0]();
}

function ensureCurrentRenderNode(path: VisualElementPath): VisualElementSignal | null {
  const existing = getRenderNode(path);
  if (existing) {
    return existing;
  }
  const currentVe = getSceneNode(currentScene, path);
  if (!currentVe) {
    return null;
  }
  const signal = createVisualElementSignal(cloneVisualElementSnapshot(currentVe));
  updateRenderProjectionNode(path, signal);
  return signal;
}

function syncUnderConstructionArrangeSignal(path: VisualElementPath, ve: VisualElement) {
  const signal = underConstructionArrangeSignalsByPath.get(path);
  if (!signal) {
    return;
  }
  signal.set(cloneVisualElementSnapshot(ve));
}

function ensureUnderConstructionArrangeSignal(path: VisualElementPath): VisualElementSignal | null {
  const existing = underConstructionArrangeSignalsByPath.get(path);
  if (existing) {
    return existing;
  }
  const ve = getSceneNode(underConstructionScene, path);
  if (!ve) {
    return null;
  }
  const signal = createVisualElementSignal(cloneVisualElementSnapshot(ve));
  underConstructionArrangeSignalsByPath.set(path, signal);
  return signal;
}

function resolveSceneNodePath(scene: SceneState, path: VisualElementPath | null | undefined): VisualElementSignal | null {
  if (path == null) {
    return null;
  }
  if (scene === currentScene) {
    return ensureCurrentRenderNode(path);
  }
  if (scene === underConstructionScene) {
    return ensureUnderConstructionArrangeSignal(path);
  }
  return null;
}

function resolveSceneNodePaths(scene: SceneState, paths: Array<VisualElementPath> | undefined): Array<VisualElementSignal> {
  if (scene === currentScene) {
    const resolved: Array<VisualElementSignal> = [];
    for (const path of paths ?? []) {
      const node = ensureCurrentRenderNode(path);
      if (node) {
        resolved.push(node);
      }
    }
    return resolved;
  }
  if (scene === underConstructionScene) {
    const resolved: Array<VisualElementSignal> = [];
    for (const path of paths ?? []) {
      const node = ensureUnderConstructionArrangeSignal(path);
      if (node) {
        resolved.push(node);
      }
    }
    return resolved;
  }
  return [];
}

function readSceneNodePath(scene: SceneState, path: VisualElementPath | null | undefined): VisualElement | null {
  if (path == null) {
    return null;
  }
  return getSceneNode(scene, path) ?? null;
}

function readSceneNodePaths(scene: SceneState, paths: Array<VisualElementPath> | undefined): Array<VisualElement> {
  const resolved: Array<VisualElement> = [];
  for (const path of paths ?? []) {
    const node = getSceneNode(scene, path);
    if (node) {
      resolved.push(node);
    }
  }
  return resolved;
}

function readVirtualNodePaths(paths: Array<VisualElementPath> | undefined): Array<VisualElement> {
  const resolved: Array<VisualElement> = [];
  for (const path of paths ?? []) {
    const node = virtualScene.cache.get(path);
    if (node) {
      resolved.push(node);
    }
  }
  return resolved;
}

function readSceneNode(scene: SceneState, path: VisualElementPath): VisualElement | undefined {
  return getSceneNode(scene, path);
}

function readSceneIndexedChildren(scene: SceneState, parentPath: VisualElementPath): Array<VisualElement> {
  return readSceneNodePaths(scene, scene.childrenByParent.get(parentPath));
}

function readSceneStructuralChildren(scene: SceneState, parentPath: VisualElementPath): Array<VisualElement> {
  return readSceneNodePaths(scene, scene.relationshipsByPath.get(parentPath)?.children);
}

function readSceneSiblings(scene: SceneState, path: VisualElementPath): Array<VisualElement> {
  const parentPath = getSceneParentPath(scene, path);
  if (parentPath == null) {
    return [];
  }
  return readSceneNodePaths(scene, scene.childrenByParent.get(parentPath))
    .filter(ve => VeFns.veToPath(ve) != path);
}

function readSceneAttachments(scene: SceneState, path: VisualElementPath): Array<VisualElement> {
  return readSceneNodePaths(scene, scene.relationshipsByPath.get(path)?.attachments);
}

function readScenePopup(scene: SceneState, path: VisualElementPath): VisualElement | null {
  return readSceneNodePath(scene, scene.relationshipsByPath.get(path)?.popup);
}

function readSceneSelected(scene: SceneState, path: VisualElementPath): VisualElement | null {
  return readSceneNodePath(scene, scene.relationshipsByPath.get(path)?.selected);
}

function readSceneDock(scene: SceneState, path: VisualElementPath): VisualElement | null {
  return readSceneNodePath(scene, scene.relationshipsByPath.get(path)?.dock);
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

  for (const [path, ve] of scene.cache) {
    snapshot.cache.set(path, cloneVisualElementSnapshot(ve));
  }

  for (const [displayId, paths] of scene.vessVsDisplayId) {
    snapshot.vessVsDisplayId.set(displayId, paths.slice());
  }

  for (const [parentPath, children] of scene.childrenByParent) {
    snapshot.childrenByParent.set(parentPath, children.slice());
  }

  for (const [veidKey, matches] of scene.vessByVeid) {
    snapshot.vessByVeid.set(veidKey, matches.slice());
  }

  for (const [path, relationships] of scene.relationshipsByPath) {
    snapshot.relationshipsByPath.set(path, {
      attachments: relationships.attachments.slice(),
      popup: relationships.popup,
      selected: relationships.selected,
      dock: relationships.dock,
      children: relationships.children.slice(),
      lineChildren: relationships.lineChildren.slice(),
      desktopChildren: relationships.desktopChildren.slice(),
      nonMovingChildren: relationships.nonMovingChildren.slice(),
      focusedChildItemMaybe: relationships.focusedChildItemMaybe,
    });
  }

  return snapshot;
}

function readVirtualSceneNode(path: VisualElementPath): VisualElement | undefined {
  return virtualScene.cache.get(path);
}

function readVirtualSceneIndexedChildren(parentPath: VisualElementPath): Array<VisualElement> {
  return readVirtualNodePaths(virtualScene.childrenByParent.get(parentPath));
}

function readVirtualSceneStructuralChildren(parentPath: VisualElementPath): Array<VisualElement> {
  return readVirtualNodePaths(virtualScene.relationshipsByPath.get(parentPath)?.children);
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
  return readVirtualNodePaths(virtualScene.vessByVeid.get(veidIndexKey(veid)));
}

function findCurrentSceneMatches(veid: Veid): Array<VisualElementSignal> {
  const result: Array<VisualElementSignal> = [];
  const seenPaths = new Set<VisualElementPath>();
  for (const path of getSceneVeidMatchPaths(underConstructionScene, veid)) {
    const ves = resolveSceneNodePath(underConstructionScene, path);
    if (ves && !seenPaths.has(path)) {
      seenPaths.add(path);
      result.push(ves);
    }
  }
  for (const path of getSceneVeidMatchPaths(currentScene, veid)) {
    const ves = resolveSceneNodePath(currentScene, path);
    if (ves && !seenPaths.has(path)) {
      seenPaths.add(path);
      result.push(ves);
    }
  }
  return result;
}

function findSingleCurrentSceneMatch(veid: Veid): VisualElementSignal {
  const underConstructionMatches = getSceneVeidMatchPaths(underConstructionScene, veid);
  if (underConstructionMatches.length > 1) {
    throw new Error(`multiple visual elements found: ${veid.itemId}/${veid.linkIdMaybe}.`);
  }
  if (underConstructionMatches.length == 1) {
    return resolveSceneNodePath(underConstructionScene, underConstructionMatches[0]) ?? panic(`${veid.itemId}/${veid.linkIdMaybe} missing under-construction arrange signal.`);
  }
  const currentMatches = getSceneVeidMatchPaths(currentScene, veid);
  if (currentMatches.length > 1) {
    throw new Error(`multiple visual elements found: ${veid.itemId}/${veid.linkIdMaybe}.`);
  }
  if (currentMatches.length == 0) {
    throw new Error(`${veid.itemId}/${veid.linkIdMaybe} not present in VesCache.`);
  }
  return resolveSceneNodePath(currentScene, currentMatches[0]) ?? panic(`${veid.itemId}/${veid.linkIdMaybe} missing render node signal.`);
}

function writeScenePath(
  scene: SceneState,
  path: VisualElementPath,
  ve: VisualElement,
  relationshipData: SceneRelationshipData,
) {
  setSceneNode(scene, path, ve);
  writeSceneRelationshipData(scene.relationshipsByPath, path, relationshipData);
  indexVisualElement(scene, path, ve);
  addScenePathForDisplayId(scene, ve.displayItem.id, path);
}

function writeUnderConstructionScenePath(
  path: VisualElementPath,
  ve: VisualElement,
  relationshipData: SceneRelationshipData,
): VisualElementSignal {
  writeScenePath(underConstructionScene, path, ve, relationshipData);
  syncUnderConstructionArrangeSignal(path, ve);
  return ensureUnderConstructionArrangeSignal(path) ?? panic(`failed to materialize under-construction arrange signal for ${path}.`);
}

function syncRenderProjectionNode(
  path: VisualElementPath,
  nextVe: VisualElement | undefined,
  previousVe?: VisualElement,
  preferredSignal?: VisualElementSignal,
) {
  if (!nextVe) {
    updateRenderProjectionNode(path, undefined);
    return;
  }

  let signal = preferredSignal ?? getRenderNode(path);
  if (!signal) {
    signal = createVisualElementSignal(cloneVisualElementSnapshot(nextVe));
    updateRenderProjectionNode(path, signal);
    return;
  }

  if (!preferredSignal && previousVe === nextVe) {
    updateRenderProjectionNode(path, signal);
    return;
  }

  signal.set(cloneVisualElementSnapshot(nextVe));
  updateRenderProjectionNode(path, signal);
}

function syncRenderProjectionForPath(
  scene: SceneState,
  path: VisualElementPath,
  previousVe?: VisualElement,
  preferredSignal?: VisualElementSignal,
  renderTableRows?: Array<number> | null,
) {
  syncRenderProjectionNode(path, getSceneNode(scene, path), previousVe, preferredSignal);
  const relationships = scene.relationshipsByPath.get(path);
  updateRenderProjectionPopup(path, resolveSceneNodePath(scene, relationships?.popup));
  updateRenderProjectionSelected(path, resolveSceneNodePath(scene, relationships?.selected));
  updateRenderProjectionDock(path, resolveSceneNodePath(scene, relationships?.dock));
  updateRenderProjectionAttachments(path, resolveSceneNodePaths(scene, relationships?.attachments));
  updateRenderProjectionChildren(path, resolveSceneNodePaths(scene, relationships?.children));
  updateRenderProjectionLineChildren(path, resolveSceneNodePaths(scene, relationships?.lineChildren));
  updateRenderProjectionDesktopChildren(path, resolveSceneNodePaths(scene, relationships?.desktopChildren));
  updateRenderProjectionNonMovingChildren(path, resolveSceneNodePaths(scene, relationships?.nonMovingChildren));
  updateRenderProjectionFocused(path, relationships?.focusedChildItemMaybe ?? null);
  setRenderProjectionTableRows(path, renderTableRows ?? null);
}

function clearRenderProjectionForPath(path: VisualElementPath) {
  updateRenderProjectionNode(path, undefined);
  updateRenderProjectionPopup(path, null);
  updateRenderProjectionSelected(path, null);
  updateRenderProjectionDock(path, null);
  updateRenderProjectionAttachments(path, []);
  updateRenderProjectionChildren(path, []);
  updateRenderProjectionLineChildren(path, []);
  updateRenderProjectionDesktopChildren(path, []);
  updateRenderProjectionNonMovingChildren(path, []);
  updateRenderProjectionFocused(path, null);
  setRenderProjectionTableRows(path, null);
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

function addToIndex<K>(index: Map<K, Array<VisualElementPath>>, key: K, path: VisualElementPath) {
  const existing = index.get(key);
  if (!existing) {
    index.set(key, [path]);
    return;
  }
  existing.push(path);
}

function removeFromIndex<K>(index: Map<K, Array<VisualElementPath>>, key: K | null | undefined, path: VisualElementPath) {
  if (key == null) {
    return;
  }
  const existing = index.get(key);
  if (!existing) {
    panic(`missing index entry for '${String(key)}'.`);
  }
  const existingIndex = existing.findIndex(v => v === path);
  if (existingIndex === -1) {
    panic(`path missing from index entry for '${String(key)}'.`);
  }
  existing.splice(existingIndex, 1);
  if (existing.length === 0) {
    index.delete(key);
  }
}

function indexVisualElement(
  scene: SceneState,
  path: VisualElementPath,
  ve: VisualElement,
) {
  const parentPath = ve.parentPath;
  if (parentPath != null) {
    addToIndex(scene.childrenByParent, parentPath, path);
  }
  addToIndex(scene.vessByVeid, veidIndexKeyFromPath(path), path);
}

function deindexVisualElement(
  scene: SceneState,
  path: VisualElementPath,
  ve: VisualElement,
) {
  removeFromIndex(scene.childrenByParent, ve.parentPath, path);
  removeFromIndex(scene.vessByVeid, veidIndexKeyFromPath(path), path);
}

function toSceneRelationshipPath(node: VisualElementSignal | null | undefined): VisualElementPath | null {
  return node ? VeFns.veToPath(node.get()) : null;
}

function toSceneRelationshipPaths(nodes: Array<VisualElementSignal> | undefined): Array<VisualElementPath> {
  return (nodes ?? []).map(node => VeFns.veToPath(node.get()));
}

function splitChildPathsByRenderBehavior(scene: SceneState, childPaths: Array<VisualElementPath> | undefined) {
  const allChildren = childPaths ?? [];
  const allChildPaths: Array<VisualElementPath> = [];
  const lineChildren: Array<VisualElementPath> = [];
  const desktopChildren: Array<VisualElementPath> = [];
  const nonMovingChildren: Array<VisualElementPath> = [];

  for (const childPath of allChildren) {
    const flags = getSceneNode(scene, childPath)?.flags ?? VisualElementFlags.None;
    allChildPaths.push(childPath);
    if (flags & VisualElementFlags.LineItem) {
      lineChildren.push(childPath);
    } else {
      desktopChildren.push(childPath);
    }
    if (!(flags & VisualElementFlags.Moving)) {
      nonMovingChildren.push(childPath);
    }
  }

  return {
    allChildren: allChildPaths,
    lineChildren,
    desktopChildren,
    nonMovingChildren,
  };
}

function prepareSceneRelationshipData(scene: SceneState, relationships: VisualElementRelationships | null): SceneRelationshipData {
  const childPaths = relationships?.childrenPaths ?? toSceneRelationshipPaths(relationships?.childrenVes);
  const childBuckets = splitChildPathsByRenderBehavior(scene, childPaths);
  return {
    attachments: relationships?.attachmentsPaths ?? toSceneRelationshipPaths(relationships?.attachmentsVes),
    popup: typeof relationships?.popupPath !== "undefined" ? relationships.popupPath : toSceneRelationshipPath(relationships?.popupVes),
    selected: typeof relationships?.selectedPath !== "undefined" ? relationships.selectedPath : toSceneRelationshipPath(relationships?.selectedVes),
    dock: typeof relationships?.dockPath !== "undefined" ? relationships.dockPath : toSceneRelationshipPath(relationships?.dockVes),
    children: childBuckets.allChildren,
    lineChildren: childBuckets.lineChildren,
    desktopChildren: childBuckets.desktopChildren,
    nonMovingChildren: childBuckets.nonMovingChildren,
    focusedChildItemMaybe: relationships?.focusedChildItemMaybe ?? null,
  };
}

function writeSceneRelationshipData(
  relationshipsByPath: SceneRelationshipsByPath,
  path: VisualElementPath,
  relationshipData: SceneRelationshipData,
) {
  relationshipsByPath.set(path, relationshipData);
}

function deleteSceneRelationships(relationshipsByPath: SceneRelationshipsByPath, path: VisualElementPath) {
  relationshipsByPath.delete(path);
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

function logOrphanedVes(cache: Map<VisualElementPath, VisualElement>, context: string) {
  // Diagnostic helper: reports any visual elements whose parentPath is missing from the cache.
  const orphans: Array<{ path: VisualElementPath, parentPath: VisualElementPath, itemId: string, flags: number }> = [];
  for (const [path, ve] of cache.entries()) {
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

function syncRenderProjectionFromScene(
  previousScene: SceneState,
  scene: SceneState,
  renderTableRowsByPath?: Map<VisualElementPath, Array<number>>,
) {
  for (const [path] of renderProjectionByPath) {
    if (!sceneHasNode(scene, path)) {
      clearRenderProjectionForPath(path);
    }
  }
  for (const [path] of scene.cache) {
    syncRenderProjectionForPath(
      scene,
      path,
      previousScene?.cache.get(path),
      undefined,
      renderTableRowsByPath?.get(path) ?? null,
    );
  }
}

function promoteVirtualScene(scene: SceneState) {
  virtualScene = snapshotVirtualScene(scene);
}

function promoteCurrentScene(
  store: StoreContextModel,
  scene: SceneState,
  outputs: SceneOutputs,
  renderTableRowsByPath?: Map<VisualElementPath, Array<number>>,
) {
  const previousScene = currentScene;
  currentScene = scene;
  currentSceneOutputs = outputs;
  store.topTitledPages.set(outputs.topTitledPages);
  logOrphanedVes(scene.cache, "full_finalizeArrange");
  logArrangeStats();
  syncRenderProjectionFromScene(previousScene, scene, renderTableRowsByPath);
}

const currentSceneQueries = {
  getNode: (path: VisualElementPath): VisualElementSignal | undefined => {
    return ensureCurrentRenderNode(path) ?? undefined;
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

  readAttachments: (path: VisualElementPath): Array<VisualElement> => {
    return readSceneAttachments(currentScene, path);
  },

  readPopup: (path: VisualElementPath): VisualElement | null => {
    return readScenePopup(currentScene, path);
  },

  readSelected: (path: VisualElementPath): VisualElement | null => {
    return readSceneSelected(currentScene, path);
  },

  readDock: (path: VisualElementPath): VisualElement | null => {
    return readSceneDock(currentScene, path);
  },

  find: (veid: Veid): Array<VisualElementSignal> => {
    return findCurrentSceneMatches(veid);
  },

  findNodes: (veid: Veid): Array<VisualElement> => {
    return readSceneNodePaths(currentScene, currentScene.vessByVeid.get(veidIndexKey(veid)));
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

const renderSceneQueries = {
  getNode: (path: VisualElementPath): VisualElementSignal | undefined => {
    return getRenderProjection(path).node[0]();
  },

  find: (veid: Veid): Array<VisualElementSignal> => {
    return findCurrentSceneMatches(veid);
  },

  findSingle: (veid: Veid): VisualElementSignal => {
    return findSingleCurrentSceneMatch(veid);
  },

  getAttachments: (path: VisualElementPath): Accessor<Array<VisualElementSignal>> => {
    return getRenderProjection(path).attachments[0];
  },

  getPopup: (path: VisualElementPath): Accessor<VisualElementSignal | null> => {
    return getRenderProjection(path).popup[0];
  },

  getSelected: (path: VisualElementPath): Accessor<VisualElementSignal | null> => {
    return getRenderProjection(path).selected[0];
  },

  getDock: (path: VisualElementPath): Accessor<VisualElementSignal | null> => {
    return getRenderProjection(path).dock[0];
  },

  getChildren: (path: VisualElementPath): Accessor<Array<VisualElementSignal>> => {
    return getRenderProjection(path).children[0];
  },

  getLineChildren: (path: VisualElementPath): Accessor<Array<VisualElementSignal>> => {
    return getRenderProjection(path).lineChildren[0];
  },

  getDesktopChildren: (path: VisualElementPath): Accessor<Array<VisualElementSignal>> => {
    return getRenderProjection(path).desktopChildren[0];
  },

  getNonMovingChildren: (path: VisualElementPath): Accessor<Array<VisualElementSignal>> => {
    return getRenderProjection(path).nonMovingChildren[0];
  },

  getFocusedChild: (path: VisualElementPath): Accessor<Item | null> => {
    return getRenderProjection(path).focused[0];
  },
};

export let VesCache = {

  current: currentSceneQueries,

  virtual: virtualSceneQueries,

  render: renderSceneQueries,

  /**
   * Re-initialize - clears all cached data.
   */
  clear: (): void => {
    currentScene = createEmptySceneState();
    currentSceneOutputs = createEmptySceneOutputs();
    renderProjectionByPath = new Map<VisualElementPath, RenderProjectionEntry>();
    virtualScene = createEmptyVirtualSceneState();
    underConstructionScene = createEmptySceneState();
    underConstructionArrangeSignalsByPath = new Map<VisualElementPath, VisualElementSignal>();
    underConstructionRenderTableRowsByPath = new Map<VisualElementPath, Array<number>>();
    underConstructionSceneOutputs = createEmptySceneOutputs();

  },

  // Legacy top-level accessors. Prefer `VesCache.render.*` in component code and
  // `VesCache.current.*` / `VesCache.virtual.*` in non-render logic.
  get: (path: VisualElementPath): VisualElementSignal | undefined => {
    return renderSceneQueries.getNode(path);
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
    underConstructionArrangeSignalsByPath = new Map<VisualElementPath, VisualElementSignal>();
    underConstructionRenderTableRowsByPath = new Map<VisualElementPath, Array<number>>();
  },

  full_finalizeArrange: (store: StoreContextModel, umbrellaSpec: VisualElementSpec, umbrellaRelationships: VisualElementRelationships, umbrellaPath: VisualElementPath, virtualUmbrellaVes?: VisualElementSignal): void => {
    const preparedUmbrellaSpec = prepareVisualElementSpec(umbrellaSpec);
    const preparedUmbrellaRelationships = prepareSceneRelationshipData(underConstructionScene, umbrellaRelationships);
    const umbrellaVe = virtualUmbrellaVes ? cloneVisualElementSnapshot(virtualUmbrellaVes.get()) : VeFns.create(preparedUmbrellaSpec);

    if (virtualUmbrellaVes) {
      writeScenePath(underConstructionScene, umbrellaPath, umbrellaVe, preparedUmbrellaRelationships);
      promoteVirtualScene(underConstructionScene);
    } else {
      writeScenePath(underConstructionScene, umbrellaPath, umbrellaVe, preparedUmbrellaRelationships);
      store.umbrellaVisualElement.set(umbrellaVe);
      promoteCurrentScene(store, underConstructionScene, underConstructionSceneOutputs, underConstructionRenderTableRowsByPath);
    }

    underConstructionScene = createEmptySceneState();
    underConstructionArrangeSignalsByPath = new Map<VisualElementPath, VisualElementSignal>();
    underConstructionRenderTableRowsByPath = new Map<VisualElementPath, Array<number>>();
    underConstructionSceneOutputs = createEmptySceneOutputs();

    currentlyInFullArrange = false;
  },

  isCurrentlyInFullArrange: (): boolean => {
    return currentlyInFullArrange;
  },

  /**
   * Builds the next under-construction scene node for the specified path and returns
   * a temporary arrange-time signal view over that node. The signal is only an arrange
   * convenience; the canonical data is written into the under-construction scene first.
   */
  full_createOrRecycleVisualElementSignal: (spec: VisualElementSpec, relationships: VisualElementRelationships, path: VisualElementPath): VisualElementSignal => {
    return buildUnderConstructionVisualElementSignal(spec, relationships, path);
  },

  /**
   * Create a new VisualElementSignal and insert it into the current cache.
   */
  partial_create: (spec: VisualElementSpec, relationships: VisualElementRelationships, path: VisualElementPath): VisualElementSignal => {
    const preparedSpec = prepareVisualElementSpec(spec);
    const preparedRelationships = prepareSceneRelationshipData(currentScene, relationships);
    const newElement = VeFns.create(preparedSpec);
    writeScenePath(currentScene, path, newElement, preparedRelationships);
    syncRenderProjectionForPath(currentScene, path, undefined, undefined, relationships.tableVesRows ?? null);

    maybeTrackLoadedContainer(currentSceneOutputs, preparedSpec);

    return renderSceneQueries.getNode(path) ?? panic("partial_create failed to create render node signal.");
  },

  /**
   * Overwrites the provided ves with the provided override (which is generally expected to be for a new path).
   * Deletes any attachments of the existing ves.
   *
   * TODO (HIGH): should also delete children..., though this is never used
   */
  partial_overwriteVisualElementSignal: (spec: VisualElementSpec, relationships: VisualElementRelationships, newPath: VisualElementPath, vesToOverwrite: VisualElementSignal) => {
    const preparedSpec = prepareVisualElementSpec(spec);
    const preparedRelationships = prepareSceneRelationshipData(currentScene, relationships);
    const veToOverwrite = vesToOverwrite.get();
    const existingPath = VeFns.veToPath(veToOverwrite);
    const nextVe = VeFns.create(preparedSpec);

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
        newDisplayItemId: preparedSpec.displayItem.id,
        existingItemType: veToOverwrite.displayItem.itemType,
        newItemType: preparedSpec.displayItem.itemType,
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
    deindexVisualElement(currentScene, existingPath, veToOverwrite);
    deleteSceneRelationships(currentScene.relationshipsByPath, existingPath);
    if (existingPath != newPath) {
      clearRenderProjectionForPath(existingPath);
    }
    vesToOverwrite.set(cloneVisualElementSnapshot(nextVe));
    writeScenePath(currentScene, newPath, nextVe, preparedRelationships);
    syncRenderProjectionForPath(currentScene, newPath, undefined, vesToOverwrite, relationships.tableVesRows ?? null);

    maybeTrackLoadedContainer(currentSceneOutputs, preparedSpec);
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
    return renderSceneQueries.find(veid);
  },

  /**
   * Find the single cached visual element with the specified veid. If other than one (none, or more than one)
   * corresponding ves exists, throw an exception.
   * 
   * The search includes any ves created in the current arrange pass (if one is underway) in addition to
   * any from the last completed one.
   */
  findSingle: (veid: Veid): VisualElementSignal => {
    return renderSceneQueries.findSingle(veid);
  },

  removeByPath: (path: VisualElementPath): void => {
    const ve = getSceneNode(currentScene, path); // TODO (LOW): displayItem.id can be determined from the path.
    if (ve && isContainer(ve.displayItem) && asContainerItem(ve.displayItem).childrenLoaded) {
      removeSceneWatchContainerUid(currentSceneOutputs, ve.displayItem.id, ve.displayItem.origin);
    }
    if (ve) {
      deindexVisualElement(currentScene, path, ve);
    }
    if (!deleteSceneNode(currentScene, path)) { panic(`item ${path} is not in ves cache.`); }
    deleteSceneRelationships(currentScene.relationshipsByPath, path);
    clearRenderProjectionForPath(path);

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
    const relationships = currentScene.relationshipsByPath.get(path);
    if (relationships) {
      relationships.popup = null;
    }
    updateRenderProjectionPopup(path, null);
  },

  getDisplayItemFingerprint: (path: VisualElementPath): string | undefined => {
    if (currentlyInFullArrange && getSceneNode(underConstructionScene, path)) {
      return getSceneDisplayItemFingerprint(underConstructionScene, path);
    }
    return getSceneDisplayItemFingerprint(currentScene, path);
  },

  getAttachmentsVes: (path: VisualElementPath): Accessor<Array<VisualElementSignal>> => {
    return renderSceneQueries.getAttachments(path);
  },

  getPopupVes: (path: VisualElementPath): Accessor<VisualElementSignal | null> => {
    return renderSceneQueries.getPopup(path);
  },

  getSelectedVes: (path: VisualElementPath): Accessor<VisualElementSignal | null> => {
    return renderSceneQueries.getSelected(path);
  },

  getDockVes: (path: VisualElementPath): Accessor<VisualElementSignal | null> => {
    return renderSceneQueries.getDock(path);
  },

  getChildrenVes: (path: VisualElementPath): Accessor<Array<VisualElementSignal>> => {
    return renderSceneQueries.getChildren(path);
  },

  getLineChildrenVes: (path: VisualElementPath): Accessor<Array<VisualElementSignal>> => {
    return renderSceneQueries.getLineChildren(path);
  },

  getDesktopChildrenVes: (path: VisualElementPath): Accessor<Array<VisualElementSignal>> => {
    return renderSceneQueries.getDesktopChildren(path);
  },

  getNonMovingChildrenVes: (path: VisualElementPath): Accessor<Array<VisualElementSignal>> => {
    return renderSceneQueries.getNonMovingChildren(path);
  },

  getFocusedChild: (path: VisualElementPath): Accessor<Item | null> => {
    return renderSceneQueries.getFocusedChild(path);
  },

  getTableVesRows: (path: VisualElementPath): Array<number> | null => {
    if (currentlyInFullArrange && sceneHasNode(underConstructionScene, path)) {
      return underConstructionRenderTableRowsByPath.get(path) ?? null;
    }
    return renderProjectionByPath.get(path)?.tableRows ?? null;
  },
}


function buildUnderConstructionVisualElementSignal(spec: VisualElementSpec, relationships: VisualElementRelationships, path: VisualElementPath): VisualElementSignal {
  const preparedSpec = prepareVisualElementSpec(spec);
  const preparedRelationships = prepareSceneRelationshipData(underConstructionScene, relationships);
  setUnderConstructionRenderTableRows(path, relationships.tableVesRows);

  const debug = false; // VeFns.veidFromPath(path).itemId == "<id of item of interest here>";

  maybeTrackLoadedContainer(underConstructionSceneOutputs, preparedSpec);

  const existing = getSceneNode(currentScene, path);
  if (existing) {
    const existingVe = existing;
    if (existingVe.displayItemFingerprint != preparedSpec.displayItemFingerprint) {
      if (debug) { console.debug("display item fingerprint changed", existingVe.displayItemFingerprint, preparedSpec.displayItemFingerprint); }
      logDirtyReason("fingerprint");
      const nextVe = VeFns.create(preparedSpec);
      return writeUnderConstructionScenePath(path, nextVe, preparedRelationships);
    }

    // Check if the LineItem flag is changing. If it is, we should not recycle
    // the visual element because the rendering path will be completely different
    // (VisualElement_LineItem vs VisualElement_Desktop), so there's no DOM reuse
    // benefit. Creating a new visual element ensures a clean state transition.
    const oldHasLineItemFlag = !!(existingVe.flags & VisualElementFlags.LineItem);
    const newHasLineItemFlag = !!((preparedSpec.flags || VisualElementFlags.None) & VisualElementFlags.LineItem);

    if (oldHasLineItemFlag !== newHasLineItemFlag) {
      if (debug) { console.debug("LineItem flag changed, creating new visual element instead of recycling:", path); }
      logDirtyReason("lineItemChange");
      arrangeStats.new++; // This creates a new signal rather than recycling
      const newElement = VeFns.create(preparedSpec);
      return writeUnderConstructionScenePath(path, newElement, preparedRelationships);
    }

    const newVals: any = preparedSpec;
    const oldVals: any = existingVe;
    const newProps = Object.getOwnPropertyNames(preparedSpec);
    let dirty = false;
    if (debug) { console.debug(newProps, oldVals, preparedSpec); }
    for (let i = 0; i < newProps.length; ++i) {
      if (debug) { console.debug("considering", newProps[i]); }
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
      return writeUnderConstructionScenePath(path, existingVe, preparedRelationships);
    }
    if (debug) { console.debug("dirty:", path); }
    arrangeStats.dirty++;

    const nextVe = VeFns.create(preparedSpec);
    return writeUnderConstructionScenePath(path, nextVe, preparedRelationships);
  }

  if (debug) { console.debug("creating:", path); }
  arrangeStats.new++;
  const newElement = VeFns.create(preparedSpec);
  return writeUnderConstructionScenePath(path, newElement, preparedRelationships);
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
