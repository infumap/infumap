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

import { ItemFns } from "../items/base/item-polymorphism";
import { StoreContextModel } from "../store/StoreProvider";
import { compareBoundingBox, compareVector } from "../util/geometry";
import { panic } from "../util/lang";
import { VisualElementSignal, createVisualElementSignal } from "../util/signals";
import { HitboxFns } from "./hitbox";
import { VeFns, Veid, VisualElementPath, VisualElementSpec } from "./visual-element";

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
let virtualCache = new Map<VisualElementPath, VisualElementSignal>();
let constructingCache = new Map<VisualElementPath, VisualElementSignal>();
let evaluationRequired = new Set<VisualElementPath>();

export let VesCache = {

  /**
   * Re-initialize - clears all cached data.
   */
  clear: (): void => {
    currentVesCache = new Map<VisualElementPath, VisualElementSignal>();
    virtualCache = new Map<VisualElementPath, VisualElementSignal>();
    constructingCache = new Map<VisualElementPath, VisualElementSignal>();
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

  initFullArrange: (): void => {
    evaluationRequired = new Set<VisualElementPath>();
  },

  finalizeFullArrange: (store: StoreContextModel, topLevelVisualElementSpec: VisualElementSpec, topLevelPath: VisualElementPath, virtualTopLevelVes?: VisualElementSignal): void => {
    if (topLevelVisualElementSpec.displayItemFingerprint) { panic("displayItemFingerprint is already set."); }
    topLevelVisualElementSpec.displayItemFingerprint = ItemFns.getFingerprint(topLevelVisualElementSpec.displayItem); // TODO (LOW): Modifying the input object is a bit nasty.

    if (virtualTopLevelVes) {
      constructingCache.set(topLevelPath, virtualTopLevelVes);
      virtualCache = constructingCache;
    } else {
      constructingCache.set(topLevelPath, store.topLevelVisualElement);  // TODO (MEDIUM): full property reconciliation, to avoid this update.
      store.topLevelVisualElement.set(VeFns.create(topLevelVisualElementSpec));
      currentVesCache = constructingCache;
    }

    constructingCache = new Map<VisualElementPath, VisualElementSignal>();
  },

  /**
   * Creates or recycles an existing VisualElementSignal, if one exists for the specified path.
   * In the case of recycling, the overriden values (only) are checked against the existing visual element values.
   * I.e. a previously overriden value that is not overriden in the new ve spec will not be detected.
   * Note that this check always includes the display item fingerprint, to pick up on any non-geometric changes that still affect the item render.
   * I think the above strategy should always work in practice, but a more comprehensive (and expensive) comparison may be required in some instances.
   * The entire cache should cleared on page change (since there will be little or no overlap anyway).
   * This is achieved using initFullArrange and finalizeFullArange methods.
   */
  createOrRecycleVisualElementSignal: (visualElementOverride: VisualElementSpec, path: VisualElementPath): VisualElementSignal => {
    return createOrRecycleVisualElementSignalImpl(visualElementOverride, path);
  },

  /**
   * Find all current cached visual element signals with the specified veid.
   * This includes any ves created in the current arrange pass (if one is underway) in addition to
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
    findImpl(constructingCache, result);
    findImpl(currentVesCache, result);
    return result;
  },

  /**
   * Find the single cached visual element with the specified veid. If other than one (none, or more than one)
   * corresponding ves exists, throw an exception.
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
    let resultMaybe = findSingleImpl(constructingCache);
    if (resultMaybe != null) { return resultMaybe; }
    resultMaybe = findSingleImpl(currentVesCache);
    if (resultMaybe == null) {
      throw new Error(`${veid.itemId}/${veid.linkIdMaybe} not present in VesCache.`);
    }
    return resultMaybe;
  },

  /**
   * Remove the visual element signal with the specified key from the cache.
   */
  remove: (veid: Veid): void => {
    for (let key of currentVesCache.keys()) {
      let v = VeFns.veidFromPath(key);
      if (v.itemId == veid.itemId && v.linkIdMaybe == veid.linkIdMaybe) {
        currentVesCache.delete(key);
        return;
      }
    }
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
    console.log("--- start ves cache entry list");
    for (let v of currentVesCache) { console.log(v[0]); }
    console.log("--- end ves cache entry list");
  }
}


function createOrRecycleVisualElementSignalImpl (visualElementOverride: VisualElementSpec, path: VisualElementPath): VisualElementSignal {

  const debug = false; // VeFns.veidFromPath(path).itemId == "<id of item of interest here>";

  if (visualElementOverride.displayItemFingerprint) { panic("displayItemFingerprint is already set."); }
  visualElementOverride.displayItemFingerprint = ItemFns.getFingerprint(visualElementOverride.displayItem); // TODO (LOW): Modifying the input object is a bit dirty.

  function compareVesArrays(oldArray: Array<VisualElementSignal>, newArray: Array<VisualElementSignal>): number {
    if (oldArray.length != newArray.length) {
      return 1;
    }
    for (let i=0; i<oldArray.length; ++i) {
      if (oldArray[i] != newArray[i]) {
        return 1;
      }
    }
    return 0;
  }

  const existing = currentVesCache.get(path);
  if (existing) {
    if (existing.get().displayItemFingerprint != visualElementOverride.displayItemFingerprint) {
      existing.set(VeFns.create(visualElementOverride));
      if (debug) { console.debug("display item fingerprint changed", existing.get().displayItemFingerprint, visualElementOverride.displayItemFingerprint); }
      constructingCache.set(path, existing);
      return existing;
    }

    const newVals: any = visualElementOverride;
    const oldVals: any = existing.get();
    const newProps = Object.getOwnPropertyNames(visualElementOverride);
    let dirty = false;
    if (debug) { console.debug(newProps, oldVals, visualElementOverride); }
    for (let i=0; i<newProps.length; ++i) {
      if (debug) { console.debug("considering", newProps[i]); }
      if (typeof(oldVals[newProps[i]]) == 'undefined') {
        if (debug) { console.debug('prop does not exist:', newProps[i]); }
        dirty = true;
        break;
      }
      const oldVal = oldVals[newProps[i]];
      const newVal = newVals[newProps[i]];
      if (oldVal != newVal) {
        if (newProps[i] == "boundsPx" || newProps[i] == "childAreaBoundsPx" || newProps[i] == "viewportBoundsPx") {
          if (compareBoundingBox(oldVal, newVal) != 0) {
            if (debug) { console.debug("visual element property changed: ", newProps[i]); }
            dirty = true;
            break;
          } else {
            if (debug) { console.debug("boundsPx didn't change."); }
          }
        } else if (newProps[i] == "childrenVes" || newProps[i] == "attachmentsVes") {
          // TODO (MEDIUM): better reconciliation.
          if (compareVesArrays(oldVal, newVal) != 0) {
            if (debug) { console.debug("visual element property changed: ", newProps[i]); }
            dirty = true;
            break;
          }
        } else if (newProps[i] == "blockSizePx") {
          if (compareVector(oldVal, newVal) != 0) {
            if (debug) { console.debug("visual element property changed: ", newProps[i]); }
            dirty = true;
            break;
          } else {
            if (debug) { console.debug("blockSizePx didn't change."); }
          }
        } else if (newProps[i] == "hitboxes") {
          if (HitboxFns.ArrayCompare(oldVal, newVal) != 0) {
            if (debug) { console.debug("visual element property changed: ", newProps[i]); }
            dirty = true;
            break;
          }
        } else if (newProps[i] == "linkItemMaybe" || newProps[i] == "actualLinkItemMaybe") {
          // object ref might have changed.
        } else {
          if (debug) { console.debug("visual element property changed: ", newProps[i], oldVal, newVal); }
          dirty = true;
          break;
        }
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
      constructingCache.set(path, existing);
      return existing;
    }
    if (debug) { console.debug("dirty:", path); }
    existing.set(VeFns.create(visualElementOverride));
    constructingCache.set(path, existing);
    return existing;
  }

  if (debug) { console.debug("creating:", path); }
  const newElement = createVisualElementSignal(VeFns.create(visualElementOverride));
  constructingCache.set(path, newElement);
  return newElement;
}
