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

import { VisualElementSignal } from "../../util/signals";
import { VeFns, VisualElement, VisualElementFlags, VisualElementPath, VisualElementRelationships } from "../visual-element";
import { SceneRelationshipData, SceneRelationshipsByPath, SceneState, VesCacheState } from "./state";

export type RelationshipOps = ReturnType<typeof createRelationshipOps>;

export function sceneRelationshipDataEqual(a: SceneRelationshipData, b: SceneRelationshipData): boolean {
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

export function createRelationshipOps(
  state: VesCacheState,
  getSceneNode: (scene: SceneState, path: VisualElementPath) => VisualElement | undefined,
) {
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

  function deleteSceneRelationships(relationshipsByPath: SceneRelationshipsByPath, path: VisualElementPath) {
    relationshipsByPath.delete(path);
  }

  return {
    prepareSceneRelationshipData,
    deleteSceneRelationships,
  };
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

function toSceneRelationshipPath(node: VisualElementSignal | null | undefined): VisualElementPath | null {
  return node ? VeFns.veToPath(node.get()) : null;
}

function toSceneRelationshipPaths(nodes: Array<VisualElementSignal> | undefined): Array<VisualElementPath> {
  return (nodes ?? []).map(node => VeFns.veToPath(node.get()));
}
