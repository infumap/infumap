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
import { DesktopStoreContextModel } from "../store/DesktopStoreProvider";
import { compareBoundingBox } from "../util/geometry";
import { panic, throwExpression } from "../util/lang";
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
let newCache = new Map<VisualElementPath, VisualElementSignal>();
let evaluationRequired = new Set<VisualElementPath>();

export let VesCache = {
  get: (path: VisualElementPath): VisualElementSignal | undefined => {
    return currentVesCache.get(path);
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

  initFullArrange: (): void => {
    newCache = new Map<VisualElementPath, VisualElementSignal>();
    evaluationRequired = new Set<VisualElementPath>();
  },

  finalizeFullArrange: (topLevelVisualElementSpec: VisualElementSpec, topLevelPath: VisualElementPath, desktopStore: DesktopStoreContextModel): void => {
    createOrRecycleVisualElementSignalImpl(topLevelVisualElementSpec, topLevelPath, desktopStore.topLevelVisualElementSignal());
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

  find: (veid: Veid): Array<VisualElementSignal> => {
    const result = [];
    for (let key of currentVesCache.keys()) {
      let v = VeFns.veidFromPath(key);
      if (v.itemId == veid.itemId && v.linkIdMaybe == veid.linkIdMaybe) {
        result.push(currentVesCache.get(key)!);
      }
    }
    return result;
  },

  findSingle: (veid: Veid): VisualElementSignal => {
    let result: VisualElementSignal | null = null;
    for (let key of currentVesCache.keys()) {
      let v = VeFns.veidFromPath(key);
      if (v.itemId == veid.itemId && v.linkIdMaybe == veid.linkIdMaybe) {
        if (result != null) {
          throwExpression(`multiple visual elements found: ${veid.itemId}/${veid.linkIdMaybe}.`);
        }
        result = currentVesCache.get(key)!;
      }
    }
    if (result == null) {
      throwExpression(`${veid.itemId}/${veid.linkIdMaybe} not present in VesCache.`);
    }
    return result;
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


function createOrRecycleVisualElementSignalImpl (
    visualElementOverride: VisualElementSpec,
    path: VisualElementPath,
    alwaysUseVes?: VisualElementSignal): VisualElementSignal {

  const debug = false; // VeFns.veidFromPath(path).itemId == "<id of item of interest here>";

  if (visualElementOverride.displayItemFingerprint) { panic(); }
  // TODO(LOW): Modifying the input object is a bit dirty.
  visualElementOverride.displayItemFingerprint = ItemFns.getFingerprint(visualElementOverride.displayItem);

  if (alwaysUseVes) {
    if (debug) { console.debug("alwaysUse:", path); }
    // TODO (HIGH): full property reconciliation, to avoid this update.
    newCache.set(path, alwaysUseVes);
    currentVesCache = newCache;
    alwaysUseVes.set(VeFns.create(visualElementOverride));
    return alwaysUseVes;
  }

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
      newCache.set(path, existing);
      return existing;
    }

    const newVals: any = visualElementOverride;
    const oldVals: any = existing.get();
    const newProps = Object.getOwnPropertyNames(visualElementOverride);
    let dirty = false;
    if (debug) { console.debug(newProps, visualElementOverride); }
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
        if (newProps[i] == "boundsPx" || newProps[i] == "childAreaBoundsPx") {
          if (compareBoundingBox(oldVal, newVal) != 0) {
            if (debug) { console.debug("visual element property changed: ", newProps[i]); }
            dirty = true;
            break;
          } else {
            if (debug) { console.debug("boundsPx didn't change."); }
          }
        } else if (newProps[i] == "children" || newProps[i] == "attachments") {
          // TODO (MEDIUM): better reconciliation.
          if (compareVesArrays(oldVal, newVal) != 0) {
            if (debug) { console.debug("visual element property changed: ", newProps[i]); }
            dirty = true;
            break;
          }
        } else if (newProps[i] == "hitboxes") {
          if (HitboxFns.ArrayCompare(oldVal, newVal) != 0) {
            if (debug) { console.debug("visual element property changed: ", newProps[i]); }
            dirty = true;
            break;
          }
        } else if (newProps[i] == "linkItemMaybe") {
          // object ref might have changed.
        } else {
          if (debug) { console.debug("visual element property changed: ", newProps[i], oldVal, newVal); }
          dirty = true;
          break;
        }
      }
    }
    if (!dirty) {
      if (debug) { console.debug("not dirty:", path); }
      newCache.set(path, existing);
      return existing;
    }
    if (debug) { console.debug("dirty:", path); }
    existing.set(VeFns.create(visualElementOverride));
    newCache.set(path, existing);
    return existing;
  }

  if (debug) { console.debug("creating:", path); }
  const newElement = createVisualElementSignal(VeFns.create(visualElementOverride));
  newCache.set(path, newElement);
  return newElement;
}
