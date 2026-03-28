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

import { AttachmentsItem } from "../items/base/attachments-item";
import { CompositeItem } from "../items/composite-item";
import { PlaceholderItem } from "../items/placeholder-item";
import { HitboxMeta, HitboxFlags } from "../layout/hitbox";
import { VesCache } from "../layout/ves-cache";
import { VeFns, VisualElement, VisualElementPath } from "../layout/visual-element";
import { itemState } from "../store/ItemState";
import { StoreContextModel } from "../store/StoreProvider";
import { BoundingBox, Vector, desktopPxFromMouseEvent } from "../util/geometry";
import { panic } from "../util/lang";
import { VisualElementSignal } from "../util/signals";
import { Item } from "../items/base/item";


// ### MouseAction State

export enum MouseAction {
  Ambiguous,
  Moving,
  MovingPopup,
  Resizing,
  ResizingColumn,
  ResizingPopup,
  ResizingDock,
  ResizingListPageColumn,
  ResizingDockItem,
  Selecting,
}


export interface MouseActionStateType {
  hitboxTypeOnMouseDown: HitboxFlags,
  compositeHitboxTypeMaybeOnMouseDown: HitboxFlags,

  hitMeta: HitboxMeta | null,

  startActiveElementParent: VisualElementPath,
  activeElementPath: VisualElementPath,
  activeCompositeElementMaybe: VisualElementPath | null,
  activeElementSignalMaybe: VisualElementSignal | null,

  activeRoot: VisualElementPath,

  moveOver_containerElement: VisualElementPath | null,
  moveOver_attachHitboxElement: VisualElementPath | null,
  moveOver_attachCompositeHitboxElement: VisualElementPath | null,
  moveOver_scaleDefiningElement: VisualElementPath | null,

  startPx: Vector,
  startPosBl: Vector | null,
  startWidthBl: number | null,
  startHeightBl: number | null,
  startDockWidthPx: number | null,
  startChildAreaBoundsPx: BoundingBox | null,

  startAttachmentsItem: AttachmentsItem | null,     // when taking an attachment out of a table.
  startCompositeItem: CompositeItem | null,         // when taking an item out of a composite item.

  clickOffsetProp: Vector | null,

  action: MouseAction,
  linkCreatedOnMoveStart: boolean,

  onePxSizeBl: Vector,
  newPlaceholderItem: PlaceholderItem | null,

  hitEmbeddedInteractive: boolean,

  groupMoveItems?: Array<{ veid: { itemId: string, linkIdMaybe: string | null }, startPosGr: { x: number, y: number }, parentId: string }>,
}


let mouseActionState: MouseActionStateType | null = null;

function getRenderSignalForPath(path: VisualElementPath | null | undefined): VisualElementSignal | null {
  if (!path) { return null; }
  return VesCache.render.getNode(path) ?? null;
}

function readCurrentVisualElement(path: VisualElementPath | null | undefined): VisualElement | null {
  if (!path) { return null; }
  return VesCache.current.readNode(path) ?? null;
}

function tryGetSignalPath(signal: VisualElementSignal | null): VisualElementPath | null {
  if (!signal) { return null; }
  try {
    return VeFns.veToPath(signal.get());
  } catch {
    return null;
  }
}

function signalMatchesPath(path: VisualElementPath, signal: VisualElementSignal | null): boolean {
  return tryGetSignalPath(signal) === path;
}

function deriveActiveElementLinkState(
  state: MouseActionStateType,
  signalMaybe: VisualElementSignal | null = state.activeElementSignalMaybe,
): { activeLinkIdMaybe: string | null, activeLinkedDisplayItemMaybe: Item | null } {
  let activeVe: VisualElement | null = null;

  if (signalMaybe && signalMatchesPath(state.activeElementPath, signalMaybe)) {
    try {
      activeVe = signalMaybe.get();
    } catch {
      activeVe = null;
    }
  }

  if (!activeVe) {
    activeVe = readCurrentVisualElement(state.activeElementPath);
  }

  if (activeVe) {
    const activeLinkIdMaybe = activeVe.actualLinkItemMaybe?.id ?? activeVe.linkItemMaybe?.id ?? null;
    return {
      activeLinkIdMaybe,
      activeLinkedDisplayItemMaybe: activeLinkIdMaybe ? activeVe.displayItem : null,
    };
  }

  const veid = VeFns.veidFromPath(state.activeElementPath);
  const activeLinkIdMaybe = veid.linkIdMaybe ?? null;
  return {
    activeLinkIdMaybe,
    activeLinkedDisplayItemMaybe: activeLinkIdMaybe ? itemState.get(veid.itemId) ?? null : null,
  };
}

function setActiveElementPathInternal(state: MouseActionStateType, path: VisualElementPath, signalHint: VisualElementSignal | null = null): void {
  state.activeElementPath = path;
  const resolvedSignal = getRenderSignalForPath(path);
  if (resolvedSignal) {
    state.activeElementSignalMaybe = resolvedSignal;
  } else if (signalHint && signalMatchesPath(path, signalHint)) {
    state.activeElementSignalMaybe = signalHint;
  } else {
    state.activeElementSignalMaybe = null;
  }
}

function normalizeMouseActionState(state: MouseActionStateType): void {
  setActiveElementPathInternal(state, state.activeElementPath, state.activeElementSignalMaybe);
}

function resolveActiveElementSignal(state: MouseActionStateType): VisualElementSignal | null {
  let signal = getRenderSignalForPath(state.activeElementPath);

  if (!signal && signalMatchesPath(state.activeElementPath, state.activeElementSignalMaybe)) {
    signal = state.activeElementSignalMaybe;
  }

  if (!signal) {
    const veid = VeFns.veidFromPath(state.activeElementPath);

    const findByDisplayId = (
      displayId: string | null,
      match: (vePath: VisualElementPath, veSignal: VisualElementSignal) => boolean,
    ): VisualElementSignal | null => {
      if (!displayId) { return null; }
      let candidatePaths: Array<VisualElementPath> = [];
      try {
        candidatePaths = VesCache.getPathsForDisplayId(displayId) ?? [];
      } catch {
        candidatePaths = [];
      }
      for (const path of candidatePaths) {
        const candidateSignal = getRenderSignalForPath(path);
        if (!candidateSignal) { continue; }
        if (match(path, candidateSignal)) {
          return candidateSignal;
        }
      }
      return null;
    };

    const matchFromParent = (parentPath: VisualElementPath | null | undefined): VisualElementSignal | null => {
      if (!parentPath) { return null; }
      return VesCache.render.getChildren(parentPath)().find(childSignal => {
        const childVeid = VeFns.veidFromVe(childSignal.get());
        return childVeid.itemId === veid.itemId && childVeid.linkIdMaybe === veid.linkIdMaybe;
      }) ?? null;
    };

    const candidateParents: Array<VisualElementPath> = [];
    const directParent = VeFns.parentPath(state.activeElementPath);
    if (directParent && directParent.length > 0) { candidateParents.push(directParent); }
    if (state.moveOver_scaleDefiningElement) { candidateParents.push(state.moveOver_scaleDefiningElement); }
    if (state.startActiveElementParent) { candidateParents.push(state.startActiveElementParent); }

    for (const parentPath of candidateParents) {
      signal = matchFromParent(parentPath);
      if (signal) { break; }
    }

    let findSingleError: unknown = null;
    if (!signal) {
      try {
        signal = VesCache.render.findSingle(veid);
      } catch (err) {
        findSingleError = err;
      }
    }

    if (!signal) {
      signal = findByDisplayId(veid.itemId, (path, _) => {
        const candidateVeid = VeFns.veidFromPath(path);
        return candidateVeid.itemId === veid.itemId && candidateVeid.linkIdMaybe === veid.linkIdMaybe;
      });
    }

    if (!signal) {
      const treeItemId = veid.linkIdMaybe ?? veid.itemId;
      signal = findByDisplayId(treeItemId, (_, candidateSignal) => {
        try {
          return VeFns.treeItem(candidateSignal.get()).id === treeItemId;
        } catch {
          return false;
        }
      });
    }

    if (!signal) {
      console.warn("Active visual element path still missing; abandoning current mouse action.", {
        path: state.activeElementPath,
        veid,
        err: findSingleError,
      });
      return null;
    }

    state.activeElementPath = VeFns.veToPath(signal.get());
  }

  state.activeElementSignalMaybe = signal;
  return signal;
}

export let MouseActionState = {
  set: (state: MouseActionStateType | null): void => {
    if (state) {
      normalizeMouseActionState(state);
    }
    mouseActionState = state;
  },

  empty: (): boolean => mouseActionState == null,

  get: (): MouseActionStateType => {
    if (mouseActionState == null) { panic!("MouseActionState.get: no mouseActionState."); }
    return mouseActionState!;
  },

  readVisualElement: (path: VisualElementPath | null | undefined): VisualElement | null => {
    return readCurrentVisualElement(path);
  },

  getVisualElementSignal: (path: VisualElementPath | null | undefined): VisualElementSignal | null => {
    return getRenderSignalForPath(path);
  },

  setActiveElementPath: (path: VisualElementPath, signalHint: VisualElementSignal | null = null): void => {
    setActiveElementPathInternal(MouseActionState.get(), path, signalHint);
  },

  getActiveLinkIdMaybe: (): string | null => {
    const state = mouseActionState;
    if (state == null) { return null; }
    return deriveActiveElementLinkState(state).activeLinkIdMaybe;
  },

  getActiveLinkedDisplayItemMaybe: (): Item | null => {
    const state = mouseActionState;
    if (state == null) { return null; }
    return deriveActiveElementLinkState(state).activeLinkedDisplayItemMaybe;
  },

  getActiveVisualElementSignal: (): VisualElementSignal | null => {
    const state = MouseActionState.get();
    const signal = resolveActiveElementSignal(state);
    if (!signal) {
      console.warn("Unable to resolve active visual element; cancelling current mouse action.", { path: state.activeElementPath });
      MouseActionState.set(null);
      return null;
    }
    return signal;
  },

  getActiveVisualElement: (): VisualElement | null => {
    const state = mouseActionState;
    if (state == null) { return null; }
    const signal = resolveActiveElementSignal(state);
    if (signal) { return signal.get(); }
    return readCurrentVisualElement(state.activeElementPath);
  },
}



// ### User Settings State

export interface UserSettingsMoveStateType {
  lastMousePosPx: Vector,
}


export let userSettingsMoveState: UserSettingsMoveStateType | null = null;

export let UserSettingsMoveState = {
  set: (state: UserSettingsMoveStateType | null): void => { userSettingsMoveState = state; },

  empty: (): boolean => userSettingsMoveState == null,

  get: (): UserSettingsMoveStateType | null => userSettingsMoveState
}



// ### Mouse MoveEvent State

export interface TouchOrMouseEvent {
  clientX: number,
  clientY: number,
  shiftDown: boolean,
  ctrlDown: boolean,
}

let lastMoveEvent: TouchOrMouseEvent = {
  clientX: 0,
  clientY: 0,
  shiftDown: false,
  ctrlDown: false,
};

export const CursorEventState = {
  setFromMouseEvent: (ev: MouseEvent) => {
    lastMoveEvent = {
      clientX: ev.clientX,
      clientY: ev.clientY,
      shiftDown: ev.shiftKey,
      ctrlDown: ev.ctrlKey,
    };
  },

  setFromTouchEvent: (ev: TouchEvent) => {
    lastMoveEvent = {
      clientX: ev.touches[0].clientX,
      clientY: ev.touches[0].clientY,
      shiftDown: false,
      ctrlDown: false,
    }
  },

  get: (): TouchOrMouseEvent => lastMoveEvent,

  getLatestClientPx: (): Vector => ({ x: lastMoveEvent.clientX, y: lastMoveEvent.clientY }),

  getLatestDesktopPx: (store: StoreContextModel): Vector => desktopPxFromMouseEvent(lastMoveEvent, store),
}



// ### Double Click State

const DOUBLE_CLICK_TIMEOUT_MS = 500; // this is standard.
let canDoubleClick = true;
let timer: any = undefined;

export const DoubleClickState = {
  preventDoubleClick: (): void => {
    if (timer === undefined) {
      clearTimeout(timer);
    }
    canDoubleClick = false;
    timer = setTimeout(() => {
      canDoubleClick = true;
      timer = undefined;
    }, DOUBLE_CLICK_TIMEOUT_MS);
  },

  canDoubleClick: (): boolean => {
    return canDoubleClick;
  },
}



// ### Click State

let buttonClickBounds: BoundingBox | null = null;
let linkWasClicked: boolean = false;
export const ClickState = {
  setLinkWasClicked: (clickState: boolean): void => {
    linkWasClicked = clickState;
  },

  getLinkWasClicked: (): boolean => {
    return linkWasClicked;
  },

  setButtonClickBoundsPx: (bounds: DOMRect | null): void => {
    if (bounds == null) {
      buttonClickBounds = null;
      return;
    }
    buttonClickBounds = {
      x: bounds.x,
      y: bounds.y,
      w: bounds.width,
      h: bounds.height
    };
  },

  getButtonClickBoundsPx: (): BoundingBox | null => {
    return buttonClickBounds;
  }
}
