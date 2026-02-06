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

import { createSignal, Accessor, Setter } from "solid-js";
import { asContainerItem, isContainer } from "../items/base/container-item";
import { ItemFns } from "../items/base/item-polymorphism";
import { StoreContextModel } from "../store/StoreProvider";
import { compareBoundingBox, compareDimensions } from "../util/geometry";
import { panic } from "../util/lang";
import { VisualElementSignal, createVisualElementSignal } from "../util/signals";
import { Uid } from "../util/uid";
import { HitboxFns } from "./hitbox";
import { VeFns, Veid, VisualElement, VisualElementFlags, VisualElementPath, VisualElementRelationships, VisualElementSpec } from "./visual-element";

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

// Reactive map for popupVes
// We store [read, write] signal pairs for each path.
let reactivePopups = new Map<VisualElementPath, [Accessor<VisualElementSignal | null>, Setter<VisualElementSignal | null>]>();

function getReactivePopupSignal(path: VisualElementPath) {
  let entry = reactivePopups.get(path);
  if (!entry) {
    entry = createSignal<VisualElementSignal | null>(null);
    reactivePopups.set(path, entry);
  }
  return entry;
}

function updateReactivePopup(path: VisualElementPath, value: VisualElementSignal | null) {
  const [read, write] = getReactivePopupSignal(path);
  if (read() !== value) {
    write(value);
  }
}

// Reactive map for selectedVes
let reactiveSelecteds = new Map<VisualElementPath, [Accessor<VisualElementSignal | null>, Setter<VisualElementSignal | null>]>();

function getReactiveSelectedSignal(path: VisualElementPath) {
  let entry = reactiveSelecteds.get(path);
  if (!entry) {
    entry = createSignal<VisualElementSignal | null>(null);
    reactiveSelecteds.set(path, entry);
  }
  return entry;
}

function updateReactiveSelected(path: VisualElementPath, value: VisualElementSignal | null) {
  const [read, write] = getReactiveSelectedSignal(path);
  if (read() !== value) {
    write(value);
  }
}

// Reactive map for dockVes
let reactiveDocks = new Map<VisualElementPath, [Accessor<VisualElementSignal | null>, Setter<VisualElementSignal | null>]>();

function getReactiveDockSignal(path: VisualElementPath) {
  let entry = reactiveDocks.get(path);
  if (!entry) {
    entry = createSignal<VisualElementSignal | null>(null);
    reactiveDocks.set(path, entry);
  }
  return entry;
}

function updateReactiveDock(path: VisualElementPath, value: VisualElementSignal | null) {
  const [read, write] = getReactiveDockSignal(path);
  if (read() !== value) {
    write(value);
  }
}

// Reactive map for focusedChildItemMaybe
// Storing Item | null
import { Item } from "../items/base/item";
let reactiveFocused = new Map<VisualElementPath, [Accessor<Item | null>, Setter<Item | null>]>();

function getReactiveFocusedSignal(path: VisualElementPath) {
  let entry = reactiveFocused.get(path);
  if (!entry) {
    entry = createSignal<Item | null>(null);
    reactiveFocused.set(path, entry);
  }
  return entry;
}

function updateReactiveFocused(path: VisualElementPath, value: Item | null) {
  let [read, write] = getReactiveFocusedSignal(path);
  const current = read();
  if (current?.id !== value?.id) {
    write(value);
  } else if (current !== value) {
    // Same ID, but object ref changed. Updating strictly might trigger signal.
    // We prefer to update IF object changed, relying on downstream to handle "same-id" efficiency if needed?
    // User requested "optimize reactivity".
    // If ID is same, we should probably NOT update signal to prevent downstream re-renders.
    // BUT if Item properties changed (e.g. background color), we NEED to update.
    // The previous implementation in VisualElement triggered on ref change.
    // The previous "Fix" (ID check) suppressed updates even if properties changed (bad?).
    // Wait. `focusedChildItemMaybe` is used for `backgroundColorIndex`.
    // If background color changed, ID is same.
    // We MUST update if properties changed.
    // So `if (read() !== value) write(value)`.
    // BUT we want to avoid "Mouse Move" causing "New Object with SAME Props".
    // Does mouse move cause new Item object?
    // `itemState.get(id)` usually returns same object unless Store updated.
    // User said "mouse move... focus changed probably".
    // If focus changed to SAME ID? No.
    // If focus changed to DIFFERENT ID? Yes.
    // So strict equality is fine, IF the Item objects are stable.
    write(value);
  }
}

// Reactive map for attachmentsVes
let reactiveAttachments = new Map<VisualElementPath, [Accessor<Array<VisualElementSignal>>, Setter<Array<VisualElementSignal>>]>();

function getReactiveAttachmentsSignal(path: VisualElementPath) {
  let entry = reactiveAttachments.get(path);
  if (!entry) {
    entry = createSignal<Array<VisualElementSignal>>([]);
    reactiveAttachments.set(path, entry);
  }
  return entry;
}

function updateReactiveAttachments(path: VisualElementPath, value: Array<VisualElementSignal> | undefined) {
  const actualValue = value ?? [];
  const [read, write] = getReactiveAttachmentsSignal(path);
  const current = read();
  if (current.length !== actualValue.length) {
    write(actualValue);
    return;
  }
  for (let i = 0; i < current.length; i++) {
    if (current[i] !== actualValue[i]) {
      write(actualValue);
      return;
    }
  }
}

// Reactive map for childrenVes
let reactiveChildren = new Map<VisualElementPath, [Accessor<Array<VisualElementSignal>>, Setter<Array<VisualElementSignal>>]>();

function getReactiveChildrenSignal(path: VisualElementPath) {
  let entry = reactiveChildren.get(path);
  if (!entry) {
    entry = createSignal<Array<VisualElementSignal>>([]);
    reactiveChildren.set(path, entry);
  }
  return entry;
}

function updateReactiveChildren(path: VisualElementPath, value: Array<VisualElementSignal> | undefined) {
  const actualValue = value ?? [];
  const [read, write] = getReactiveChildrenSignal(path);
  const current = read();
  if (current.length !== actualValue.length) {
    write(actualValue);
    return;
  }
  for (let i = 0; i < current.length; i++) {
    if (current[i] !== actualValue[i]) {
      write(actualValue);
      return;
    }
  }
}

// Static map for tableVesRows (Not reactive, just storage)
let staticTableVesRows = new Map<VisualElementPath, Array<number> | null>();

let evaluationRequired = new Set<VisualElementPath>();
let currentlyInFullArrange = false;

type VesAuxData = {
  displayItemFingerprint: Map<VisualElementPath, string>;
  attachmentsVes: Map<VisualElementPath, Array<VisualElementSignal>>;
  popupVes: Map<VisualElementPath, VisualElementSignal | null>;
  selectedVes: Map<VisualElementPath, VisualElementSignal | null>;
  dockVes: Map<VisualElementPath, VisualElementSignal | null>;
  childrenVes: Map<VisualElementPath, Array<VisualElementSignal>>;
  tableVesRows: Map<VisualElementPath, Array<number> | null>;
  focusedChildItemMaybe: Map<VisualElementPath, Item | null>;
}

function createEmptyAuxData(): VesAuxData {
  return {
    displayItemFingerprint: new Map(),
    attachmentsVes: new Map(),
    popupVes: new Map(),
    selectedVes: new Map(),
    dockVes: new Map(),
    childrenVes: new Map(),
    tableVesRows: new Map(),
    focusedChildItemMaybe: new Map(),
  };
}

let currentAux = createEmptyAuxData();
let virtualAux = createEmptyAuxData();
let underConstructionAux = createEmptyAuxData();

function syncAuxData(aux: VesAuxData, path: VisualElementPath, ve: VisualElement, relationships: VisualElementRelationships | null) {
  aux.displayItemFingerprint.set(path, ve.displayItemFingerprint);
  aux.attachmentsVes.set(path, relationships?.attachmentsVes ?? []);
  aux.popupVes.set(path, relationships?.popupVes ?? null);
  aux.selectedVes.set(path, relationships?.selectedVes ?? null);
  aux.dockVes.set(path, relationships?.dockVes ?? null);
  aux.childrenVes.set(path, relationships?.childrenVes ?? []);
  aux.tableVesRows.set(path, relationships?.tableVesRows ?? null);
  aux.focusedChildItemMaybe.set(path, relationships?.focusedChildItemMaybe ?? null);
}

function deleteAuxData(aux: VesAuxData, path: VisualElementPath) {
  aux.displayItemFingerprint.delete(path);
  aux.attachmentsVes.delete(path);
  aux.popupVes.delete(path);
  aux.selectedVes.delete(path);
  aux.dockVes.delete(path);
  aux.childrenVes.delete(path);
  aux.tableVesRows.delete(path);
  aux.focusedChildItemMaybe.delete(path);
}

// Diagnostic counters for performance analysis
const LOG_ARRANGE_STATS = true;
let arrangeStats = { recycled: 0, dirty: 0, new: 0, dirtyReasons: new Map<string, number>() };
function resetArrangeStats() {
  arrangeStats = { recycled: 0, dirty: 0, new: 0, dirtyReasons: new Map<string, number>() };
}
function logDirtyReason(reason: string) {
  arrangeStats.dirty++;
  arrangeStats.dirtyReasons.set(reason, (arrangeStats.dirtyReasons.get(reason) || 0) + 1);
}
function logArrangeStats() {
  if (!LOG_ARRANGE_STATS) return;
  // console.log(`[VesCache] Arrange stats: recycled=${arrangeStats.recycled}, dirty=${arrangeStats.dirty}, new=${arrangeStats.new}`);
  if (arrangeStats.dirty > 0) {
    // console.log(`[VesCache] Dirty reasons:`, Object.fromEntries(arrangeStats.dirtyReasons));
  }
}

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

    currentAux = createEmptyAuxData();
    staticTableVesRows = new Map<VisualElementPath, Array<number> | null>();
    virtualCache = new Map<VisualElementPath, VisualElementSignal>();
    virtualAux = createEmptyAuxData();
    underConstructionCache = new Map<VisualElementPath, VisualElementSignal>();
    underConstructionVesVsDisplayItemId = new Map<Uid, Array<VisualElementPath>>();
    underConstructionTopTitledPages = [];
    underConstructionWatchContainerUidsByOrigin = new Map<string | null, Set<Uid>>();
    underConstructionAux = createEmptyAuxData();

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

  /**
   * Find all visual element signals in the virtual cache with the specified parent path.
   * Used for finding children/attachments of a VE in the virtual arrangement.
   */
  getChildrenVirtual: (parentPath: VisualElementPath): Array<VisualElementSignal> => {
    const result: Array<VisualElementSignal> = [];
    for (const kv of virtualCache.entries()) {
      if (VeFns.parentPath(kv[0]) == parentPath) {
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
    resetArrangeStats();
  },

  full_finalizeArrange: (store: StoreContextModel, umbrellaSpec: VisualElementSpec, umbrellaRelationships: VisualElementRelationships, umbrellaPath: VisualElementPath, virtualUmbrellaVes?: VisualElementSignal): void => {
    if (umbrellaSpec.displayItemFingerprint) { panic("displayItemFingerprint is already set."); }
    umbrellaSpec.displayItemFingerprint = ItemFns.getFingerprint(umbrellaSpec.displayItem); // TODO (LOW): Modifying the input object is a bit nasty.
    const umbrellaVeSpec = { ...umbrellaSpec, ...umbrellaRelationships };

    if (virtualUmbrellaVes) {
      underConstructionCache.set(umbrellaPath, virtualUmbrellaVes);
      // When restoring virtual, we don't have the spec easily, but virtualUmbrellaVes already has state.
      // Wait, syncAuxData reads from spec for popupVes.
      // If we are restoring from virtual, the virtual signal should be correct.
      // But VisualElement no longer has popupVes.
      // So where is popupVes? The virtual signal *contained* a VE.
      // If we are passing virtualUmbrellaVes, it is a VisualElementSignal.
      // The VE inside it doesn't have popupVes.
      // We need to fetch popupVes from somewhere.
      // But wait! If we pass `null` as spec, `syncAuxData` sets `popupVes` to `null`.
      // This is WRONG if the virtual element actually has a popup.
      // However, `full_finalizeArrange` with `virtualUmbrellaVes` is usually for restoring... 
      // Actually `virtualUmbrellaVes` is passed from `full_initArrange`? No.
      // It is optional.
      // Note: `virtualCache` is where we store pre-calculated stuff?
      // If `virtualUmbrellaVes` comes from `virtualCache` previously?
      // For now, I'll pass umbrellaVeSpec which is available in the function arguments.
      syncAuxData(underConstructionAux, umbrellaPath, virtualUmbrellaVes.get(), umbrellaVeSpec);
      virtualCache = underConstructionCache;
      virtualAux = underConstructionAux;
    } else {
      underConstructionCache.set(umbrellaPath, store.umbrellaVisualElement);  // TODO (MEDIUM): full property reconciliation, to avoid this update.
      store.umbrellaVisualElement.set(VeFns.create(umbrellaVeSpec));
      syncAuxData(underConstructionAux, umbrellaPath, store.umbrellaVisualElement.get(), umbrellaVeSpec);

      currentVesCache = underConstructionCache;
      currentVessVsDisplayId = underConstructionVesVsDisplayItemId;
      currentTopTitledPages = underConstructionTopTitledPages;
      currentWatchContainerUidsByOrigin = underConstructionWatchContainerUidsByOrigin;
      currentAux = underConstructionAux;

      store.topTitledPages.set(currentTopTitledPages);
      logOrphanedVes(currentVesCache, "full_finalizeArrange");
      logArrangeStats();
    }

    underConstructionCache = new Map<VisualElementPath, VisualElementSignal>();
    underConstructionVesVsDisplayItemId = new Map<Uid, Array<VisualElementPath>>();
    underConstructionTopTitledPages = [];
    underConstructionWatchContainerUidsByOrigin = new Map<string | null, Set<Uid>>();
    underConstructionAux = createEmptyAuxData();

    // Sync reactive popups from currentAux.popupVes
    for (const [path, signal] of currentAux.popupVes) {
      updateReactivePopup(path, signal);
    }
    for (const [path, _] of reactivePopups) {
      if (!currentAux.popupVes.has(path)) {
        updateReactivePopup(path, null);
      }
    }

    // Sync reactive selecteds from currentAux.selectedVes
    for (const [path, signal] of currentAux.selectedVes) {
      updateReactiveSelected(path, signal);
    }
    for (const [path, _] of reactiveSelecteds) {
      if (!currentAux.selectedVes.has(path)) {
        updateReactiveSelected(path, null);
      }
    }

    // Sync reactive docks from currentAux.dockVes
    for (const [path, signal] of currentAux.dockVes) {
      updateReactiveDock(path, signal);
    }
    for (const [path, _] of reactiveDocks) {
      if (!currentAux.dockVes.has(path)) {
        updateReactiveDock(path, null);
      }
    }

    // Sync reactive attachments from currentAux.attachmentsVes
    for (const [path, list] of currentAux.attachmentsVes) {
      updateReactiveAttachments(path, list);
    }
    for (const [path, _] of reactiveAttachments) {
      if (!currentAux.attachmentsVes.has(path)) {
        updateReactiveAttachments(path, []);
      }
    }

    // Sync reactive children from currentAux.childrenVes
    for (const [path, list] of currentAux.childrenVes) {
      updateReactiveChildren(path, list);
    }
    for (const [path, _] of reactiveChildren) {
      if (!currentAux.childrenVes.has(path)) {
        updateReactiveChildren(path, []);
      }
    }

    // Sync static tableVesRows from currentAux.tableVesRows
    staticTableVesRows.clear();
    for (const [path, rows] of currentAux.tableVesRows) {
      staticTableVesRows.set(path, rows);
    }

    // Sync reactive focusedChildItemMaybe from currentAux.focusedChildItemMaybe
    for (const [path, item] of currentAux.focusedChildItemMaybe) {
      updateReactiveFocused(path, item);
    }
    for (const [path, _] of reactiveFocused) {
      if (!currentAux.focusedChildItemMaybe.has(path)) {
        updateReactiveFocused(path, null);
      }
    }

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
  full_createOrRecycleVisualElementSignal: (spec: VisualElementSpec, relationships: VisualElementRelationships, path: VisualElementPath): VisualElementSignal => {
    return createOrRecycleVisualElementSignalImpl(spec, relationships, path);
  },

  /**
   * Create a new VisualElementSignal and insert it into the current cache.
   */
  partial_create: (spec: VisualElementSpec, relationships: VisualElementRelationships, path: VisualElementPath): VisualElementSignal => {
    const visualElementOverride = { ...spec, ...relationships };
    const newElement = createVisualElementSignal(VeFns.create(visualElementOverride));
    currentVesCache.set(path, newElement);
    syncAuxData(currentAux, path, newElement.get(), relationships);

    updateReactivePopup(path, relationships.popupVes ?? null);
    updateReactiveSelected(path, relationships.selectedVes ?? null);
    updateReactiveDock(path, relationships.dockVes ?? null);
    updateReactiveAttachments(path, relationships.attachmentsVes);
    updateReactiveChildren(path, relationships.childrenVes);
    updateReactiveFocused(path, visualElementOverride.focusedChildItemMaybe ?? null);

    staticTableVesRows.set(path, relationships.tableVesRows ?? null);


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
  partial_overwriteVisualElementSignal: (spec: VisualElementSpec, relationships: VisualElementRelationships, newPath: VisualElementPath, vesToOverwrite: VisualElementSignal) => {
    const visualElementOverride = { ...spec, ...relationships };
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

    const existingAttachments = VesCache.getAttachmentsVes(existingPath)();
    for (let i = 0; i < existingAttachments.length; ++i) {
      const attachmentVe = existingAttachments[i].get();
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
    deleteAuxData(currentAux, existingPath);
    VeFns.clearAndOverwrite(veToOverwrite, visualElementOverride);
    vesToOverwrite.set(veToOverwrite);
    currentVesCache.set(newPath, vesToOverwrite);
    syncAuxData(currentAux, newPath, vesToOverwrite.get(), relationships);

    updateReactivePopup(newPath, relationships.popupVes ?? null);
    updateReactiveSelected(newPath, relationships.selectedVes ?? null);
    updateReactiveDock(newPath, relationships.dockVes ?? null);
    updateReactiveAttachments(newPath, relationships.attachmentsVes);
    updateReactiveChildren(newPath, relationships.childrenVes);
    staticTableVesRows.set(newPath, relationships.tableVesRows ?? null);


    if (isContainer(visualElementOverride.displayItem) &&
      (visualElementOverride.flags! & VisualElementFlags.ShowChildren) &&
      asContainerItem(visualElementOverride.displayItem).childrenLoaded) {
      const origin = visualElementOverride.displayItem.origin;
      if (!underConstructionWatchContainerUidsByOrigin.has(origin)) {
        underConstructionWatchContainerUidsByOrigin.set(origin, new Set<Uid>());
      }
      underConstructionWatchContainerUidsByOrigin.get(origin)!.add(spec.displayItem.id);
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
   * Find all visual element signals in the virtual cache with the specified veid.
   * Used for keyboard navigation in parent container context.
   */
  findVirtual: (veid: Veid): Array<VisualElementSignal> => {
    const result: Array<VisualElementSignal> = [];
    for (let key of virtualCache.keys()) {
      const v = VeFns.veidFromPath(key);
      if (v.itemId == veid.itemId && v.linkIdMaybe == veid.linkIdMaybe) {
        const ves = virtualCache.get(key)!;
        if (!result.find(r => r == ves)) {
          result.push(ves);
        }
      }
    }
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
    deleteAuxData(currentAux, path);
    updateReactivePopup(path, null);
    updateReactiveSelected(path, null);
    updateReactiveDock(path, null);
    updateReactiveDock(path, null); // Duplicate line in original, leaving as is or fixing? Original had dup.
    updateReactiveAttachments(path, []);
    updateReactiveChildren(path, []);
    updateReactiveFocused(path, null);
    staticTableVesRows.delete(path);

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

  clearPopupVes: (path: VisualElementPath) => {
    currentAux.popupVes.set(path, null);
    updateReactivePopup(path, null);
  },

  getDisplayItemFingerprint: (path: VisualElementPath): string | undefined => {
    if (currentlyInFullArrange && underConstructionAux.displayItemFingerprint.has(path)) {
      return underConstructionAux.displayItemFingerprint.get(path);
    }
    return currentAux.displayItemFingerprint.get(path);
  },

  getAttachmentsVes: (path: VisualElementPath): Accessor<Array<VisualElementSignal>> => {
    return getReactiveAttachmentsSignal(path)[0];
  },

  getPopupVes: (path: VisualElementPath): Accessor<VisualElementSignal | null> => {
    // Return the reactive accessor
    return getReactivePopupSignal(path)[0];
  },

  getSelectedVes: (path: VisualElementPath): Accessor<VisualElementSignal | null> => {
    return getReactiveSelectedSignal(path)[0];
  },

  getDockVes: (path: VisualElementPath): Accessor<VisualElementSignal | null> => {
    return getReactiveDockSignal(path)[0];
  },

  getChildrenVes: (path: VisualElementPath): Accessor<Array<VisualElementSignal>> => {
    return getReactiveChildrenSignal(path)[0];
  },

  getFocusedChild: (path: VisualElementPath): Accessor<Item | null> => {
    return getReactiveFocusedSignal(path)[0];
  },

  getTableVesRows: (path: VisualElementPath): Array<number> | null => {
    if (currentlyInFullArrange && underConstructionAux.tableVesRows.has(path)) {
      return underConstructionAux.tableVesRows.get(path)!;
    }
    return staticTableVesRows.get(path) ?? null;
  },
}


function createOrRecycleVisualElementSignalImpl(spec: VisualElementSpec, relationships: VisualElementRelationships, path: VisualElementPath): VisualElementSignal {
  const visualElementOverride = { ...spec, ...relationships };

  const debug = false; // VeFns.veidFromPath(path).itemId == "<id of item of interest here>";

  if (spec.displayItemFingerprint) { panic("displayItemFingerprint is already set."); }
  spec.displayItemFingerprint = ItemFns.getFingerprint(spec.displayItem); // TODO (LOW): Modifying the input object is a bit dirty.
  visualElementOverride.displayItemFingerprint = spec.displayItemFingerprint;

  if (isContainer(spec.displayItem) &&
    (spec.flags! & VisualElementFlags.ShowChildren) &&
    asContainerItem(spec.displayItem).childrenLoaded) {
    const origin = spec.displayItem.origin;
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
      logDirtyReason("fingerprint");
      underConstructionCache.set(path, existing);
      syncAuxData(underConstructionAux, path, existing.get(), relationships);
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
      logDirtyReason("lineItemChange");
      arrangeStats.new++; // This creates a new signal rather than recycling
      const newElement = createVisualElementSignal(VeFns.create(visualElementOverride));
      underConstructionCache.set(path, newElement);
      syncAuxData(underConstructionAux, path, newElement.get(), relationships);
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
      if (newProps[i] == "childrenVes" ||
        newProps[i] == "attachmentsVes" ||
        newProps[i] == "tableVesRows" ||
        newProps[i] == "popupVes" ||
        newProps[i] == "selectedVes" ||
        newProps[i] == "dockVes" ||
        newProps[i] == "focusedChildItemMaybe") {
        continue;
      }

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
      } else if (newProps[i] == "linkItemMaybe") {
        // If this is an infumap-generated link, object ref might have changed, and it doesn't matter.
        // TODO (MEDIUM): rethink this through.
      } else if (newProps[i] == "displayItem" ||
        newProps[i] == "actualLinkItemMaybe" ||
        newProps[i] == "flags" ||
        newProps[i] == "_arrangeFlags_useForPartialRearrangeOnly" ||
        newProps[i] == "row" ||
        newProps[i] == "col" ||
        newProps[i] == "numRows" ||
        newProps[i] == "indentBl" ||
        newProps[i] == "parentPath" ||
        newProps[i] == "evaluatedTitle" ||
        newProps[i] == "displayItemFingerprint") {
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
    if (!dirty) {
      if (debug) { console.debug("not dirty:", path); }
      arrangeStats.recycled++;
      underConstructionCache.set(path, existing);
      syncAuxData(underConstructionAux, path, existing.get(), relationships);
      addVesVsDisplayItem(existingVe.displayItem.id, path);
      return existing;
    }
    if (debug) { console.debug("dirty:", path); }
    arrangeStats.dirty++;

    // Recycle the existing visual element
    existing.set(VeFns.create(visualElementOverride));
    underConstructionCache.set(path, existing);
    syncAuxData(underConstructionAux, path, existing.get(), relationships);
    addVesVsDisplayItem(existing.get().displayItem.id, path);
    return existing;
  }

  if (debug) { console.debug("creating:", path); }
  arrangeStats.new++;
  const newElement = createVisualElementSignal(VeFns.create(visualElementOverride));
  underConstructionCache.set(path, newElement);
  syncAuxData(underConstructionAux, path, newElement.get(), relationships);
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
