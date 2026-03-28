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

import { asContainerItem, isContainer } from "../../items/base/container-item";
import { Item } from "../../items/base/item";
import { StoreContextModel } from "../../store/StoreProvider";
import { panic } from "../../util/lang";
import { VisualElementSignal, createVisualElementSignal } from "../../util/signals";
import { Uid } from "../../util/uid";
import { VeFns, Veid, VisualElement, VisualElementFlags, VisualElementPath, VisualElementRelationships, VisualElementSpec } from "../visual-element";
import {
  addIndexedScenePath,
  deindexVisualElement,
  deleteFromVessVsDisplayIdLookup,
  getScenePathsForDisplayId,
  getSceneVeidMatchPaths,
  veidIndexKey,
} from "./indexes";
import { ProjectionOps } from "./projection";
import { cloneVisualElementSnapshot, visualElementMatchesPreparedSpec } from "./spec";
import {
  createEmptyVirtualSceneState,
  SceneOutputs,
  SceneRelationshipData,
  SceneRelationshipsByPath,
  SceneState,
  VesCacheState,
  VirtualSceneState,
} from "./state";

export type SceneOps = ReturnType<typeof createSceneOps>;

export function createSceneOps(state: VesCacheState, projection: ProjectionOps) {
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

  function resolveSceneNodePath(scene: SceneState, path: VisualElementPath | null | undefined): VisualElementSignal | null {
    if (path == null) {
      return null;
    }
    if (scene === state.currentScene) {
      return ensureCurrentRenderNode(path);
    }
    if (scene === state.underConstructionScene) {
      return ensureUnderConstructionArrangeSignal(path);
    }
    return null;
  }

  function resolveSceneNodePaths(scene: SceneState, paths: Array<VisualElementPath> | undefined): Array<VisualElementSignal> {
    const resolved: Array<VisualElementSignal> = [];
    if (scene === state.currentScene) {
      for (const path of paths ?? []) {
        const node = ensureCurrentRenderNode(path);
        if (node) {
          resolved.push(node);
        }
      }
      return resolved;
    }
    if (scene === state.underConstructionScene) {
      for (const path of paths ?? []) {
        const node = ensureUnderConstructionArrangeSignal(path);
        if (node) {
          resolved.push(node);
        }
      }
    }
    return resolved;
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
      .filter(ves => VeFns.veToPath(ves.get()) !== path);
  }

  function getSceneDisplayItemFingerprint(scene: SceneState, path: VisualElementPath): string | undefined {
    return getSceneNode(scene, path)?.displayItemFingerprint;
  }

  function getRenderNode(path: VisualElementPath): VisualElementSignal | undefined {
    const entry = projection.findRenderProjection(path);
    if (!entry) {
      return undefined;
    }
    return projection.readRenderProjectionSignal(entry.node);
  }

  function ensureCurrentRenderNode(path: VisualElementPath): VisualElementSignal | null {
    const existing = getRenderNode(path);
    if (existing) {
      return existing;
    }
    const currentVe = getSceneNode(state.currentScene, path);
    if (!currentVe) {
      return null;
    }
    const signal = createVisualElementSignal(cloneVisualElementSnapshot(currentVe));
    projection.updateRenderProjectionNode(path, signal);
    return signal;
  }

  function syncUnderConstructionArrangeSignal(path: VisualElementPath, ve: VisualElement) {
    const signal = state.underConstructionArrangeSignalsByPath.get(path);
    if (!signal) {
      return;
    }
    signal.set(cloneVisualElementSnapshot(ve));
  }

  function ensureUnderConstructionArrangeSignal(path: VisualElementPath): VisualElementSignal | null {
    const existing = state.underConstructionArrangeSignalsByPath.get(path);
    if (existing) {
      return existing;
    }
    const ve = getSceneNode(state.underConstructionScene, path);
    if (!ve) {
      return null;
    }
    const signal = createVisualElementSignal(cloneVisualElementSnapshot(ve));
    state.underConstructionArrangeSignalsByPath.set(path, signal);
    return signal;
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
      const node = state.virtualScene.cache.get(path);
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
      .filter(ve => VeFns.veToPath(ve) !== path);
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
    return state.virtualScene.cache.get(path);
  }

  function readVirtualSceneIndexedChildren(parentPath: VisualElementPath): Array<VisualElement> {
    return readVirtualNodePaths(state.virtualScene.childrenByParent.get(parentPath));
  }

  function readVirtualSceneStructuralChildren(parentPath: VisualElementPath): Array<VisualElement> {
    return readVirtualNodePaths(state.virtualScene.relationshipsByPath.get(parentPath)?.children);
  }

  function readVirtualSceneSiblings(path: VisualElementPath): Array<VisualElement> {
    const parentPath = readVirtualSceneNode(path)?.parentPath ?? VeFns.parentPath(path) ?? null;
    if (parentPath == null) {
      return [];
    }
    return readVirtualSceneIndexedChildren(parentPath)
      .filter(ve => VeFns.veToPath(ve) !== path);
  }

  function readVirtualSceneVeidMatches(veid: Veid): Array<VisualElement> {
    return readVirtualNodePaths(state.virtualScene.vessByVeid.get(veidIndexKey(veid)));
  }

  function findCurrentSceneMatches(veid: Veid): Array<VisualElementSignal> {
    const result: Array<VisualElementSignal> = [];
    const seenPaths = new Set<VisualElementPath>();
    for (const path of getSceneVeidMatchPaths(state.underConstructionScene, veid)) {
      const ves = resolveSceneNodePath(state.underConstructionScene, path);
      if (ves && !seenPaths.has(path)) {
        seenPaths.add(path);
        result.push(ves);
      }
    }
    for (const path of getSceneVeidMatchPaths(state.currentScene, veid)) {
      const ves = resolveSceneNodePath(state.currentScene, path);
      if (ves && !seenPaths.has(path)) {
        seenPaths.add(path);
        result.push(ves);
      }
    }
    return result;
  }

  function findSingleCurrentSceneMatch(veid: Veid): VisualElementSignal {
    const underConstructionMatches = getSceneVeidMatchPaths(state.underConstructionScene, veid);
    if (underConstructionMatches.length > 1) {
      throw new Error(`multiple visual elements found: ${veid.itemId}/${veid.linkIdMaybe}.`);
    }
    if (underConstructionMatches.length === 1) {
      return resolveSceneNodePath(state.underConstructionScene, underConstructionMatches[0]) ?? panic(`${veid.itemId}/${veid.linkIdMaybe} missing under-construction arrange signal.`);
    }
    const currentMatches = getSceneVeidMatchPaths(state.currentScene, veid);
    if (currentMatches.length > 1) {
      throw new Error(`multiple visual elements found: ${veid.itemId}/${veid.linkIdMaybe}.`);
    }
    if (currentMatches.length === 0) {
      throw new Error(`${veid.itemId}/${veid.linkIdMaybe} not present in VesCache.`);
    }
    return resolveSceneNodePath(state.currentScene, currentMatches[0]) ?? panic(`${veid.itemId}/${veid.linkIdMaybe} missing render node signal.`);
  }

  function writeScenePath(
    scene: SceneState,
    path: VisualElementPath,
    ve: VisualElement,
    relationshipData: SceneRelationshipData,
  ) {
    setSceneNode(scene, path, ve);
    writeSceneRelationshipData(scene.relationshipsByPath, path, relationshipData);
    addIndexedScenePath(scene, path, ve);
  }

  function writeUnderConstructionSceneNode(
    path: VisualElementPath,
    ve: VisualElement,
    relationshipData: SceneRelationshipData,
  ) {
    writeScenePath(state.underConstructionScene, path, ve, reuseSceneRelationshipDataIfEqual(path, relationshipData));
    syncUnderConstructionArrangeSignal(path, ve);
  }

  function writePreparedUnderConstructionVisualElement(
    preparedSpec: VisualElementSpec,
    preparedRelationships: SceneRelationshipData,
    path: VisualElementPath,
  ): VisualElement {
    maybeTrackLoadedContainer(state.underConstructionSceneOutputs, preparedSpec);
    const existingVe = getSceneNode(state.currentScene, path);
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
    const existing = state.currentScene.relationshipsByPath.get(path);
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
      projection.updateRenderProjectionNode(path, undefined);
      return;
    }

    if (preferredSignal) {
      projection.updateRenderProjectionNode(path, preferredSignal);
      return;
    }

    let signal = getRenderNode(path);
    if (!signal) {
      signal = createVisualElementSignal(cloneVisualElementSnapshot(nextVe));
      projection.updateRenderProjectionNode(path, signal);
      return;
    }

    if (previousVe === nextVe) {
      projection.updateRenderProjectionNode(path, signal);
      return;
    }

    signal.set(cloneVisualElementSnapshot(nextVe));
    projection.updateRenderProjectionNode(path, signal);
  }

  function syncRenderProjectionRelationshipsForPath(
    scene: SceneState,
    path: VisualElementPath,
    previousRelationships?: SceneRelationshipData,
    renderTableRows?: Array<number> | null,
  ) {
    const relationships = scene.relationshipsByPath.get(path);
    if (relationships === previousRelationships) {
      projection.setRenderProjectionTableRows(path, renderTableRows ?? null);
      return;
    }
    const popup = resolveSceneNodePath(scene, relationships?.popup);
    projection.updateRenderProjectionPopup(path, popup);
    const selected = resolveSceneNodePath(scene, relationships?.selected);
    projection.updateRenderProjectionSelected(path, selected);
    const dock = resolveSceneNodePath(scene, relationships?.dock);
    projection.updateRenderProjectionDock(path, dock);
    const attachments = resolveSceneNodePaths(scene, relationships?.attachments);
    projection.updateRenderProjectionAttachments(path, attachments);
    const children = resolveSceneNodePaths(scene, relationships?.children);
    projection.updateRenderProjectionChildren(path, children);
    const lineChildren = resolveSceneNodePaths(scene, relationships?.lineChildren);
    projection.updateRenderProjectionLineChildren(path, lineChildren);
    const desktopChildren = resolveSceneNodePaths(scene, relationships?.desktopChildren);
    projection.updateRenderProjectionDesktopChildren(path, desktopChildren);
    const nonMovingChildren = resolveSceneNodePaths(scene, relationships?.nonMovingChildren);
    projection.updateRenderProjectionNonMovingChildren(path, nonMovingChildren);
    const focusedChild = relationships?.focusedChildItemMaybe ?? null;
    projection.updateRenderProjectionFocused(path, focusedChild);
    projection.setRenderProjectionTableRows(path, renderTableRows ?? null);
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

    const previousRelationships = state.currentScene.relationshipsByPath.get(path);
    if (!previousRelationships || !arraysShallowEqual(previousRelationships.children, childPaths)) {
      return null;
    }

    for (const childPath of childPaths) {
      if (getSceneNode(scene, childPath) !== getSceneNode(state.currentScene, childPath)) {
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
        projection.deleteRenderProjectionForPath(path);
      }
    }

    for (const [path] of scene.cache) {
      syncRenderProjectionNode(
        path,
        getSceneNode(scene, path),
        previousScene.cache.get(path),
        previousScene.cache.has(path) ? undefined : state.underConstructionArrangeSignalsByPath.get(path),
      );
    }

    for (const [path] of scene.cache) {
      syncRenderProjectionRelationshipsForPath(
        scene,
        path,
        previousScene.relationshipsByPath.get(path),
        renderTableRowsByPath?.get(path) ?? null,
      );
    }
  }

  function promoteVirtualScene(scene: SceneState) {
    state.virtualScene = snapshotVirtualScene(scene);
  }

  function promoteCurrentScene(
    store: StoreContextModel,
    scene: SceneState,
    outputs: SceneOutputs,
    renderTableRowsByPath?: Map<VisualElementPath, Array<number>>,
  ) {
    const previousScene = state.currentScene;
    state.currentScene = scene;
    state.currentSceneOutputs = outputs;
    store.topTitledPages.set(outputs.topTitledPages);
    syncRenderProjectionFromScene(previousScene, scene, renderTableRowsByPath);
  }

  const currentSceneQueries = {
    getNode: (path: VisualElementPath): VisualElementSignal | undefined => {
      return ensureCurrentRenderNode(path) ?? undefined;
    },

    readNode: (path: VisualElementPath): VisualElement | undefined => {
      return readSceneNode(state.currentScene, path);
    },

    getIndexedChildren: (parentPath: VisualElementPath): Array<VisualElementSignal> => {
      return getSceneIndexedChildren(state.currentScene, parentPath);
    },

    readIndexedChildren: (parentPath: VisualElementPath): Array<VisualElement> => {
      return readSceneIndexedChildren(state.currentScene, parentPath);
    },

    getStructuralChildren: (parentPath: VisualElementPath): Array<VisualElementSignal> => {
      return getSceneStructuralChildren(state.currentScene, parentPath);
    },

    readStructuralChildren: (parentPath: VisualElementPath): Array<VisualElement> => {
      return readSceneStructuralChildren(state.currentScene, parentPath);
    },

    getSiblings: (path: VisualElementPath): Array<VisualElementSignal> => {
      return getSceneSiblings(state.currentScene, path);
    },

    readSiblings: (path: VisualElementPath): Array<VisualElement> => {
      return readSceneSiblings(state.currentScene, path);
    },

    readAttachments: (path: VisualElementPath): Array<VisualElement> => {
      return readSceneAttachments(state.currentScene, path);
    },

    readPopup: (path: VisualElementPath): VisualElement | null => {
      return readScenePopup(state.currentScene, path);
    },

    readSelected: (path: VisualElementPath): VisualElement | null => {
      return readSceneSelected(state.currentScene, path);
    },

    readDock: (path: VisualElementPath): VisualElement | null => {
      return readSceneDock(state.currentScene, path);
    },

    find: (veid: Veid): Array<VisualElementSignal> => {
      return findCurrentSceneMatches(veid);
    },

    findNodes: (veid: Veid): Array<VisualElement> => {
      return readSceneNodePaths(state.currentScene, state.currentScene.vessByVeid.get(veidIndexKey(veid)));
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
      return projection.ensureRenderProjectionSignal(projection.getRenderProjection(path).node)[0]();
    },

    find: (veid: Veid): Array<VisualElementSignal> => {
      return findCurrentSceneMatches(veid);
    },

    findSingle: (veid: Veid): VisualElementSignal => {
      return findSingleCurrentSceneMatch(veid);
    },

    getAttachments: (path: VisualElementPath) => {
      return projection.ensureRenderProjectionSignal(projection.getRenderProjection(path).attachments)[0];
    },

    getPopup: (path: VisualElementPath) => {
      return projection.ensureRenderProjectionSignal(projection.getRenderProjection(path).popup)[0];
    },

    getSelected: (path: VisualElementPath) => {
      return projection.ensureRenderProjectionSignal(projection.getRenderProjection(path).selected)[0];
    },

    getDock: (path: VisualElementPath) => {
      return projection.ensureRenderProjectionSignal(projection.getRenderProjection(path).dock)[0];
    },

    getChildren: (path: VisualElementPath) => {
      return projection.ensureRenderProjectionSignal(projection.getRenderProjection(path).children)[0];
    },

    getLineChildren: (path: VisualElementPath) => {
      return projection.ensureRenderProjectionSignal(projection.getRenderProjection(path).lineChildren)[0];
    },

    getDesktopChildren: (path: VisualElementPath) => {
      return projection.ensureRenderProjectionSignal(projection.getRenderProjection(path).desktopChildren)[0];
    },

    getNonMovingChildren: (path: VisualElementPath) => {
      return projection.ensureRenderProjectionSignal(projection.getRenderProjection(path).nonMovingChildren)[0];
    },

    getFocusedChild: (path: VisualElementPath) => {
      return projection.ensureRenderProjectionSignal(projection.getRenderProjection(path).focused)[0];
    },
  };

  return {
    maybeTrackLoadedContainer,
    createVisualElement,
    getSceneNode,
    deleteSceneNode,
    sceneHasNode,
    getScenePathsForDisplayId,
    getSceneDisplayItemFingerprint,
    ensureUnderConstructionArrangeSignal,
    writePreparedUnderConstructionVisualElement,
    prepareSceneRelationshipData,
    writeScenePath,
    deindexVisualElement,
    deleteSceneRelationships,
    syncRenderProjectionNode,
    syncRenderProjectionRelationshipsForPath,
    addSceneWatchContainerUid,
    pushTopTitledPage,
    removeSceneWatchContainerUid,
    promoteVirtualScene,
    promoteCurrentScene,
    currentSceneQueries,
    virtualSceneQueries,
    renderSceneQueries,
    deleteFromVessVsDisplayIdLookup,
  };
}
