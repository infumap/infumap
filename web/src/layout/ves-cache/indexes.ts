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
import { Uid } from "../../util/uid";
import { VeFns, Veid, VisualElement, VisualElementPath } from "../visual-element";
import { SceneState } from "./state";

export function getScenePathsForDisplayId(scene: SceneState, displayId: Uid): Array<VisualElementPath> | undefined {
  return scene.vessVsDisplayId.get(displayId);
}

export function veidIndexKey(veid: Veid): string {
  return `${veid.itemId}\u0000${veid.linkIdMaybe ?? ""}`;
}

export function getSceneVeidMatchPaths(scene: SceneState, veid: Veid): Array<VisualElementPath> {
  return (scene.vessByVeid.get(veidIndexKey(veid)) ?? []).slice();
}

export function addIndexedScenePath(scene: SceneState, path: VisualElementPath, ve: VisualElement) {
  indexVisualElement(scene, path, ve);
  addScenePathForDisplayId(scene, ve.displayItem.id, path);
}

export function deindexVisualElement(scene: SceneState, path: VisualElementPath, ve: VisualElement) {
  removeFromIndex(scene.childrenByParent, ve.parentPath, path);
  removeFromIndex(scene.vessByVeid, veidIndexKeyFromPath(path), path);
}

export function deleteFromVessVsDisplayIdLookup(scene: SceneState, path: VisualElementPath) {
  const displayItemId = VeFns.itemIdFromPath(path);
  const ves = scene.vessVsDisplayId.get(displayItemId);
  if (!ves) {
    panic(`displayItemId ${displayItemId} is not in the displayItemId -> vesPath cache.`);
  }
  const foundIdx = ves.findIndex(v => v === path);
  if (foundIdx === -1) {
    panic(`path ${path} was not in the displayItemId -> vesPath cache.`);
  }
  ves.splice(foundIdx, 1);
  if (ves.length === 0 && !scene.vessVsDisplayId.delete(displayItemId)) {
    panic("logic error deleting displayItemId.");
  }
}

function addScenePathForDisplayId(scene: SceneState, displayId: Uid, path: VisualElementPath) {
  const existing = scene.vessVsDisplayId.get(displayId);
  if (!existing) {
    scene.vessVsDisplayId.set(displayId, [path]);
    return;
  }
  existing.push(path);
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

function indexVisualElement(scene: SceneState, path: VisualElementPath, ve: VisualElement) {
  if (ve.parentPath != null) {
    addToIndex(scene.childrenByParent, ve.parentPath, path);
  }
  addToIndex(scene.vessByVeid, veidIndexKeyFromPath(path), path);
}
