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
import { panic } from "../util/lang";
import { compareBoundingBox, compareDimensions } from "../util/geometry";
import { VisualElementSignal, createVisualElementSignal } from "../util/signals";
import { Uid } from "../util/uid";
import { HitboxFns } from "./hitbox";
import { NONE_VISUAL_ELEMENT, VeFns, Veid, VisualElement, VisualElementFlags, VisualElementPath, VisualElementRelationships, VisualElementSpec } from "./visual-element";

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

type RenderProjectionSlot<T> = {
  value: T;
  signal: [Accessor<T>, Setter<T>] | null;
}

type RenderProjectionEntry = {
  node: RenderProjectionSlot<VisualElementSignal | undefined>;
  popup: RenderProjectionSlot<VisualElementSignal | null>;
  selected: RenderProjectionSlot<VisualElementSignal | null>;
  dock: RenderProjectionSlot<VisualElementSignal | null>;
  focused: RenderProjectionSlot<Item | null>;
  attachments: RenderProjectionSlot<Array<VisualElementSignal>>;
  children: RenderProjectionSlot<Array<VisualElementSignal>>;
  lineChildren: RenderProjectionSlot<Array<VisualElementSignal>>;
  desktopChildren: RenderProjectionSlot<Array<VisualElementSignal>>;
  nonMovingChildren: RenderProjectionSlot<Array<VisualElementSignal>>;
  tableRows: Array<number> | null;
}

let renderProjectionByPath = new Map<VisualElementPath, RenderProjectionEntry>();

function createRenderProjectionEntry(): RenderProjectionEntry {
  return {
    node: { value: undefined, signal: null },
    popup: { value: null, signal: null },
    selected: { value: null, signal: null },
    dock: { value: null, signal: null },
    focused: { value: null, signal: null },
    attachments: { value: [], signal: null },
    children: { value: [], signal: null },
    lineChildren: { value: [], signal: null },
    desktopChildren: { value: [], signal: null },
    nonMovingChildren: { value: [], signal: null },
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

function findRenderProjection(path: VisualElementPath): RenderProjectionEntry | undefined {
  return renderProjectionByPath.get(path);
}

function ensureRenderProjectionSignal<T>(
  slot: RenderProjectionSlot<T>,
): [Accessor<T>, Setter<T>] {
  if (slot.signal) {
    return slot.signal;
  }
  const signal = createSignal<T>(slot.value);
  slot.signal = signal;
  return signal;
}

function readRenderProjectionSignal<T>(slot: RenderProjectionSlot<T>): T {
  return slot.signal ? slot.signal[0]() : slot.value;
}

function updateRenderProjectionSlot<T>(
  slot: RenderProjectionSlot<T>,
  value: T,
  shouldUpdate?: (current: T, next: T) => boolean,
): boolean {
  slot.value = value;
  if (!slot.signal) {
    return false;
  }
  return updateRenderProjectionSignal(slot.signal, value, shouldUpdate);
}

function updateRenderProjectionSignal<T>(signal: [Accessor<T>, Setter<T>], value: T, shouldUpdate?: (current: T, next: T) => boolean) {
  const [read, write] = signal;
  const current = read();
  if (shouldUpdate ? shouldUpdate(current, value) : current !== value) {
    write(value);
    return true;
  }
  return false;
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

function updateRenderProjectionPopup(path: VisualElementPath, value: VisualElementSignal | null): boolean {
  return updateRenderProjectionSlot(getRenderProjection(path).popup, value);
}

function updateRenderProjectionNode(path: VisualElementPath, value: VisualElementSignal | undefined) {
  updateRenderProjectionSlot(getRenderProjection(path).node, value);
}

function updateRenderProjectionSelected(path: VisualElementPath, value: VisualElementSignal | null): boolean {
  return updateRenderProjectionSlot(getRenderProjection(path).selected, value);
}

function updateRenderProjectionDock(path: VisualElementPath, value: VisualElementSignal | null): boolean {
  return updateRenderProjectionSlot(getRenderProjection(path).dock, value);
}

function updateRenderProjectionFocused(path: VisualElementPath, value: Item | null): boolean {
  return updateRenderProjectionSlot(getRenderProjection(path).focused, value, (current, next) => {
    if (current?.id !== next?.id) {
      return true;
    }
    return current !== next;
  });
}

function updateRenderProjectionAttachments(path: VisualElementPath, value: Array<VisualElementSignal> | undefined): boolean {
  const actualValue = value ?? [];
  return updateRenderProjectionSlot(getRenderProjection(path).attachments, actualValue, shouldUpdateSignalList);
}

function updateRenderProjectionChildren(path: VisualElementPath, value: Array<VisualElementSignal> | undefined): boolean {
  const actualValue = value ?? [];
  return updateRenderProjectionSlot(getRenderProjection(path).children, actualValue, shouldUpdateSignalList);
}

function updateRenderProjectionLineChildren(path: VisualElementPath, value: Array<VisualElementSignal> | undefined): boolean {
  const actualValue = value ?? [];
  return updateRenderProjectionSlot(getRenderProjection(path).lineChildren, actualValue, shouldUpdateSignalList);
}

function updateRenderProjectionDesktopChildren(path: VisualElementPath, value: Array<VisualElementSignal> | undefined): boolean {
  const actualValue = value ?? [];
  return updateRenderProjectionSlot(getRenderProjection(path).desktopChildren, actualValue, shouldUpdateSignalList);
}

function updateRenderProjectionNonMovingChildren(path: VisualElementPath, value: Array<VisualElementSignal> | undefined): boolean {
  const actualValue = value ?? [];
  return updateRenderProjectionSlot(getRenderProjection(path).nonMovingChildren, actualValue, shouldUpdateSignalList);
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

function getCurrentRenderTableRows(path: VisualElementPath): Array<number> | null {
  return renderProjectionByPath.get(path)?.tableRows ?? null;
}

function getUnderConstructionRenderTableRows(path: VisualElementPath): Array<number> | null {
  return underConstructionRenderTableRowsByPath.get(path) ?? null;
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

function createVisualElement(spec: VisualElementSpec): VisualElement {
  return VeFns.create(spec);
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
  const entry = findRenderProjection(path);
  if (!entry) {
    return undefined;
  }
  return readRenderProjectionSignal(entry.node);
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

function specValueOrDefault<T>(value: T | undefined, fallback: T): T {
  return typeof value === "undefined" ? fallback : value;
}

function sameUidMaybe(a: { id: Uid } | null | undefined, b: { id: Uid } | null | undefined): boolean {
  return (a?.id ?? null) === (b?.id ?? null);
}

function visualElementMatchesPreparedSpec(preparedSpec: VisualElementSpec, existingVe: VisualElement): boolean {
  if (existingVe.displayItemFingerprint !== preparedSpec.displayItemFingerprint) { return false; }
  if (existingVe.displayItem.id !== preparedSpec.displayItem.id) { return false; }
  if (!sameUidMaybe(existingVe.linkItemMaybe, specValueOrDefault(preparedSpec.linkItemMaybe, NONE_VISUAL_ELEMENT.linkItemMaybe))) { return false; }
  if (!sameUidMaybe(existingVe.actualLinkItemMaybe, specValueOrDefault(preparedSpec.actualLinkItemMaybe, NONE_VISUAL_ELEMENT.actualLinkItemMaybe))) { return false; }
  if (existingVe.flags !== specValueOrDefault(preparedSpec.flags, NONE_VISUAL_ELEMENT.flags)) { return false; }
  if (existingVe._arrangeFlags_useForPartialRearrangeOnly !== specValueOrDefault(preparedSpec._arrangeFlags_useForPartialRearrangeOnly, NONE_VISUAL_ELEMENT._arrangeFlags_useForPartialRearrangeOnly)) { return false; }
  if (compareBoundingBox(existingVe.resizingFromBoundsPx, NONE_VISUAL_ELEMENT.resizingFromBoundsPx) !== 0) { return false; }
  if (compareBoundingBox(existingVe.boundsPx, preparedSpec.boundsPx) !== 0) { return false; }
  if (compareBoundingBox(existingVe.viewportBoundsPx, specValueOrDefault(preparedSpec.viewportBoundsPx, NONE_VISUAL_ELEMENT.viewportBoundsPx)) !== 0) { return false; }
  if (compareBoundingBox(existingVe.childAreaBoundsPx, specValueOrDefault(preparedSpec.childAreaBoundsPx, NONE_VISUAL_ELEMENT.childAreaBoundsPx)) !== 0) { return false; }
  if (compareBoundingBox(existingVe.listViewportBoundsPx, specValueOrDefault(preparedSpec.listViewportBoundsPx, NONE_VISUAL_ELEMENT.listViewportBoundsPx)) !== 0) { return false; }
  if (compareBoundingBox(existingVe.listChildAreaBoundsPx, specValueOrDefault(preparedSpec.listChildAreaBoundsPx, NONE_VISUAL_ELEMENT.listChildAreaBoundsPx)) !== 0) { return false; }
  if (compareDimensions(existingVe.tableDimensionsPx, specValueOrDefault(preparedSpec.tableDimensionsPx, NONE_VISUAL_ELEMENT.tableDimensionsPx)) !== 0) { return false; }
  if ((existingVe.indentBl ?? null) !== (specValueOrDefault(preparedSpec.indentBl, NONE_VISUAL_ELEMENT.indentBl) ?? null)) { return false; }
  if (compareDimensions(existingVe.blockSizePx, specValueOrDefault(preparedSpec.blockSizePx, NONE_VISUAL_ELEMENT.blockSizePx)) !== 0) { return false; }
  if (compareDimensions(existingVe.cellSizePx, specValueOrDefault(preparedSpec.cellSizePx, NONE_VISUAL_ELEMENT.cellSizePx)) !== 0) { return false; }
  if ((existingVe.row ?? null) !== (specValueOrDefault(preparedSpec.row, NONE_VISUAL_ELEMENT.row) ?? null)) { return false; }
  if ((existingVe.col ?? null) !== (specValueOrDefault(preparedSpec.col, NONE_VISUAL_ELEMENT.col) ?? null)) { return false; }
  if ((existingVe.numRows ?? null) !== (specValueOrDefault(preparedSpec.numRows, NONE_VISUAL_ELEMENT.numRows) ?? null)) { return false; }
  if (HitboxFns.ArrayCompare(existingVe.hitboxes, specValueOrDefault(preparedSpec.hitboxes, NONE_VISUAL_ELEMENT.hitboxes)) !== 0) { return false; }
  if ((existingVe.parentPath ?? null) !== (specValueOrDefault(preparedSpec.parentPath, NONE_VISUAL_ELEMENT.parentPath) ?? null)) { return false; }
  if ((existingVe.evaluatedTitle ?? null) !== (specValueOrDefault(preparedSpec.evaluatedTitle, NONE_VISUAL_ELEMENT.evaluatedTitle) ?? null)) { return false; }

  return true;
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

function writeUnderConstructionSceneNode(
  path: VisualElementPath,
  ve: VisualElement,
  relationshipData: SceneRelationshipData,
) {
  writeScenePath(underConstructionScene, path, ve, reuseSceneRelationshipDataIfEqual(path, relationshipData));
  syncUnderConstructionArrangeSignal(path, ve);
}

function writePreparedUnderConstructionVisualElement(
  preparedSpec: VisualElementSpec,
  preparedRelationships: SceneRelationshipData,
  path: VisualElementPath,
): VisualElement {
  maybeTrackLoadedContainer(underConstructionSceneOutputs, preparedSpec);
  const existingVe = getSceneNode(currentScene, path);
  const canonicalVe = existingVe && visualElementMatchesPreparedSpec(preparedSpec, existingVe)
    ? existingVe
    : createVisualElement(preparedSpec);
  writeUnderConstructionSceneNode(path, canonicalVe, preparedRelationships);
  return canonicalVe;
}

function arraysShallowEqual<T>(a: Array<T>, b: Array<T>): boolean {
  if (a === b) {
    return true;
  }
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function sceneRelationshipDataEqual(a: SceneRelationshipData, b: SceneRelationshipData): boolean {
  return arraysShallowEqual(a.attachments, b.attachments) &&
    a.popup === b.popup &&
    a.selected === b.selected &&
    a.dock === b.dock &&
    arraysShallowEqual(a.children, b.children) &&
    arraysShallowEqual(a.lineChildren, b.lineChildren) &&
    arraysShallowEqual(a.desktopChildren, b.desktopChildren) &&
    arraysShallowEqual(a.nonMovingChildren, b.nonMovingChildren) &&
    ((a.focusedChildItemMaybe?.id ?? null) === (b.focusedChildItemMaybe?.id ?? null));
}

function reuseSceneRelationshipDataIfEqual(
  path: VisualElementPath,
  relationshipData: SceneRelationshipData,
): SceneRelationshipData {
  const existing = currentScene.relationshipsByPath.get(path);
  if (existing && sceneRelationshipDataEqual(existing, relationshipData)) {
    return existing;
  }
  return relationshipData;
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

  if (preferredSignal) {
    updateRenderProjectionNode(path, preferredSignal);
    return;
  }

  let signal = getRenderNode(path);
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

function syncRenderProjectionRelationshipsForPath(
  scene: SceneState,
  path: VisualElementPath,
  previousRelationships?: SceneRelationshipData,
  renderTableRows?: Array<number> | null,
) {
  const relationships = scene.relationshipsByPath.get(path);
  if (relationships === previousRelationships) {
    setRenderProjectionTableRows(path, renderTableRows ?? null);
    return;
  }
  const popup = resolveSceneNodePath(scene, relationships?.popup);
  updateRenderProjectionPopup(path, popup);
  const selected = resolveSceneNodePath(scene, relationships?.selected);
  updateRenderProjectionSelected(path, selected);
  const dock = resolveSceneNodePath(scene, relationships?.dock);
  updateRenderProjectionDock(path, dock);
  const attachments = resolveSceneNodePaths(scene, relationships?.attachments);
  updateRenderProjectionAttachments(path, attachments);
  const children = resolveSceneNodePaths(scene, relationships?.children);
  updateRenderProjectionChildren(path, children);
  const lineChildren = resolveSceneNodePaths(scene, relationships?.lineChildren);
  updateRenderProjectionLineChildren(path, lineChildren);
  const desktopChildren = resolveSceneNodePaths(scene, relationships?.desktopChildren);
  updateRenderProjectionDesktopChildren(path, desktopChildren);
  const nonMovingChildren = resolveSceneNodePaths(scene, relationships?.nonMovingChildren);
  updateRenderProjectionNonMovingChildren(path, nonMovingChildren);
  const focusedChild = relationships?.focusedChildItemMaybe ?? null;
  updateRenderProjectionFocused(path, focusedChild);
  setRenderProjectionTableRows(path, renderTableRows ?? null);
}

function clearRenderProjectionForPath(path: VisualElementPath) {
  const entry = findRenderProjection(path);
  if (!entry) {
    return;
  }

  updateRenderProjectionSlot(entry.node, undefined);
  updateRenderProjectionSlot(entry.popup, null);
  updateRenderProjectionSlot(entry.selected, null);
  updateRenderProjectionSlot(entry.dock, null);
  updateRenderProjectionSlot(entry.attachments, [], shouldUpdateSignalList);
  updateRenderProjectionSlot(entry.children, [], shouldUpdateSignalList);
  updateRenderProjectionSlot(entry.lineChildren, [], shouldUpdateSignalList);
  updateRenderProjectionSlot(entry.desktopChildren, [], shouldUpdateSignalList);
  updateRenderProjectionSlot(entry.nonMovingChildren, [], shouldUpdateSignalList);
  updateRenderProjectionSlot(entry.focused, null, (current, next) => {
    if (current?.id !== next?.id) {
      return true;
    }
    return current !== next;
  });
  entry.tableRows = null;
}

function deleteRenderProjectionForPath(path: VisualElementPath) {
  renderProjectionByPath.delete(path);
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

function reuseChildBucketsIfUnchanged(
  scene: SceneState,
  path: VisualElementPath | undefined,
  childPaths: Array<VisualElementPath>,
) {
  if (!path) {
    return null;
  }

  const previousRelationships = currentScene.relationshipsByPath.get(path);
  if (!previousRelationships || !arraysShallowEqual(previousRelationships.children, childPaths)) {
    return null;
  }

  for (const childPath of childPaths) {
    if (getSceneNode(scene, childPath) !== getSceneNode(currentScene, childPath)) {
      return null;
    }
  }

  return {
    allChildren: previousRelationships.children,
    lineChildren: previousRelationships.lineChildren,
    desktopChildren: previousRelationships.desktopChildren,
    nonMovingChildren: previousRelationships.nonMovingChildren,
  };
}

function prepareSceneRelationshipData(
  scene: SceneState,
  relationships: VisualElementRelationships | null,
  path?: VisualElementPath,
): SceneRelationshipData {
  const childPaths = relationships?.childrenPaths ?? toSceneRelationshipPaths(relationships?.childrenVes);
  const reusedChildBuckets = reuseChildBucketsIfUnchanged(scene, path, childPaths);
  const childBuckets = reusedChildBuckets ?? splitChildPathsByRenderBehavior(scene, childPaths);
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

function syncRenderProjectionFromScene(
  previousScene: SceneState,
  scene: SceneState,
  renderTableRowsByPath?: Map<VisualElementPath, Array<number>>,
) {
  for (const [path] of previousScene.cache) {
    if (!sceneHasNode(scene, path)) {
      deleteRenderProjectionForPath(path);
    }
  }

  for (const [path] of scene.cache) {
    syncRenderProjectionNode(
      path,
      getSceneNode(scene, path),
      previousScene?.cache.get(path),
      previousScene.cache.has(path) ? undefined : underConstructionArrangeSignalsByPath.get(path),
    );
  }

  for (const [path] of scene.cache) {
    syncRenderProjectionRelationshipsForPath(
      scene,
      path,
      previousScene?.relationshipsByPath.get(path),
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
    return ensureRenderProjectionSignal(getRenderProjection(path).node)[0]();
  },

  find: (veid: Veid): Array<VisualElementSignal> => {
    return findCurrentSceneMatches(veid);
  },

  findSingle: (veid: Veid): VisualElementSignal => {
    return findSingleCurrentSceneMatch(veid);
  },

  getAttachments: (path: VisualElementPath): Accessor<Array<VisualElementSignal>> => {
    return ensureRenderProjectionSignal(getRenderProjection(path).attachments)[0];
  },

  getPopup: (path: VisualElementPath): Accessor<VisualElementSignal | null> => {
    return ensureRenderProjectionSignal(getRenderProjection(path).popup)[0];
  },

  getSelected: (path: VisualElementPath): Accessor<VisualElementSignal | null> => {
    return ensureRenderProjectionSignal(getRenderProjection(path).selected)[0];
  },

  getDock: (path: VisualElementPath): Accessor<VisualElementSignal | null> => {
    return ensureRenderProjectionSignal(getRenderProjection(path).dock)[0];
  },

  getChildren: (path: VisualElementPath): Accessor<Array<VisualElementSignal>> => {
    return ensureRenderProjectionSignal(getRenderProjection(path).children)[0];
  },

  getLineChildren: (path: VisualElementPath): Accessor<Array<VisualElementSignal>> => {
    return ensureRenderProjectionSignal(getRenderProjection(path).lineChildren)[0];
  },

  getDesktopChildren: (path: VisualElementPath): Accessor<Array<VisualElementSignal>> => {
    return ensureRenderProjectionSignal(getRenderProjection(path).desktopChildren)[0];
  },

  getNonMovingChildren: (path: VisualElementPath): Accessor<Array<VisualElementSignal>> => {
    return ensureRenderProjectionSignal(getRenderProjection(path).nonMovingChildren)[0];
  },

  getFocusedChild: (path: VisualElementPath): Accessor<Item | null> => {
    return ensureRenderProjectionSignal(getRenderProjection(path).focused)[0];
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
    underConstructionArrangeSignalsByPath = new Map<VisualElementPath, VisualElementSignal>();
    underConstructionRenderTableRowsByPath = new Map<VisualElementPath, Array<number>>();
  },

  full_finalizeArrange: (store: StoreContextModel, umbrellaSpec: VisualElementSpec, umbrellaRelationships: VisualElementRelationships, umbrellaPath: VisualElementPath, virtualUmbrellaVes?: VisualElementSignal): void => {
    const preparedUmbrellaSpec = prepareVisualElementSpec(umbrellaSpec);
    const preparedUmbrellaRelationships = prepareSceneRelationshipData(underConstructionScene, umbrellaRelationships, umbrellaPath);
    const umbrellaVe = virtualUmbrellaVes ? cloneVisualElementSnapshot(virtualUmbrellaVes.get()) : createVisualElement(preparedUmbrellaSpec);

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
    return VesCache.full_writeVisualElementSignal(spec, relationships, path);
  },

  /**
   * Writes the next under-construction scene node without doing per-node diffing
   * and without materializing an arrange-time signal unless one already exists.
   */
  full_writeVisualElement: (spec: VisualElementSpec, relationships: VisualElementRelationships, path: VisualElementPath): void => {
    const preparedSpec = prepareVisualElementSpec(spec);
    const preparedRelationships = prepareSceneRelationshipData(underConstructionScene, relationships, path);
    writePreparedUnderConstructionVisualElement(preparedSpec, preparedRelationships, path);
  },

  /**
   * Writes the next under-construction scene node without per-node diffing and
   * returns an arrange-time signal view for call sites that still want one.
   */
  full_writeVisualElementSignal: (spec: VisualElementSpec, relationships: VisualElementRelationships, path: VisualElementPath): VisualElementSignal => {
    const preparedSpec = prepareVisualElementSpec(spec);
    const preparedRelationships = prepareSceneRelationshipData(underConstructionScene, relationships, path);
    writePreparedUnderConstructionVisualElement(preparedSpec, preparedRelationships, path);
    return ensureUnderConstructionArrangeSignal(path) ?? panic(`failed to materialize under-construction arrange signal for ${path}.`);
  },

  /**
   * Create a new VisualElementSignal and insert it into the current cache.
   */
  partial_create: (spec: VisualElementSpec, relationships: VisualElementRelationships, path: VisualElementPath): VisualElementSignal => {
    const preparedSpec = prepareVisualElementSpec(spec);
    const preparedRelationships = prepareSceneRelationshipData(currentScene, relationships, path);
    const newElement = createVisualElement(preparedSpec);
    writeScenePath(currentScene, path, newElement, preparedRelationships);
    syncRenderProjectionNode(path, newElement);
    syncRenderProjectionRelationshipsForPath(currentScene, path);

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
    const preparedRelationships = prepareSceneRelationshipData(currentScene, relationships, newPath);
    const veToOverwrite = vesToOverwrite.get();
    const existingPath = VeFns.veToPath(veToOverwrite);
    const nextVe = createVisualElement(preparedSpec);

    const existingAttachments = VesCache.getAttachmentsVes(existingPath)();
    for (let i = 0; i < existingAttachments.length; ++i) {
      const attachmentVe = existingAttachments[i].get();
      const attachmentVePath = VeFns.veToPath(attachmentVe);
      if (sceneHasNode(currentScene, attachmentVePath)) {
        VesCache.removeByPath(attachmentVePath);
      }
    }

    if (!deleteSceneNode(currentScene, existingPath)) {
      throw "vesToOverwrite did not exist";
    }
    deleteFromVessVsDisplayIdLookup(currentScene, existingPath);
    deindexVisualElement(currentScene, existingPath, veToOverwrite);
    deleteSceneRelationships(currentScene.relationshipsByPath, existingPath);
    if (existingPath != newPath) {
      clearRenderProjectionForPath(existingPath);
      deleteRenderProjectionForPath(existingPath);
    }
    vesToOverwrite.set(cloneVisualElementSnapshot(nextVe));
    writeScenePath(currentScene, newPath, nextVe, preparedRelationships);
    syncRenderProjectionNode(newPath, nextVe, undefined, vesToOverwrite);
    syncRenderProjectionRelationshipsForPath(currentScene, newPath);

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
    deleteRenderProjectionForPath(path);

    deleteFromVessVsDisplayIdLookup(currentScene, path);
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

  getTableRenderRows: (path: VisualElementPath): Array<number> | null => {
    if (currentlyInFullArrange && sceneHasNode(underConstructionScene, path)) {
      return getUnderConstructionRenderTableRows(path);
    }
    return getCurrentRenderTableRows(path);
  },

  setTableRenderRows: (path: VisualElementPath, rows: Array<number> | null): void => {
    if (currentlyInFullArrange && sceneHasNode(underConstructionScene, path)) {
      setUnderConstructionRenderTableRows(path, rows);
      return;
    }
    setRenderProjectionTableRows(path, rows);
  },

  getTableVesRows: (path: VisualElementPath): Array<number> | null => {
    return VesCache.getTableRenderRows(path);
  },
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
