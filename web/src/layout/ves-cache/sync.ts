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

import { StoreContextModel } from "../../store/StoreProvider";
import { createVisualElementSignal, VisualElementSignal } from "../../util/signals";
import { VisualElement, VisualElementPath } from "../visual-element";
import { ProjectionOps } from "./projection";
import { cloneVisualElementSnapshot } from "./spec";
import { createEmptyVirtualSceneState, SceneOutputs, SceneRelationshipData, SceneState, VesCacheState, VirtualSceneState } from "./state";

export function createSceneSyncOps(
  state: VesCacheState,
  projection: ProjectionOps,
  getSceneNode: (scene: SceneState, path: VisualElementPath) => VisualElement | undefined,
  sceneHasNode: (scene: SceneState, path: VisualElementPath) => boolean,
  resolveSceneNodePath: (scene: SceneState, path: VisualElementPath | null | undefined) => VisualElementSignal | null,
  resolveSceneNodePaths: (scene: SceneState, paths: Array<VisualElementPath> | undefined) => Array<VisualElementSignal>,
) {
  function getRenderNode(path: VisualElementPath): VisualElementSignal | undefined {
    const entry = projection.findRenderProjection(path);
    if (!entry) {
      return undefined;
    }
    return projection.readRenderProjectionSignal(entry.node);
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

  return {
    syncRenderProjectionNode,
    syncRenderProjectionRelationshipsForPath,
    promoteVirtualScene,
    promoteCurrentScene,
  };
}
