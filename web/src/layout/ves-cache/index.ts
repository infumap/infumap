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
import { StoreContextModel } from "../../store/StoreProvider";
import { panic } from "../../util/lang";
import { Uid } from "../../util/uid";
import { VisualElementSignal } from "../../util/signals";
import { VeFns, VisualElement, VisualElementPath, VisualElementRelationships, VisualElementSpec } from "../visual-element";
import {
  createProjectionOps,
} from "./projection";
import { createSceneOps } from "./core";
import { cloneVisualElementSnapshot, prepareVisualElementSpec } from "./spec";
import { createEmptySceneOutputs, createEmptySceneState, createEmptyVirtualSceneState, createVesCacheState } from "./state";

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

const vesCacheState = createVesCacheState();
const projectionOps = createProjectionOps(vesCacheState);
const sceneOps = createSceneOps(vesCacheState, projectionOps);
const {
  clearRenderProjectionForPath,
  deleteRenderProjectionForPath,
  getCurrentRenderTableRows,
  getUnderConstructionRenderTableRows,
  setRenderProjectionTableRows,
  setUnderConstructionRenderTableRows,
  updateRenderProjectionPopup,
} = projectionOps;
const {
  addSceneWatchContainerUid,
  createVisualElement,
  currentSceneQueries,
  deindexVisualElement,
  deleteFromVessVsDisplayIdLookup,
  deleteSceneNode,
  deleteSceneRelationships,
  ensureUnderConstructionArrangeSignal,
  getSceneNode,
  getScenePathsForDisplayId,
  maybeTrackLoadedContainer,
  prepareSceneRelationshipData,
  promoteCurrentScene,
  promoteVirtualScene,
  pushTopTitledPage,
  removeSceneWatchContainerUid,
  renderSceneQueries,
  sceneHasNode,
  syncRenderProjectionNode,
  syncRenderProjectionRelationshipsForPath,
  virtualSceneQueries,
  writePreparedUnderConstructionVisualElement,
  writeScenePath,
} = sceneOps;

export let VesCache = {

  /*
    Query facade over the committed scene graph: the last fully finalized
    arrange result that has been promoted to currentScene.

    Use this for non-rendering reads of layout structure and relationships when
    you want plain scene data, not Solid render signals.
  */
  current: currentSceneQueries,

  /*
    Query facade over the virtual scene snapshot: a separately stored arrange
    result copied from an under-construction scene for virtual/layout-only use,
    without replacing the live currentScene.
  */
  virtual: virtualSceneQueries,

  /*
    Query facade over the render projection.

    Use this for render-facing reads in component code when you need Solid
    signals/reactive accessors that drive the DOM, rather than plain scene data.
  */
  render: renderSceneQueries,

  /**
   * Re-initialize - clears all cached data.
   */
  clear: (): void => {
    vesCacheState.currentlyInFullArrange = false;
    vesCacheState.currentScene = createEmptySceneState();
    vesCacheState.currentSceneOutputs = createEmptySceneOutputs();
    vesCacheState.renderProjectionByPath = new Map();
    vesCacheState.virtualScene = createEmptyVirtualSceneState();
    vesCacheState.underConstructionScene = createEmptySceneState();
    vesCacheState.underConstructionArrangeSignalsByPath = new Map<VisualElementPath, VisualElementSignal>();
    vesCacheState.underConstructionRenderTableRowsByPath = new Map<VisualElementPath, Array<number>>();
    vesCacheState.underConstructionSceneOutputs = createEmptySceneOutputs();
  },

  getPathsForDisplayId: (displayId: Uid): Array<VisualElementPath> => {
    return getScenePathsForDisplayId(vesCacheState.currentScene, displayId)!;
  },

  addWatchContainerUid: (uid: Uid, origin: string | null): void => {
    addSceneWatchContainerUid(vesCacheState.currentSceneOutputs, uid, origin);
  },

  getCurrentWatchContainerUidsByOrigin: (): Map<string | null, Set<Uid>> => {
    return vesCacheState.currentSceneOutputs.watchContainerUidsByOrigin;
  },

  full_initArrange: (): void => {
    vesCacheState.currentlyInFullArrange = true;
    vesCacheState.underConstructionArrangeSignalsByPath = new Map<VisualElementPath, VisualElementSignal>();
    vesCacheState.underConstructionRenderTableRowsByPath = new Map<VisualElementPath, Array<number>>();
  },

  full_finalizeArrange: (store: StoreContextModel, umbrellaSpec: VisualElementSpec, umbrellaRelationships: VisualElementRelationships, umbrellaPath: VisualElementPath, virtualUmbrellaVes?: VisualElementSignal): void => {
    const preparedUmbrellaSpec = prepareVisualElementSpec(umbrellaSpec);
    const preparedUmbrellaRelationships = prepareSceneRelationshipData(vesCacheState.underConstructionScene, umbrellaRelationships, umbrellaPath);
    const umbrellaVe = virtualUmbrellaVes ? cloneVisualElementSnapshot(virtualUmbrellaVes.get()) : createVisualElement(preparedUmbrellaSpec);

    writeScenePath(vesCacheState.underConstructionScene, umbrellaPath, umbrellaVe, preparedUmbrellaRelationships);
    if (virtualUmbrellaVes) {
      promoteVirtualScene(vesCacheState.underConstructionScene);
    } else {
      store.umbrellaVisualElement.set(umbrellaVe);
      promoteCurrentScene(store, vesCacheState.underConstructionScene, vesCacheState.underConstructionSceneOutputs, vesCacheState.underConstructionRenderTableRowsByPath);
    }

    vesCacheState.underConstructionScene = createEmptySceneState();
    vesCacheState.underConstructionArrangeSignalsByPath = new Map<VisualElementPath, VisualElementSignal>();
    vesCacheState.underConstructionRenderTableRowsByPath = new Map<VisualElementPath, Array<number>>();
    vesCacheState.underConstructionSceneOutputs = createEmptySceneOutputs();

    vesCacheState.currentlyInFullArrange = false;
  },

  isCurrentlyInFullArrange: (): boolean => {
    return vesCacheState.currentlyInFullArrange;
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
    const preparedRelationships = prepareSceneRelationshipData(vesCacheState.underConstructionScene, relationships, path);
    writePreparedUnderConstructionVisualElement(preparedSpec, preparedRelationships, path);
  },

  /**
   * Writes the next under-construction scene node without per-node diffing and
   * returns an arrange-time signal view for call sites that still want one.
   */
  full_writeVisualElementSignal: (spec: VisualElementSpec, relationships: VisualElementRelationships, path: VisualElementPath): VisualElementSignal => {
    const preparedSpec = prepareVisualElementSpec(spec);
    const preparedRelationships = prepareSceneRelationshipData(vesCacheState.underConstructionScene, relationships, path);
    writePreparedUnderConstructionVisualElement(preparedSpec, preparedRelationships, path);
    return ensureUnderConstructionArrangeSignal(path) ?? panic(`failed to materialize under-construction arrange signal for ${path}.`);
  },

  /**
   * Create a new VisualElementSignal and insert it into the current cache.
   */
  partial_create: (spec: VisualElementSpec, relationships: VisualElementRelationships, path: VisualElementPath): VisualElementSignal => {
    const preparedSpec = prepareVisualElementSpec(spec);
    const preparedRelationships = prepareSceneRelationshipData(vesCacheState.currentScene, relationships, path);
    const newElement = createVisualElement(preparedSpec);
    writeScenePath(vesCacheState.currentScene, path, newElement, preparedRelationships);
    syncRenderProjectionNode(path, newElement);
    syncRenderProjectionRelationshipsForPath(vesCacheState.currentScene, path);

    maybeTrackLoadedContainer(vesCacheState.currentSceneOutputs, preparedSpec);

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
    const preparedRelationships = prepareSceneRelationshipData(vesCacheState.currentScene, relationships, newPath);
    const veToOverwrite = vesToOverwrite.get();
    const existingPath = VeFns.veToPath(veToOverwrite);
    const nextVe = createVisualElement(preparedSpec);

    const existingAttachments = renderSceneQueries.getAttachments(existingPath)();
    for (let i = 0; i < existingAttachments.length; ++i) {
      const attachmentVe = existingAttachments[i].get();
      const attachmentVePath = VeFns.veToPath(attachmentVe);
      if (sceneHasNode(vesCacheState.currentScene, attachmentVePath)) {
        VesCache.removeByPath(attachmentVePath);
      }
    }

    if (!deleteSceneNode(vesCacheState.currentScene, existingPath)) {
      throw new Error("vesToOverwrite did not exist");
    }
    deleteFromVessVsDisplayIdLookup(vesCacheState.currentScene, existingPath);
    deindexVisualElement(vesCacheState.currentScene, existingPath, veToOverwrite);
    deleteSceneRelationships(vesCacheState.currentScene.relationshipsByPath, existingPath);
    if (existingPath !== newPath) {
      clearRenderProjectionForPath(existingPath);
      deleteRenderProjectionForPath(existingPath);
    }
    vesToOverwrite.set(cloneVisualElementSnapshot(nextVe));
    writeScenePath(vesCacheState.currentScene, newPath, nextVe, preparedRelationships);
    syncRenderProjectionNode(newPath, nextVe, undefined, vesToOverwrite);
    syncRenderProjectionRelationshipsForPath(vesCacheState.currentScene, newPath);

    maybeTrackLoadedContainer(vesCacheState.currentSceneOutputs, preparedSpec);
  },

  removeByPath: (path: VisualElementPath): void => {
    const ve = getSceneNode(vesCacheState.currentScene, path);
    if (ve && isContainer(ve.displayItem) && asContainerItem(ve.displayItem).childrenLoaded) {
      removeSceneWatchContainerUid(vesCacheState.currentSceneOutputs, ve.displayItem.id, ve.displayItem.origin);
    }
    if (ve) {
      deindexVisualElement(vesCacheState.currentScene, path, ve);
    }
    if (!deleteSceneNode(vesCacheState.currentScene, path)) {
      panic(`item ${path} is not in ves cache.`);
    }
    deleteSceneRelationships(vesCacheState.currentScene.relationshipsByPath, path);
    clearRenderProjectionForPath(path);
    deleteRenderProjectionForPath(path);

    deleteFromVessVsDisplayIdLookup(vesCacheState.currentScene, path);
  },

  pushTopTitledPage: (vePath: VisualElementPath) => {
    pushTopTitledPage(vesCacheState.underConstructionSceneOutputs, vePath);
  },

  clearPopupVes: (path: VisualElementPath) => {
    const relationships = vesCacheState.currentScene.relationshipsByPath.get(path);
    if (relationships) {
      relationships.popup = null;
    }
    updateRenderProjectionPopup(path, null);
  },

  getTableRenderRows: (path: VisualElementPath): Array<number> | null => {
    if (vesCacheState.currentlyInFullArrange && sceneHasNode(vesCacheState.underConstructionScene, path)) {
      return getUnderConstructionRenderTableRows(path);
    }
    return getCurrentRenderTableRows(path);
  },

  setTableRenderRows: (path: VisualElementPath, rows: Array<number> | null): void => {
    if (vesCacheState.currentlyInFullArrange && sceneHasNode(vesCacheState.underConstructionScene, path)) {
      setUnderConstructionRenderTableRows(path, rows);
      return;
    }
    setRenderProjectionTableRows(path, rows);
  },

}
