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
import { ReactiveEntry, ReactiveRef, VesCacheState } from "./state";

export type ReactiveOps = ReturnType<typeof createReactiveOps>;

export function createReactiveOps(state: VesCacheState) {
  function createReactiveEntry(): ReactiveEntry {
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

  function getReactiveEntry(path: VisualElementPath): ReactiveEntry {
    let entry = state.reactiveEntriesByPath.get(path);
    if (!entry) {
      entry = createReactiveEntry();
      state.reactiveEntriesByPath.set(path, entry);
    }
    return entry;
  }

  function findReactiveEntry(path: VisualElementPath): ReactiveEntry | undefined {
    return state.reactiveEntriesByPath.get(path);
  }

  function ensureReactiveSignal<T>(
    slot: ReactiveRef<T>,
  ): [Accessor<T>, Setter<T>] {
    if (slot.signal) {
      return slot.signal;
    }
    const signal = createSignal<T>(slot.value);
    slot.signal = signal;
    return signal;
  }

  function readReactiveSignal<T>(slot: ReactiveRef<T>): T {
    return slot.signal ? slot.signal[0]() : slot.value;
  }

  function updateReactiveSignal<T>(
    signal: [Accessor<T>, Setter<T>],
    value: T,
    shouldUpdate?: (current: T, next: T) => boolean,
  ) {
    const [read, write] = signal;
    const current = read();
    if (shouldUpdate ? shouldUpdate(current, value) : current !== value) {
      write(() => value);
      return true;
    }
    return false;
  }

  function updateReactiveSlot<T>(
    slot: ReactiveRef<T>,
    value: T,
    shouldUpdate?: (current: T, next: T) => boolean,
  ): boolean {
    slot.value = value;
    if (!slot.signal) {
      return false;
    }
    return updateReactiveSignal(slot.signal, value, shouldUpdate);
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

  function updateReactivePopup(path: VisualElementPath, value: VisualElementSignal | null): boolean {
    return updateReactiveSlot(getReactiveEntry(path).popup, value);
  }

  function updateReactiveNode(path: VisualElementPath, value: VisualElementSignal | undefined) {
    updateReactiveSlot(getReactiveEntry(path).node, value);
  }

  function updateReactiveSelected(path: VisualElementPath, value: VisualElementSignal | null): boolean {
    return updateReactiveSlot(getReactiveEntry(path).selected, value);
  }

  function updateReactiveDock(path: VisualElementPath, value: VisualElementSignal | null): boolean {
    return updateReactiveSlot(getReactiveEntry(path).dock, value);
  }

  function updateReactiveFocused(path: VisualElementPath, value: Item | null): boolean {
    return updateReactiveSlot(getReactiveEntry(path).focused, value, (current, next) => {
      if (current?.id !== next?.id) {
        return true;
      }
      return current !== next;
    });
  }

  function updateReactiveAttachments(path: VisualElementPath, value: Array<VisualElementSignal> | undefined): boolean {
    const actualValue = value ?? [];
    return updateReactiveSlot(getReactiveEntry(path).attachments, actualValue, shouldUpdateSignalList);
  }

  function updateReactiveChildren(path: VisualElementPath, value: Array<VisualElementSignal> | undefined): boolean {
    const actualValue = value ?? [];
    return updateReactiveSlot(getReactiveEntry(path).children, actualValue, shouldUpdateSignalList);
  }

  function updateReactiveLineChildren(path: VisualElementPath, value: Array<VisualElementSignal> | undefined): boolean {
    const actualValue = value ?? [];
    return updateReactiveSlot(getReactiveEntry(path).lineChildren, actualValue, shouldUpdateSignalList);
  }

  function updateReactiveDesktopChildren(path: VisualElementPath, value: Array<VisualElementSignal> | undefined): boolean {
    const actualValue = value ?? [];
    return updateReactiveSlot(getReactiveEntry(path).desktopChildren, actualValue, shouldUpdateSignalList);
  }

  function updateReactiveNonMovingChildren(path: VisualElementPath, value: Array<VisualElementSignal> | undefined): boolean {
    const actualValue = value ?? [];
    return updateReactiveSlot(getReactiveEntry(path).nonMovingChildren, actualValue, shouldUpdateSignalList);
  }

  function setReactiveTableRows(path: VisualElementPath, rows: Array<number> | null) {
    getReactiveEntry(path).tableRows = rows ? rows.slice() : null;
  }

  function setUnderConstructionReactiveTableRows(path: VisualElementPath, rows: Array<number> | null | undefined) {
    if (rows == null) {
      state.underConstructionReactiveTableRowsByPath.delete(path);
      return;
    }
    state.underConstructionReactiveTableRowsByPath.set(path, rows.slice());
  }

  function getCurrentReactiveTableRows(path: VisualElementPath): Array<number> | null {
    return state.reactiveEntriesByPath.get(path)?.tableRows ?? null;
  }

  function getUnderConstructionReactiveTableRows(path: VisualElementPath): Array<number> | null {
    return state.underConstructionReactiveTableRowsByPath.get(path) ?? null;
  }

  function clearReactiveForPath(path: VisualElementPath) {
    const entry = findReactiveEntry(path);
    if (!entry) {
      return;
    }

    updateReactiveSlot(entry.node, undefined);
    updateReactiveSlot(entry.popup, null);
    updateReactiveSlot(entry.selected, null);
    updateReactiveSlot(entry.dock, null);
    updateReactiveSlot(entry.attachments, [], shouldUpdateSignalList);
    updateReactiveSlot(entry.children, [], shouldUpdateSignalList);
    updateReactiveSlot(entry.lineChildren, [], shouldUpdateSignalList);
    updateReactiveSlot(entry.desktopChildren, [], shouldUpdateSignalList);
    updateReactiveSlot(entry.nonMovingChildren, [], shouldUpdateSignalList);
    updateReactiveSlot(entry.focused, null, (current, next) => {
      if (current?.id !== next?.id) {
        return true;
      }
      return current !== next;
    });
    entry.tableRows = null;
  }

  function deleteReactiveForPath(path: VisualElementPath) {
    state.reactiveEntriesByPath.delete(path);
  }

  return {
    getReactiveEntry,
    findReactiveEntry,
    ensureReactiveSignal,
    readReactiveSignal,
    updateReactivePopup,
    updateReactiveNode,
    updateReactiveSelected,
    updateReactiveDock,
    updateReactiveFocused,
    updateReactiveAttachments,
    updateReactiveChildren,
    updateReactiveLineChildren,
    updateReactiveDesktopChildren,
    updateReactiveNonMovingChildren,
    setReactiveTableRows,
    setUnderConstructionReactiveTableRows,
    getCurrentReactiveTableRows,
    getUnderConstructionReactiveTableRows,
    clearReactiveForPath,
    deleteReactiveForPath,
  };
}
