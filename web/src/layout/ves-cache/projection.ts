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

import { Accessor, Setter, createSignal } from "solid-js";
import { Item } from "../../items/base/item";
import { VisualElementPath } from "../visual-element";
import { VisualElementSignal } from "../../util/signals";
import { RenderProjectionEntry, RenderProjectionSlot, VesCacheState } from "./state";

export type ProjectionOps = ReturnType<typeof createProjectionOps>;

export function createProjectionOps(state: VesCacheState) {
  function createRenderProjectionEntry(): RenderProjectionEntry {
    return {
      node: { value: undefined, signal: null },
      popup: { value: null, signal: null },
      selected: { value: null, signal: null },
      dock: { value: null, signal: null },
      focused: { value: null, signal: null },
      attachments: { value: [], signal: null },
      children: { value: [], signal: null },
      lineChildren: { value: [], signal: null },
      desktopChildren: { value: [], signal: null },
      nonMovingChildren: { value: [], signal: null },
      tableRows: null,
    };
  }

  function getRenderProjection(path: VisualElementPath): RenderProjectionEntry {
    let entry = state.renderProjectionByPath.get(path);
    if (!entry) {
      entry = createRenderProjectionEntry();
      state.renderProjectionByPath.set(path, entry);
    }
    return entry;
  }

  function findRenderProjection(path: VisualElementPath): RenderProjectionEntry | undefined {
    return state.renderProjectionByPath.get(path);
  }

  function ensureRenderProjectionSignal<T>(
    slot: RenderProjectionSlot<T>,
  ): [Accessor<T>, Setter<T>] {
    if (slot.signal) {
      return slot.signal;
    }
    const signal = createSignal<T>(slot.value);
    slot.signal = signal;
    return signal;
  }

  function readRenderProjectionSignal<T>(slot: RenderProjectionSlot<T>): T {
    return slot.signal ? slot.signal[0]() : slot.value;
  }

  function updateRenderProjectionSignal<T>(
    signal: [Accessor<T>, Setter<T>],
    value: T,
    shouldUpdate?: (current: T, next: T) => boolean,
  ) {
    const [read, write] = signal;
    const current = read();
    if (shouldUpdate ? shouldUpdate(current, value) : current !== value) {
      write(value);
      return true;
    }
    return false;
  }

  function updateRenderProjectionSlot<T>(
    slot: RenderProjectionSlot<T>,
    value: T,
    shouldUpdate?: (current: T, next: T) => boolean,
  ): boolean {
    slot.value = value;
    if (!slot.signal) {
      return false;
    }
    return updateRenderProjectionSignal(slot.signal, value, shouldUpdate);
  }

  function shouldUpdateSignalList(current: Array<VisualElementSignal>, next: Array<VisualElementSignal>): boolean {
    if (current.length !== next.length) {
      return true;
    }
    for (let i = 0; i < current.length; i++) {
      if (current[i] !== next[i]) {
        return true;
      }
    }
    return false;
  }

  function updateRenderProjectionPopup(path: VisualElementPath, value: VisualElementSignal | null): boolean {
    return updateRenderProjectionSlot(getRenderProjection(path).popup, value);
  }

  function updateRenderProjectionNode(path: VisualElementPath, value: VisualElementSignal | undefined) {
    updateRenderProjectionSlot(getRenderProjection(path).node, value);
  }

  function updateRenderProjectionSelected(path: VisualElementPath, value: VisualElementSignal | null): boolean {
    return updateRenderProjectionSlot(getRenderProjection(path).selected, value);
  }

  function updateRenderProjectionDock(path: VisualElementPath, value: VisualElementSignal | null): boolean {
    return updateRenderProjectionSlot(getRenderProjection(path).dock, value);
  }

  function updateRenderProjectionFocused(path: VisualElementPath, value: Item | null): boolean {
    return updateRenderProjectionSlot(getRenderProjection(path).focused, value, (current, next) => {
      if (current?.id !== next?.id) {
        return true;
      }
      return current !== next;
    });
  }

  function updateRenderProjectionAttachments(path: VisualElementPath, value: Array<VisualElementSignal> | undefined): boolean {
    const actualValue = value ?? [];
    return updateRenderProjectionSlot(getRenderProjection(path).attachments, actualValue, shouldUpdateSignalList);
  }

  function updateRenderProjectionChildren(path: VisualElementPath, value: Array<VisualElementSignal> | undefined): boolean {
    const actualValue = value ?? [];
    return updateRenderProjectionSlot(getRenderProjection(path).children, actualValue, shouldUpdateSignalList);
  }

  function updateRenderProjectionLineChildren(path: VisualElementPath, value: Array<VisualElementSignal> | undefined): boolean {
    const actualValue = value ?? [];
    return updateRenderProjectionSlot(getRenderProjection(path).lineChildren, actualValue, shouldUpdateSignalList);
  }

  function updateRenderProjectionDesktopChildren(path: VisualElementPath, value: Array<VisualElementSignal> | undefined): boolean {
    const actualValue = value ?? [];
    return updateRenderProjectionSlot(getRenderProjection(path).desktopChildren, actualValue, shouldUpdateSignalList);
  }

  function updateRenderProjectionNonMovingChildren(path: VisualElementPath, value: Array<VisualElementSignal> | undefined): boolean {
    const actualValue = value ?? [];
    return updateRenderProjectionSlot(getRenderProjection(path).nonMovingChildren, actualValue, shouldUpdateSignalList);
  }

  function setRenderProjectionTableRows(path: VisualElementPath, rows: Array<number> | null) {
    getRenderProjection(path).tableRows = rows ? rows.slice() : null;
  }

  function setUnderConstructionRenderTableRows(path: VisualElementPath, rows: Array<number> | null | undefined) {
    if (rows == null) {
      state.underConstructionRenderTableRowsByPath.delete(path);
      return;
    }
    state.underConstructionRenderTableRowsByPath.set(path, rows.slice());
  }

  function getCurrentRenderTableRows(path: VisualElementPath): Array<number> | null {
    return state.renderProjectionByPath.get(path)?.tableRows ?? null;
  }

  function getUnderConstructionRenderTableRows(path: VisualElementPath): Array<number> | null {
    return state.underConstructionRenderTableRowsByPath.get(path) ?? null;
  }

  function clearRenderProjectionForPath(path: VisualElementPath) {
    const entry = findRenderProjection(path);
    if (!entry) {
      return;
    }

    updateRenderProjectionSlot(entry.node, undefined);
    updateRenderProjectionSlot(entry.popup, null);
    updateRenderProjectionSlot(entry.selected, null);
    updateRenderProjectionSlot(entry.dock, null);
    updateRenderProjectionSlot(entry.attachments, [], shouldUpdateSignalList);
    updateRenderProjectionSlot(entry.children, [], shouldUpdateSignalList);
    updateRenderProjectionSlot(entry.lineChildren, [], shouldUpdateSignalList);
    updateRenderProjectionSlot(entry.desktopChildren, [], shouldUpdateSignalList);
    updateRenderProjectionSlot(entry.nonMovingChildren, [], shouldUpdateSignalList);
    updateRenderProjectionSlot(entry.focused, null, (current, next) => {
      if (current?.id !== next?.id) {
        return true;
      }
      return current !== next;
    });
    entry.tableRows = null;
  }

  function deleteRenderProjectionForPath(path: VisualElementPath) {
    state.renderProjectionByPath.delete(path);
  }

  return {
    getRenderProjection,
    findRenderProjection,
    ensureRenderProjectionSignal,
    readRenderProjectionSignal,
    updateRenderProjectionPopup,
    updateRenderProjectionNode,
    updateRenderProjectionSelected,
    updateRenderProjectionDock,
    updateRenderProjectionFocused,
    updateRenderProjectionAttachments,
    updateRenderProjectionChildren,
    updateRenderProjectionLineChildren,
    updateRenderProjectionDesktopChildren,
    updateRenderProjectionNonMovingChildren,
    setRenderProjectionTableRows,
    setUnderConstructionRenderTableRows,
    getCurrentRenderTableRows,
    getUnderConstructionRenderTableRows,
    clearRenderProjectionForPath,
    deleteRenderProjectionForPath,
  };
}
