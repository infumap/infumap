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
  getRenderProjection(path).tableRows = rows;
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
  tableRows: Array<number> | null;
  focusedChildItemMaybe: Item | null;
}

type SceneRelationshipsByPath = Map<VisualElementPath, SceneRelationshipData>;

type SceneState = {
  cache: Map<VisualElementPath, VisualElementSignal>;
  vessVsDisplayId: Map<Uid, Array<VisualElementPath>>;
  childrenByParent: Map<VisualElementPath, Array<VisualElementSignal>>;
  vessByVeid: Map<string, Array<VisualElementSignal>>;
  relationshipsByPath: SceneRelationshipsByPath;
}

type VirtualSceneState = {
  cache: Map<VisualElementPath, VisualElement>;
  vessVsDisplayId: Map<Uid, Array<VisualElementPath>>;
  childrenByParent: Map<VisualElementPath, Array<VisualElement>>;
  vessByVeid: Map<string, Array<VisualElement>>;
  relationshipsByPath: SceneRelationshipsByPath;
}

function createEmptySceneState(): SceneState {
  return {
    cache: new Map<VisualElementPath, VisualElementSignal>(),
    vessVsDisplayId: new Map<Uid, Array<VisualElementPath>>(),
    childrenByParent: new Map<VisualElementPath, Array<VisualElementSignal>>(),
    vessByVeid: new Map<string, Array<VisualElementSignal>>(),
    relationshipsByPath: new Map(),
  };
}

function createEmptyVirtualSceneState(): VirtualSceneState {
  return {
    cache: new Map<VisualElementPath, VisualElement>(),
    vessVsDisplayId: new Map<Uid, Array<VisualElementPath>>(),
    childrenByParent: new Map<VisualElementPath, Array<VisualElement>>(),
    vessByVeid: new Map<string, Array<VisualElement>>(),
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
  return resolveSceneRelationshipNodes(scene, scene.relationshipsByPath.get(parentPath)?.children);
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
  return getSceneNode(scene, path)?.get().displayItemFingerprint;
}

function getSceneTableRows(scene: SceneState, path: VisualElementPath): Array<number> | null {
  return scene.relationshipsByPath.get(path)?.tableRows ?? null;
}

function readSignalNode(node: VisualElementSignal | null | undefined): VisualElement | null {
  return node?.get() ?? null;
}

function readSignalNodeList(list: Array<VisualElementSignal> | undefined): Array<VisualElement> {
  return (list ?? []).map(ves => ves.get());
}

function resolveSceneRelationshipNode(scene: SceneState, path: VisualElementPath | null | undefined): VisualElementSignal | null {
  if (path == null) {
    return null;
  }
  return getSceneNode(scene, path) ?? null;
}

function resolveSceneRelationshipNodes(scene: SceneState, paths: Array<VisualElementPath> | undefined): Array<VisualElementSignal> {
  const resolved: Array<VisualElementSignal> = [];
  for (const path of paths ?? []) {
    const node = getSceneNode(scene, path);
    if (node) {
      resolved.push(node);
    }
  }
  return resolved;
}

function readSceneRelationshipNode(scene: SceneState, path: VisualElementPath | null | undefined): VisualElement | null {
  return readSignalNode(resolveSceneRelationshipNode(scene, path));
}

function readSceneRelationshipNodes(scene: SceneState, paths: Array<VisualElementPath> | undefined): Array<VisualElement> {
  return readSignalNodeList(resolveSceneRelationshipNodes(scene, paths));
}

function readVirtualRelationshipNodes(paths: Array<VisualElementPath> | undefined): Array<VisualElement> {
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
  return getSceneNode(scene, path)?.get();
}

function readSceneIndexedChildren(scene: SceneState, parentPath: VisualElementPath): Array<VisualElement> {
  return readSignalNodeList(getSceneIndexedChildren(scene, parentPath));
}

function readSceneStructuralChildren(scene: SceneState, parentPath: VisualElementPath): Array<VisualElement> {
  return readSceneRelationshipNodes(scene, scene.relationshipsByPath.get(parentPath)?.children);
}

function readSceneSiblings(scene: SceneState, path: VisualElementPath): Array<VisualElement> {
  return readSignalNodeList(getSceneSiblings(scene, path));
}

function readSceneAttachments(scene: SceneState, path: VisualElementPath): Array<VisualElement> {
  return readSceneRelationshipNodes(scene, scene.relationshipsByPath.get(path)?.attachments);
}

function readScenePopup(scene: SceneState, path: VisualElementPath): VisualElement | null {
  return readSceneRelationshipNode(scene, scene.relationshipsByPath.get(path)?.popup);
}

function readSceneSelected(scene: SceneState, path: VisualElementPath): VisualElement | null {
  return readSceneRelationshipNode(scene, scene.relationshipsByPath.get(path)?.selected);
}

function readSceneDock(scene: SceneState, path: VisualElementPath): VisualElement | null {
  return readSceneRelationshipNode(scene, scene.relationshipsByPath.get(path)?.dock);
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

  const resolveSnapshotNode = (ves: VisualElementSignal): VisualElement => {
    const path = VeFns.veToPath(ves.get());
    const existing = snapshot.cache.get(path);
    if (existing) {
      return existing;
    }
    const cloned = cloneVisualElementSnapshot(ves.get());
    snapshot.cache.set(path, cloned);
    return cloned;
  };
  const resolveSnapshotNodes = (list: Array<VisualElementSignal> | undefined): Array<VisualElement> => {
    return (list ?? []).map(resolveSnapshotNode);
  };

  for (const [parentPath, children] of scene.childrenByParent) {
    snapshot.childrenByParent.set(parentPath, resolveSnapshotNodes(children));
  }

  for (const [veidKey, matches] of scene.vessByVeid) {
    snapshot.vessByVeid.set(veidKey, resolveSnapshotNodes(matches));
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
      tableRows: relationships.tableRows ? relationships.tableRows.slice() : null,
      focusedChildItemMaybe: relationships.focusedChildItemMaybe,
    });
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
  return readVirtualRelationshipNodes(virtualScene.relationshipsByPath.get(parentPath)?.children);
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
  syncSceneRelationships(scene.relationshipsByPath, path, relationships);
  indexVisualElement(scene, path, ves);
}

function syncRenderProjectionForPath(scene: SceneState, path: VisualElementPath) {
  updateRenderProjectionNode(path, getSceneNode(scene, path));
  const relationships = scene.relationshipsByPath.get(path);
  updateRenderProjectionPopup(path, resolveSceneRelationshipNode(scene, relationships?.popup));
  updateRenderProjectionSelected(path, resolveSceneRelationshipNode(scene, relationships?.selected));
  updateRenderProjectionDock(path, resolveSceneRelationshipNode(scene, relationships?.dock));
  updateRenderProjectionAttachments(path, resolveSceneRelationshipNodes(scene, relationships?.attachments));
  updateRenderProjectionChildren(path, resolveSceneRelationshipNodes(scene, relationships?.children));
  updateRenderProjectionLineChildren(path, resolveSceneRelationshipNodes(scene, relationships?.lineChildren));
  updateRenderProjectionDesktopChildren(path, resolveSceneRelationshipNodes(scene, relationships?.desktopChildren));
  updateRenderProjectionNonMovingChildren(path, resolveSceneRelationshipNodes(scene, relationships?.nonMovingChildren));
  updateRenderProjectionFocused(path, relationships?.focusedChildItemMaybe ?? null);
  setRenderProjectionTableRows(path, getSceneTableRows(scene, path));
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

function toSceneRelationshipPath(node: VisualElementSignal | null | undefined): VisualElementPath | null {
  return node ? VeFns.veToPath(node.get()) : null;
}

function toSceneRelationshipPaths(nodes: Array<VisualElementSignal> | undefined): Array<VisualElementPath> {
  return (nodes ?? []).map(node => VeFns.veToPath(node.get()));
}

function splitChildPathsByRenderBehavior(childrenVes: Array<VisualElementSignal> | undefined) {
  const allChildren = childrenVes ?? [];
  const allChildPaths: Array<VisualElementPath> = [];
  const lineChildren: Array<VisualElementPath> = [];
  const desktopChildren: Array<VisualElementPath> = [];
  const nonMovingChildren: Array<VisualElementPath> = [];

  for (const childVe of allChildren) {
    const childPath = VeFns.veToPath(childVe.get());
    const flags = childVe.get().flags;
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

function syncSceneRelationships(
  relationshipsByPath: SceneRelationshipsByPath,
  path: VisualElementPath,
  relationships: VisualElementRelationships | null,
) {
  const childBuckets = splitChildPathsByRenderBehavior(relationships?.childrenVes);
  relationshipsByPath.set(path, {
    attachments: toSceneRelationshipPaths(relationships?.attachmentsVes),
    popup: toSceneRelationshipPath(relationships?.popupVes),
    selected: toSceneRelationshipPath(relationships?.selectedVes),
    dock: toSceneRelationshipPath(relationships?.dockVes),
    children: childBuckets.allChildren,
    lineChildren: childBuckets.lineChildren,
    desktopChildren: childBuckets.desktopChildren,
    nonMovingChildren: childBuckets.nonMovingChildren,
    tableRows: relationships?.tableVesRows ?? null,
    focusedChildItemMaybe: relationships?.focusedChildItemMaybe ?? null,
  });
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

function syncRenderProjectionFromScene(scene: SceneState) {
  for (const [path] of renderProjectionByPath) {
    if (!sceneHasNode(scene, path)) {
      clearRenderProjectionForPath(path);
    }
  }
  for (const [path] of scene.cache) {
    syncRenderProjectionForPath(scene, path);
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
  syncRenderProjectionFromScene(scene);
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
  },

  full_finalizeArrange: (store: StoreContextModel, umbrellaSpec: VisualElementSpec, umbrellaRelationships: VisualElementRelationships, umbrellaPath: VisualElementPath, virtualUmbrellaVes?: VisualElementSignal): void => {
    if (umbrellaSpec.displayItemFingerprint) { panic("displayItemFingerprint is already set."); }
    umbrellaSpec.displayItemFingerprint = ItemFns.getFingerprint(umbrellaSpec.displayItem); // TODO (LOW): Modifying the input object is a bit nasty.
    const umbrellaVeSpec = { ...umbrellaSpec, ...umbrellaRelationships };

    if (virtualUmbrellaVes) {
      setSceneNode(underConstructionScene, umbrellaPath, virtualUmbrellaVes);
      syncSceneRelationships(underConstructionScene.relationshipsByPath, umbrellaPath, umbrellaVeSpec);
      promoteVirtualScene(underConstructionScene);
    } else {
      setSceneNode(underConstructionScene, umbrellaPath, store.umbrellaVisualElement);  // TODO (MEDIUM): full property reconciliation, to avoid this update.
      store.umbrellaVisualElement.set(VeFns.create(umbrellaVeSpec));
      syncSceneRelationships(underConstructionScene.relationshipsByPath, umbrellaPath, umbrellaVeSpec);
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
    syncRenderProjectionForPath(currentScene, path);


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
    deleteSceneRelationships(currentScene.relationshipsByPath, existingPath);
    if (existingPath != newPath) {
      clearRenderProjectionForPath(existingPath);
    }
    VeFns.clearAndOverwrite(veToOverwrite, visualElementOverride);
    vesToOverwrite.set(veToOverwrite);
    writeScenePath(currentScene, newPath, vesToOverwrite, relationships);
    syncRenderProjectionForPath(currentScene, newPath);


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
    if (ve && isContainer(ve.get().displayItem) && asContainerItem(ve.get().displayItem).childrenLoaded) {
      removeSceneWatchContainerUid(currentSceneOutputs, ve.get().displayItem.id, ve.get().displayItem.origin);
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
      return getSceneTableRows(underConstructionScene, path);
    }
    return renderProjectionByPath.get(path)?.tableRows ?? getSceneTableRows(currentScene, path);
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
      syncSceneRelationships(underConstructionScene.relationshipsByPath, path, relationships);
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
      syncSceneRelationships(underConstructionScene.relationshipsByPath, path, relationships);
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
      syncSceneRelationships(underConstructionScene.relationshipsByPath, path, relationships);
      addVesVsDisplayItem(existingVe.displayItem.id, path);
      addUnderConstructionIndexes(path, existing);
      return existing;
    }
    if (debug) { console.debug("dirty:", path); }
    arrangeStats.dirty++;

    // Recycle the existing visual element
    existing.set(VeFns.create(visualElementOverride));
    setSceneNode(underConstructionScene, path, existing);
    syncSceneRelationships(underConstructionScene.relationshipsByPath, path, relationships);
    addVesVsDisplayItem(existing.get().displayItem.id, path);
    addUnderConstructionIndexes(path, existing);
    return existing;
  }

  if (debug) { console.debug("creating:", path); }
  arrangeStats.new++;
  const newElement = createVisualElementSignal(VeFns.create(visualElementOverride));
  setSceneNode(underConstructionScene, path, newElement);
  syncSceneRelationships(underConstructionScene.relationshipsByPath, path, relationships);
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
