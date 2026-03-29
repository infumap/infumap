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
import { ReactiveOps } from "./reactive";
import { cloneVisualElementSnapshot } from "./spec";
import { createEmptyVirtualSceneState, SceneOutputs, SceneRelationshipData, SceneState, VesCacheState, VirtualSceneState } from "./state";

export function createSceneSyncOps(
  state: VesCacheState,
  reactive: ReactiveOps,
  getSceneNode: (scene: SceneState, path: VisualElementPath) => VisualElement | undefined,
  sceneHasNode: (scene: SceneState, path: VisualElementPath) => boolean,
  resolveSceneNodePath: (scene: SceneState, path: VisualElementPath | null | undefined) => VisualElementSignal | null,
  resolveSceneNodePaths: (scene: SceneState, paths: Array<VisualElementPath> | undefined) => Array<VisualElementSignal>,
) {
  function getReactiveNode(path: VisualElementPath): VisualElementSignal | undefined {
    const entry = reactive.findReactiveEntry(path);
    if (!entry) {
      return undefined;
    }
    return reactive.readReactiveSignal(entry.node);
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

  function syncReactiveNode(
    path: VisualElementPath,
    nextVe: VisualElement | undefined,
    previousVe?: VisualElement,
    preferredSignal?: VisualElementSignal,
  ) {
    if (!nextVe) {
      reactive.updateReactiveNode(path, undefined);
      return;
    }

    if (preferredSignal) {
      reactive.updateReactiveNode(path, preferredSignal);
      return;
    }

    let signal = getReactiveNode(path);
    if (!signal) {
      signal = createVisualElementSignal(cloneVisualElementSnapshot(nextVe));
      reactive.updateReactiveNode(path, signal);
      return;
    }

    if (previousVe === nextVe) {
      reactive.updateReactiveNode(path, signal);
      return;
    }

    signal.set(cloneVisualElementSnapshot(nextVe));
    reactive.updateReactiveNode(path, signal);
  }

  function syncReactiveRelationshipsForPath(
    scene: SceneState,
    path: VisualElementPath,
    previousRelationships?: SceneRelationshipData,
    renderTableRows?: Array<number> | null,
  ) {
    const relationships = scene.relationshipsByPath.get(path);
    if (relationships === previousRelationships) {
      reactive.setReactiveTableRows(path, renderTableRows ?? null);
      return;
    }
    const popup = resolveSceneNodePath(scene, relationships?.popup);
    reactive.updateReactivePopup(path, popup);
    const selected = resolveSceneNodePath(scene, relationships?.selected);
    reactive.updateReactiveSelected(path, selected);
    const dock = resolveSceneNodePath(scene, relationships?.dock);
    reactive.updateReactiveDock(path, dock);
    const attachments = resolveSceneNodePaths(scene, relationships?.attachments);
    reactive.updateReactiveAttachments(path, attachments);
    const children = resolveSceneNodePaths(scene, relationships?.children);
    reactive.updateReactiveChildren(path, children);
    const lineChildren = resolveSceneNodePaths(scene, relationships?.lineChildren);
    reactive.updateReactiveLineChildren(path, lineChildren);
    const desktopChildren = resolveSceneNodePaths(scene, relationships?.desktopChildren);
    reactive.updateReactiveDesktopChildren(path, desktopChildren);
    const nonMovingChildren = resolveSceneNodePaths(scene, relationships?.nonMovingChildren);
    reactive.updateReactiveNonMovingChildren(path, nonMovingChildren);
    const focusedChild = relationships?.focusedChildItemMaybe ?? null;
    reactive.updateReactiveFocused(path, focusedChild);
    reactive.setReactiveTableRows(path, renderTableRows ?? null);
  }

  function syncReactiveFromScene(
    previousScene: SceneState,
    scene: SceneState,
    renderTableRowsByPath?: Map<VisualElementPath, Array<number>>,
  ) {
    for (const [path] of previousScene.cache) {
      if (!sceneHasNode(scene, path)) {
        reactive.deleteReactiveForPath(path);
      }
    }

    for (const [path] of scene.cache) {
      syncReactiveNode(
        path,
        getSceneNode(scene, path),
        previousScene.cache.get(path),
        previousScene.cache.has(path) ? undefined : state.underConstructionArrangeSignalsByPath.get(path),
      );
    }

    for (const [path] of scene.cache) {
      syncReactiveRelationshipsForPath(
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
    syncReactiveFromScene(previousScene, scene, renderTableRowsByPath);
  }

  return {
    syncReactiveNode,
    syncReactiveRelationshipsForPath,
    promoteVirtualScene,
    promoteCurrentScene,
  };
}
