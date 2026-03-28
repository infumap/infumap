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

import { panic } from "../../util/lang";
import { VisualElementSignal } from "../../util/signals";
import { VeFns, Veid, VisualElement, VisualElementPath } from "../visual-element";
import { getSceneVeidMatchPaths, veidIndexKey } from "./indexes";
import { ProjectionOps } from "./projection";
import { SceneState, VesCacheState } from "./state";

type QueryDeps = {
  getSceneNode: (scene: SceneState, path: VisualElementPath) => VisualElement | undefined;
  getSceneParentPath: (scene: SceneState, path: VisualElementPath) => VisualElementPath | null;
  resolveSceneNodePath: (scene: SceneState, path: VisualElementPath | null | undefined) => VisualElementSignal | null;
  resolveSceneNodePaths: (scene: SceneState, paths: Array<VisualElementPath> | undefined) => Array<VisualElementSignal>;
};

export type QueryOps = ReturnType<typeof createSceneQueryOps>;

export function createSceneQueryOps(state: VesCacheState, projection: ProjectionOps, deps: QueryDeps) {
  function getSceneIndexedChildren(scene: SceneState, parentPath: VisualElementPath): Array<VisualElementSignal> {
    return deps.resolveSceneNodePaths(scene, scene.childrenByParent.get(parentPath));
  }

  function getSceneStructuralChildren(scene: SceneState, parentPath: VisualElementPath): Array<VisualElementSignal> {
    return deps.resolveSceneNodePaths(scene, scene.relationshipsByPath.get(parentPath)?.children);
  }

  function getSceneSiblings(scene: SceneState, path: VisualElementPath): Array<VisualElementSignal> {
    const parentPath = deps.getSceneParentPath(scene, path);
    if (parentPath == null) {
      return [];
    }
    return getSceneIndexedChildren(scene, parentPath)
      .filter(ves => VeFns.veToPath(ves.get()) !== path);
  }

  function readSceneNodePath(scene: SceneState, path: VisualElementPath | null | undefined): VisualElement | null {
    if (path == null) {
      return null;
    }
    return deps.getSceneNode(scene, path) ?? null;
  }

  function readSceneNodePaths(scene: SceneState, paths: Array<VisualElementPath> | undefined): Array<VisualElement> {
    const resolved: Array<VisualElement> = [];
    for (const path of paths ?? []) {
      const node = deps.getSceneNode(scene, path);
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

  function readSceneIndexedChildren(scene: SceneState, parentPath: VisualElementPath): Array<VisualElement> {
    return readSceneNodePaths(scene, scene.childrenByParent.get(parentPath));
  }

  function readSceneStructuralChildren(scene: SceneState, parentPath: VisualElementPath): Array<VisualElement> {
    return readSceneNodePaths(scene, scene.relationshipsByPath.get(parentPath)?.children);
  }

  function readSceneSiblings(scene: SceneState, path: VisualElementPath): Array<VisualElement> {
    const parentPath = deps.getSceneParentPath(scene, path);
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
      const ves = deps.resolveSceneNodePath(state.underConstructionScene, path);
      if (ves && !seenPaths.has(path)) {
        seenPaths.add(path);
        result.push(ves);
      }
    }
    for (const path of getSceneVeidMatchPaths(state.currentScene, veid)) {
      const ves = deps.resolveSceneNodePath(state.currentScene, path);
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
      return deps.resolveSceneNodePath(state.underConstructionScene, underConstructionMatches[0]) ?? panic(`${veid.itemId}/${veid.linkIdMaybe} missing under-construction arrange signal.`);
    }
    const currentMatches = getSceneVeidMatchPaths(state.currentScene, veid);
    if (currentMatches.length > 1) {
      throw new Error(`multiple visual elements found: ${veid.itemId}/${veid.linkIdMaybe}.`);
    }
    if (currentMatches.length === 0) {
      throw new Error(`${veid.itemId}/${veid.linkIdMaybe} not present in VesCache.`);
    }
    return deps.resolveSceneNodePath(state.currentScene, currentMatches[0]) ?? panic(`${veid.itemId}/${veid.linkIdMaybe} missing render node signal.`);
  }

  const currentSceneQueries = {
    getNode: (path: VisualElementPath): VisualElementSignal | undefined => {
      return deps.resolveSceneNodePath(state.currentScene, path) ?? undefined;
    },

    readNode: (path: VisualElementPath): VisualElement | undefined => {
      return deps.getSceneNode(state.currentScene, path);
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
    currentSceneQueries,
    virtualSceneQueries,
    renderSceneQueries,
  };
}
