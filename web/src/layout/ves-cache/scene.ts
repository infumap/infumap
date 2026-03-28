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

import { VisualElementSignal, createVisualElementSignal } from "../../util/signals";
import { VeFns, VisualElement, VisualElementPath, VisualElementSpec } from "../visual-element";
import {
  addIndexedScenePath,
  deindexVisualElement,
  deleteFromVessVsDisplayIdLookup,
  getScenePathsForDisplayId,
} from "./indexes";
import { addSceneWatchContainerUid, maybeTrackLoadedContainer, pushTopTitledPage, removeSceneWatchContainerUid } from "./outputs";
import { ProjectionOps } from "./projection";
import { createSceneQueryOps } from "./queries";
import { createRelationshipOps, sceneRelationshipDataEqual } from "./relationships";
import { cloneVisualElementSnapshot, visualElementMatchesPreparedSpec } from "./spec";
import { createSceneSyncOps } from "./sync";
import {
  SceneRelationshipData,
  SceneRelationshipsByPath,
  SceneState,
  VesCacheState,
} from "./state";

export function createSceneOps(state: VesCacheState, projection: ProjectionOps) {
  function createVisualElement(spec: VisualElementSpec): VisualElement {
    return VeFns.create(spec);
  }

  function getSceneNode(scene: SceneState, path: VisualElementPath): VisualElement | undefined {
    return scene.cache.get(path);
  }

  const relationshipOps = createRelationshipOps(state, getSceneNode);
  const {
    deleteSceneRelationships,
    prepareSceneRelationshipData,
  } = relationshipOps;

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

  function ensureCurrentRenderNode(path: VisualElementPath): VisualElementSignal | null {
    const entry = projection.findRenderProjection(path);
    const existing = entry ? projection.readRenderProjectionSignal(entry.node) : undefined;
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

  function writeSceneRelationshipData(
    relationshipsByPath: SceneRelationshipsByPath,
    path: VisualElementPath,
    relationshipData: SceneRelationshipData,
  ) {
    relationshipsByPath.set(path, relationshipData);
  }

  const queryOps = createSceneQueryOps(state, projection, {
    getSceneNode,
    getSceneParentPath,
    resolveSceneNodePath,
    resolveSceneNodePaths,
  });
  const {
    currentSceneQueries,
    virtualSceneQueries,
    renderSceneQueries,
  } = queryOps;

  const syncOps = createSceneSyncOps(state, projection, {
    getSceneNode,
    sceneHasNode,
    resolveSceneNodePath,
    resolveSceneNodePaths,
  });
  const {
    promoteCurrentScene,
    promoteVirtualScene,
    syncRenderProjectionNode,
    syncRenderProjectionRelationshipsForPath,
  } = syncOps;

  return {
    maybeTrackLoadedContainer,
    createVisualElement,
    getSceneNode,
    deleteSceneNode,
    sceneHasNode,
    getScenePathsForDisplayId,
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
