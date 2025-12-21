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

import { asContainerItem, isContainer } from "../items/base/container-item";
import { ItemFns } from "../items/base/item-polymorphism";
import { StoreContextModel } from "../store/StoreProvider";
import { compareBoundingBox, compareDimensions } from "../util/geometry";
import { panic } from "../util/lang";
import { VisualElementSignal, createVisualElementSignal } from "../util/signals";
import { Uid } from "../util/uid";
import { HitboxFns } from "./hitbox";
import { VeFns, Veid, VisualElement, VisualElementFlags, VisualElementPath, VisualElementSpec } from "./visual-element";

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

let currentVesCache = new Map<VisualElementPath, VisualElementSignal>();
let currentVessVsDisplayId = new Map<Uid, Array<VisualElementPath>>();
let currentTopTitledPages = new Array<VisualElementPath>();
let currentWatchContainerUidsByOrigin = new Map<string | null, Set<Uid>>();
let virtualCache = new Map<VisualElementPath, VisualElementSignal>();
let underConstructionCache = new Map<VisualElementPath, VisualElementSignal>();
let underConstructionVesVsDisplayItemId = new Map<Uid, Array<VisualElementPath>>();
let underConstructionTopTitledPages = new Array<VisualElementPath>();
let underConstructionWatchContainerUidsByOrigin = new Map<string | null, Set<Uid>>();

let evaluationRequired = new Set<VisualElementPath>();
let currentlyInFullArrange = false;

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

export let VesCache = {

  /**
   * Re-initialize - clears all cached data.
   */
  clear: (): void => {
    currentVesCache = new Map<VisualElementPath, VisualElementSignal>();
    currentVessVsDisplayId = new Map<Uid, Array<VisualElementPath>>();
    currentTopTitledPages = [];
    currentWatchContainerUidsByOrigin = new Map<string | null, Set<Uid>>();
    virtualCache = new Map<VisualElementPath, VisualElementSignal>();
    underConstructionCache = new Map<VisualElementPath, VisualElementSignal>();
    underConstructionVesVsDisplayItemId = new Map<Uid, Array<VisualElementPath>>();
    underConstructionTopTitledPages = [];
    underConstructionWatchContainerUidsByOrigin = new Map<string | null, Set<Uid>>();

    evaluationRequired = new Set<VisualElementPath>();
  },

  get: (path: VisualElementPath): VisualElementSignal | undefined => {
    return currentVesCache.get(path);
  },

  getVirtual: (path: VisualElementPath): VisualElementSignal | undefined => {
    return virtualCache.get(path);
  },

  getSiblings: (path: VisualElementPath): Array<VisualElementSignal> => {
    const commonPath = VeFns.parentPath(path);
    const result: Array<VisualElementSignal> = [];
    for (const kv of currentVesCache.entries()) {
      if (VeFns.parentPath(kv[0]) == commonPath && kv[0] != path) {
        result.push(kv[1]);
      }
    }
    return result;
  },

  getSiblingsVirtual: (path: VisualElementPath): Array<VisualElementSignal> => {
    const commonPath = VeFns.parentPath(path);
    const result: Array<VisualElementSignal> = [];
    for (const kv of virtualCache.entries()) {
      if (VeFns.parentPath(kv[0]) == commonPath && kv[0] != path) {
        result.push(kv[1]);
      }
    }
    return result;
  },

  getPathsForDisplayId: (displayId: Uid): Array<VisualElementPath> => {
    return currentVessVsDisplayId.get(displayId)!;
  },

  addWatchContainerUid: (uid: Uid, origin: string | null): void => {
    if (!currentWatchContainerUidsByOrigin.has(origin)) {
      currentWatchContainerUidsByOrigin.set(origin, new Set<Uid>());
    }
    currentWatchContainerUidsByOrigin.get(origin)!.add(uid);
  },

  getCurrentWatchContainerUidsByOrigin: (): Map<string | null, Set<Uid>> => {
    return currentWatchContainerUidsByOrigin;
  },

  full_initArrange: (): void => {
    evaluationRequired = new Set<VisualElementPath>();
    currentlyInFullArrange = true;
  },

  full_finalizeArrange: (store: StoreContextModel, umbrellaVeSpec: VisualElementSpec, umbrellaPath: VisualElementPath, virtualUmbrellaVes?: VisualElementSignal): void => {
    if (umbrellaVeSpec.displayItemFingerprint) { panic("displayItemFingerprint is already set."); }
    umbrellaVeSpec.displayItemFingerprint = ItemFns.getFingerprint(umbrellaVeSpec.displayItem); // TODO (LOW): Modifying the input object is a bit nasty.

    if (virtualUmbrellaVes) {
      underConstructionCache.set(umbrellaPath, virtualUmbrellaVes);
      virtualCache = underConstructionCache;
    } else {
      underConstructionCache.set(umbrellaPath, store.umbrellaVisualElement);  // TODO (MEDIUM): full property reconciliation, to avoid this update.
      store.umbrellaVisualElement.set(VeFns.create(umbrellaVeSpec));
      currentVesCache = underConstructionCache;
      currentVessVsDisplayId = underConstructionVesVsDisplayItemId;
      currentTopTitledPages = underConstructionTopTitledPages;
      currentWatchContainerUidsByOrigin = underConstructionWatchContainerUidsByOrigin;
      store.topTitledPages.set(currentTopTitledPages);
      logOrphanedVes(currentVesCache, "full_finalizeArrange");
    }

    underConstructionCache = new Map<VisualElementPath, VisualElementSignal>();
    underConstructionVesVsDisplayItemId = new Map<Uid, Array<VisualElementPath>>();
    underConstructionTopTitledPages = [];
    underConstructionWatchContainerUidsByOrigin = new Map<string | null, Set<Uid>>();
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
  full_createOrRecycleVisualElementSignal: (visualElementOverride: VisualElementSpec, path: VisualElementPath): VisualElementSignal => {
    return createOrRecycleVisualElementSignalImpl(visualElementOverride, path);
  },

  /**
   * Create a new VisualElementSignal and insert it into the current cache.
   */
  partial_create: (visualElementOverride: VisualElementSpec, path: VisualElementPath): VisualElementSignal => {
    const newElement = createVisualElementSignal(VeFns.create(visualElementOverride));
    currentVesCache.set(path, newElement);
    if (isContainer(visualElementOverride.displayItem) &&
      (visualElementOverride.flags! & VisualElementFlags.ShowChildren) &&
      asContainerItem(visualElementOverride.displayItem).childrenLoaded) {
      const origin = visualElementOverride.displayItem.origin;
      if (!currentWatchContainerUidsByOrigin.has(origin)) {
        currentWatchContainerUidsByOrigin.set(origin, new Set<Uid>());
      }
      currentWatchContainerUidsByOrigin.get(origin)!.add(visualElementOverride.displayItem.id);
    }
    const displayItemId = newElement.get().displayItem.id;

    const existing = currentVessVsDisplayId.get(displayItemId);
    if (!existing) { currentVessVsDisplayId.set(displayItemId, []); }
    currentVessVsDisplayId.get(displayItemId)!.push(path);

    return newElement;
  },

  /**
   * Overwrites the provided ves with the provided override (which is generally expected to be for a new path).
   * Deletes any attachments of the existing ves.
   *
   * TODO (HIGH): should also delete children..., though this is never used
   */
  partial_overwriteVisualElementSignal: (visualElementOverride: VisualElementSpec, newPath: VisualElementPath, vesToOverwrite: VisualElementSignal) => {
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
    } else if (currentVesCache.has(newPath)) {
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

    for (let i = 0; i < veToOverwrite.attachmentsVes.length; ++i) {
      const attachmentVe = veToOverwrite.attachmentsVes[i].get();
      const attachmentVePath = VeFns.veToPath(attachmentVe);
      if (currentVesCache.has(attachmentVePath)) {
        VesCache.removeByPath(attachmentVePath);
      }
    }

    if (!currentVesCache.delete(existingPath)) {
      console.error("[VES_CACHE_DEBUG] Failed to delete existing path:", {
        existingPath: existingPath,
        newPath: newPath,
        displayItemId: veToOverwrite.displayItem.id,
        cacheSize: currentVesCache.size,
        timestamp: new Date().toISOString()
      });
      throw "vesToOverwrite did not exist";
    }
    deleteFromVessVsDisplayIdLookup(existingPath);
    VeFns.clearAndOverwrite(veToOverwrite, visualElementOverride);
    vesToOverwrite.set(veToOverwrite);
    currentVesCache.set(newPath, vesToOverwrite);
    if (isContainer(visualElementOverride.displayItem) &&
      (visualElementOverride.flags! & VisualElementFlags.ShowChildren) &&
      asContainerItem(visualElementOverride.displayItem).childrenLoaded) {
      const origin = visualElementOverride.displayItem.origin;
      if (!underConstructionWatchContainerUidsByOrigin.has(origin)) {
        underConstructionWatchContainerUidsByOrigin.set(origin, new Set<Uid>());
      }
      underConstructionWatchContainerUidsByOrigin.get(origin)!.add(visualElementOverride.displayItem.id);
    }

    const displayItemId = VeFns.itemIdFromPath(newPath);
    const existing = currentVessVsDisplayId.get(displayItemId);
    if (!existing) { currentVessVsDisplayId.set(displayItemId, []); }
    currentVessVsDisplayId.get(displayItemId)!.push(newPath);
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
    function findImpl(map: Map<VisualElementPath, VisualElementSignal>, result: Array<VisualElementSignal>) {
      for (let key of map.keys()) {
        const v = VeFns.veidFromPath(key);
        if (v.itemId == veid.itemId && v.linkIdMaybe == veid.linkIdMaybe) {
          const ves = map.get(key)!;
          if (!result.find(r => r == ves)) {
            result.push(ves);
          }
        }
      }
    }
    const result: Array<VisualElementSignal> = [];
    findImpl(underConstructionCache, result);
    findImpl(currentVesCache, result);
    return result;
  },

  /**
   * Find the single cached visual element with the specified veid. If other than one (none, or more than one)
   * corresponding ves exists, throw an exception.
   * 
   * The search includes any ves created in the current arrange pass (if one is underway) in addition to
   * any from the last completed one.
   */
  findSingle: (veid: Veid): VisualElementSignal => {
    function findSingleImpl(map: Map<VisualElementPath, VisualElementSignal>): VisualElementSignal | null {
      let result: VisualElementSignal | null = null;
      for (let key of map.keys()) {
        let v = VeFns.veidFromPath(key);
        if (v.itemId == veid.itemId && v.linkIdMaybe == veid.linkIdMaybe) {
          if (result != null) {
            throw new Error(`multiple visual elements found: ${veid.itemId}/${veid.linkIdMaybe}.`);
          }
          result = map.get(key)!;
        }
      }
      return result;
    }
    let resultMaybe = findSingleImpl(underConstructionCache);
    if (resultMaybe != null) { return resultMaybe; }
    resultMaybe = findSingleImpl(currentVesCache);
    if (resultMaybe == null) {
      throw new Error(`${veid.itemId}/${veid.linkIdMaybe} not present in VesCache.`);
    }
    return resultMaybe;
  },

  removeByPath: (path: VisualElementPath): void => {
    const ve = currentVesCache.get(path); // TODO (LOW): displayItem.id can be determined from the path.
    if (ve && isContainer(ve.get().displayItem) && asContainerItem(ve.get().displayItem).childrenLoaded) {
      const origin = ve.get().displayItem.origin;
      const uidSet = currentWatchContainerUidsByOrigin.get(origin);
      if (uidSet) {
        uidSet.delete(ve.get().displayItem.id);
        if (uidSet.size === 0) {
          currentWatchContainerUidsByOrigin.delete(origin);
        }
      }
    }
    if (!currentVesCache.delete(path)) { panic(`item ${path} is not in ves cache.`); }
    deleteFromVessVsDisplayIdLookup(path);
  },

  markEvaluationRequired: (path: VisualElementPath): void => {
    evaluationRequired.add(path);
  },

  getEvaluationRequired: (): Array<VisualElementPath> => {
    let result: Array<VisualElementPath> = [];
    evaluationRequired.forEach(s => result.push(s));
    return result;
  },

  debugLog: (): void => {
    console.debug("--- start ves cache entry list");
    for (let v of currentVesCache) { console.debug(v[0]); }
    console.debug("--- end ves cache entry list");
  },

  pushTopTitledPage: (vePath: VisualElementPath) => {
    underConstructionTopTitledPages.push(vePath);
  },
}


function createOrRecycleVisualElementSignalImpl(visualElementOverride: VisualElementSpec, path: VisualElementPath): VisualElementSignal {

  const debug = false; // VeFns.veidFromPath(path).itemId == "<id of item of interest here>";

  if (visualElementOverride.displayItemFingerprint) { panic("displayItemFingerprint is already set."); }
  visualElementOverride.displayItemFingerprint = ItemFns.getFingerprint(visualElementOverride.displayItem); // TODO (LOW): Modifying the input object is a bit dirty.

  if (isContainer(visualElementOverride.displayItem) &&
    (visualElementOverride.flags! & VisualElementFlags.ShowChildren) &&
    asContainerItem(visualElementOverride.displayItem).childrenLoaded) {
    const origin = visualElementOverride.displayItem.origin;
    if (!underConstructionWatchContainerUidsByOrigin.has(origin)) {
      underConstructionWatchContainerUidsByOrigin.set(origin, new Set<Uid>());
    }
    underConstructionWatchContainerUidsByOrigin.get(origin)!.add(visualElementOverride.displayItem.id);
  }

  function compareArrays(oldArray: Array<VisualElementSignal>, newArray: Array<VisualElementSignal>): number {
    if (oldArray.length != newArray.length) { return 1; }
    for (let i = 0; i < oldArray.length; ++i) {
      if (oldArray[i] != newArray[i]) { return 1; }
    }
    return 0;
  }

  function addVesVsDisplayItem(displayItemId: Uid, path: VisualElementPath) {
    const existing = underConstructionVesVsDisplayItemId.get(displayItemId);
    if (!existing) { underConstructionVesVsDisplayItemId.set(displayItemId, []); }
    underConstructionVesVsDisplayItemId.get(displayItemId)!.push(path);
  }

  const existing = currentVesCache.get(path);
  if (existing) {
    const existingVe = existing.get();
    if (existingVe.displayItemFingerprint != visualElementOverride.displayItemFingerprint) {
      existing.set(VeFns.create(visualElementOverride));
      if (debug) { console.debug("display item fingerprint changed", existingVe.displayItemFingerprint, visualElementOverride.displayItemFingerprint); }
      underConstructionCache.set(path, existing);
      addVesVsDisplayItem(existing.get().displayItem.id, path);
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
      const newElement = createVisualElementSignal(VeFns.create(visualElementOverride));
      underConstructionCache.set(path, newElement);
      addVesVsDisplayItem(newElement.get().displayItem.id, path);
      return newElement;
    }

    const newVals: any = visualElementOverride;
    const oldVals: any = existingVe;
    const newProps = Object.getOwnPropertyNames(visualElementOverride);
    let dirty = false;
    if (debug) { console.debug(newProps, oldVals, visualElementOverride); }
    for (let i = 0; i < newProps.length; ++i) {
      if (debug) { console.debug("considering", newProps[i]); }
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
      } else if (newProps[i] == "childrenVes" || newProps[i] == "attachmentsVes" || newProps[i] == "tableVesRows") {
        if (compareArrays(oldVal, newVal) != 0) {
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
        newProps[i] == "focusedChildItemMaybe" ||
        newProps[i] == "flags" ||
        newProps[i] == "_arrangeFlags_useForPartialRearrangeOnly" ||
        newProps[i] == "row" ||
        newProps[i] == "col" ||
        newProps[i] == "numRows" ||
        newProps[i] == "indentBl" ||
        newProps[i] == "parentPath" ||
        newProps[i] == "evaluatedTitle" ||
        newProps[i] == "displayItemFingerprint" ||
        newProps[i] == "popupVes" ||
        newProps[i] == "selectedVes" ||
        newProps[i] == "dockVes") {
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
    if (oldVals["popupVes"] && !visualElementOverride["popupVes"]) {
      if (debug) { console.debug("popVes has become unset."); }
      dirty = true;
    }
    if (oldVals["selectedVes"] && !visualElementOverride["selectedVes"]) {
      if (debug) { console.debug("selectedVes has become unset."); }
      dirty = true;
    }
    if (oldVals["dockVes"] && !visualElementOverride["dockVes"]) {
      if (debug) { console.debug("dockVes has become unset."); }
      dirty = true;
    }

    if (!dirty) {
      if (debug) { console.debug("not dirty:", path); }
      underConstructionCache.set(path, existing);
      addVesVsDisplayItem(existingVe.displayItem.id, path);
      return existing;
    }
    if (debug) { console.debug("dirty:", path); }

    // Recycle the existing visual element
    existing.set(VeFns.create(visualElementOverride));
    underConstructionCache.set(path, existing);
    addVesVsDisplayItem(existing.get().displayItem.id, path);
    return existing;
  }

  if (debug) { console.debug("creating:", path); }
  const newElement = createVisualElementSignal(VeFns.create(visualElementOverride));
  underConstructionCache.set(path, newElement);
  addVesVsDisplayItem(newElement.get().displayItem.id, path);
  return newElement;
}

function deleteFromVessVsDisplayIdLookup(path: string) {
  const displayItemId = VeFns.itemIdFromPath(path);
  let ves = currentVessVsDisplayId.get(displayItemId);
  if (!ves) { panic(`displayItemId ${displayItemId} is not in the displayItemId -> vesPath cache.`); }
  let foundIdx = ves.findIndex((v) => { return v == path });
  if (foundIdx == -1) { panic(`path ${path} was not in the displayItemId -> vesPath cache.`); }
  ves.splice(foundIdx, 1);
  if (ves.length == 0) {
    if (!currentVessVsDisplayId.delete(displayItemId)) { panic!("logic error deleting displayItemId."); }
  }
}
