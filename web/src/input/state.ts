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
import { VeFns, VisualElement, VisualElementFlags, VisualElementPath } from "../layout/visual-element";
import { itemState } from "../store/ItemState";
import { StoreContextModel } from "../store/StoreProvider";
import { BoundingBox, Vector, desktopPxFromMouseEvent } from "../util/geometry";
import { panic } from "../util/lang";
import { VisualElementSignal } from "../util/signals";
import { Item } from "../items/base/item";
import { HitInfo, HitInfoFns } from "./hit";
import type { CalendarMonthResize } from "../util/calendar-layout";


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
  ResizingCalendarMonth,
  ResizingDockItem,
  Selecting,
}

export interface MoveRollbackSnapshotEntry {
  id: string,
  parentId: string,
  relationshipToParent: string,
  ordering: Uint8Array,
  spatialPositionGr: Vector,
  dateTime: number,
  noteFlags?: number | null,
}


export interface MouseActionStateType {
  hitboxTypeOnMouseDown: HitboxFlags,
  compositeHitboxTypeMaybeOnMouseDown: HitboxFlags,

  hitMeta: HitboxMeta | null,

  startActiveElementParent: VisualElementPath,
  activeElementPath: VisualElementPath,
  activeCompositeElementMaybe: VisualElementPath | null,

  activeRoot: VisualElementPath,
  selectionRoot: VisualElementPath,

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
  startCalendarMonthResize: CalendarMonthResize | null,

  startAttachmentsItem: AttachmentsItem | null,     // when taking an attachment out of a table.
  startCompositeItem: CompositeItem | null,         // when taking an item out of a composite item.

  clickOffsetProp: Vector | null,

  action: MouseAction,
  linkCreatedOnMoveStart: boolean,

  onePxSizeBl: Vector,
  newPlaceholderItem: PlaceholderItem | null,
  moveRollback: Array<MoveRollbackSnapshotEntry> | null,

  hitEmbeddedInteractive: boolean,

  groupMoveItems?: Array<{ veid: { itemId: string, linkIdMaybe: string | null }, startPosGr: { x: number, y: number }, parentId: string }>,
}

type MouseActionStateInit = Omit<
  MouseActionStateType,
  "moveOver_containerElement" |
  "moveOver_attachHitboxElement" |
  "moveOver_attachCompositeHitboxElement" |
  "action" |
  "linkCreatedOnMoveStart" |
  "newPlaceholderItem" |
  "startCalendarMonthResize" |
  "moveRollback"
> & Partial<Pick<MouseActionStateType, "action" | "linkCreatedOnMoveStart" | "newPlaceholderItem" | "startCalendarMonthResize" | "moveRollback">>;

type MouseActionStateFromHitInit = Omit<
  MouseActionStateInit,
  "activeRoot" | "selectionRoot" | "activeCompositeElementMaybe" | "hitEmbeddedInteractive" | "startActiveElementParent"
> & {
  hitInfo: HitInfo,
  hitVe: VisualElement,
};


let mouseActionState: MouseActionStateType | null = null;
let activeElementSignalCache: VisualElementSignal | null = null;

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
  signalMaybe: VisualElementSignal | null = activeElementSignalCache,
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
    activeElementSignalCache = resolvedSignal;
  } else if (signalHint && signalMatchesPath(path, signalHint)) {
    activeElementSignalCache = signalHint;
  } else {
    activeElementSignalCache = null;
  }
}

function normalizeMouseActionState(state: MouseActionStateType): void {
  setActiveElementPathInternal(state, state.activeElementPath, activeElementSignalCache);
}

function deriveActiveRootPath(rootVes: VisualElementSignal): VisualElementPath {
  const rootVe = rootVes.get();
  if (rootVe.flags & VisualElementFlags.Popup) {
    return VeFns.veToPath(VesCache.current.readNode(rootVe.parentPath!)!);
  }
  return VeFns.veToPath(rootVe);
}

function deriveSelectionRootPath(rootVes: VisualElementSignal): VisualElementPath {
  return VeFns.veToPath(rootVes.get());
}

function deriveActiveCompositeElementPath(hitInfo: HitInfo): VisualElementPath | null {
  if (!hitInfo.compositeHitboxTypeMaybe) { return null; }
  const compositeVe = HitInfoFns.getCompositeContainerVe(hitInfo);
  return compositeVe ? VeFns.veToPath(compositeVe) : null;
}

function resolveActiveElementSignal(state: MouseActionStateType): VisualElementSignal | null {
  let signal = getRenderSignalForPath(state.activeElementPath);

  if (!signal && signalMatchesPath(state.activeElementPath, activeElementSignalCache)) {
    signal = activeElementSignalCache;
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
        candidatePaths = VesCache.index.getPathsForDisplayId(displayId) ?? [];
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

  activeElementSignalCache = signal;
  return signal;
}

export let MouseActionState = {
  set: (state: MouseActionStateType | null): void => {
    if (state) {
      normalizeMouseActionState(state);
    } else {
      activeElementSignalCache = null;
    }
    mouseActionState = state;
  },

  begin: (init: MouseActionStateInit): void => {
    MouseActionState.set({
      ...init,
      moveOver_containerElement: null,
      moveOver_attachHitboxElement: null,
      moveOver_attachCompositeHitboxElement: null,
      action: init.action ?? MouseAction.Ambiguous,
      linkCreatedOnMoveStart: init.linkCreatedOnMoveStart ?? false,
      newPlaceholderItem: init.newPlaceholderItem ?? null,
      startCalendarMonthResize: init.startCalendarMonthResize ?? null,
      moveRollback: init.moveRollback ?? null,
    });
  },

  beginFromHit: (init: MouseActionStateFromHitInit): void => {
    MouseActionState.begin({
      ...init,
      startActiveElementParent: init.hitVe.parentPath!,
      activeRoot: deriveActiveRootPath(init.hitInfo.rootVes),
      selectionRoot: deriveSelectionRootPath(init.hitInfo.rootVes),
      activeCompositeElementMaybe: deriveActiveCompositeElementPath(init.hitInfo),
      hitEmbeddedInteractive: !!(init.hitVe.flags & VisualElementFlags.EmbeddedInteractiveRoot),
    });
  },

  empty: (): boolean => mouseActionState == null,

  get: (): MouseActionStateType => {
    if (mouseActionState == null) { panic!("MouseActionState.get: no mouseActionState."); }
    return mouseActionState!;
  },

  getAction: (): MouseAction => {
    return MouseActionState.get().action;
  },

  setAction: (action: MouseAction): void => {
    MouseActionState.get().action = action;
  },

  isAction: (action: MouseAction): boolean => {
    return mouseActionState?.action === action;
  },

  getHitboxTypeOnMouseDown: (): HitboxFlags => {
    return MouseActionState.get().hitboxTypeOnMouseDown;
  },

  setHitboxTypeOnMouseDown: (hitboxType: HitboxFlags): void => {
    MouseActionState.get().hitboxTypeOnMouseDown = hitboxType;
  },

  hitboxTypeIncludes: (flags: HitboxFlags): boolean => {
    return (MouseActionState.get().hitboxTypeOnMouseDown & flags) > 0;
  },

  getCompositeHitboxTypeOnMouseDown: (): HitboxFlags => {
    return MouseActionState.get().compositeHitboxTypeMaybeOnMouseDown;
  },

  compositeHitboxTypeIncludes: (flags: HitboxFlags): boolean => {
    return (MouseActionState.get().compositeHitboxTypeMaybeOnMouseDown & flags) > 0;
  },

  getHitMeta: (): HitboxMeta | null => {
    return MouseActionState.get().hitMeta;
  },

  readVisualElement: (path: VisualElementPath | null | undefined): VisualElement | null => {
    return readCurrentVisualElement(path);
  },

  getVisualElementSignal: (path: VisualElementPath | null | undefined): VisualElementSignal | null => {
    return getRenderSignalForPath(path);
  },

  getActiveRootPath: (): VisualElementPath | null => {
    return mouseActionState?.activeRoot ?? null;
  },

  readActiveRoot: (): VisualElement | null => {
    return readCurrentVisualElement(mouseActionState?.activeRoot ?? null);
  },

  getSelectionRootPath: (): VisualElementPath | null => {
    return mouseActionState?.selectionRoot ?? mouseActionState?.activeRoot ?? null;
  },

  readSelectionRoot: (): VisualElement | null => {
    return readCurrentVisualElement(mouseActionState?.selectionRoot ?? mouseActionState?.activeRoot ?? null);
  },

  getActiveCompositeElementPath: (): VisualElementPath | null => {
    return mouseActionState?.activeCompositeElementMaybe ?? null;
  },

  switchActiveElementToComposite: (): boolean => {
    if (mouseActionState == null || mouseActionState.activeCompositeElementMaybe == null) { return false; }
    const compositePath = mouseActionState.activeCompositeElementMaybe;
    MouseActionState.setActiveElementPath(compositePath);
    mouseActionState.startActiveElementParent = VeFns.parentPath(compositePath);
    return true;
  },

  getStartActiveElementParentPath: (): VisualElementPath | null => {
    return mouseActionState?.startActiveElementParent ?? null;
  },

  readStartActiveElementParent: (): VisualElement | null => {
    return readCurrentVisualElement(mouseActionState?.startActiveElementParent ?? null);
  },

  getStartDockWidthPx: (): number | null => {
    return mouseActionState?.startDockWidthPx ?? null;
  },

  getStartPx: (): Vector | null => {
    return mouseActionState?.startPx ?? null;
  },

  setStartPx: (startPx: Vector): void => {
    if (mouseActionState == null) { return; }
    mouseActionState.startPx = startPx;
  },

  getStartPosBl: (): Vector | null => {
    return mouseActionState?.startPosBl ?? null;
  },

  setStartPosBl: (startPosBl: Vector | null): void => {
    if (mouseActionState == null) { return; }
    mouseActionState.startPosBl = startPosBl;
  },

  getOnePxSizeBl: (): Vector | null => {
    return mouseActionState?.onePxSizeBl ?? null;
  },

  setOnePxSizeBl: (onePxSizeBl: Vector): void => {
    if (mouseActionState == null) { return; }
    mouseActionState.onePxSizeBl = onePxSizeBl;
  },

  getClickOffsetProp: (): Vector | null => {
    return mouseActionState?.clickOffsetProp ?? null;
  },

  setClickOffsetProp: (clickOffsetProp: Vector | null): void => {
    if (mouseActionState == null) { return; }
    mouseActionState.clickOffsetProp = clickOffsetProp;
  },

  getStartWidthBl: (): number | null => {
    return mouseActionState?.startWidthBl ?? null;
  },

  setStartWidthBl: (startWidthBl: number | null): void => {
    if (mouseActionState == null) { return; }
    mouseActionState.startWidthBl = startWidthBl;
  },

  getStartHeightBl: (): number | null => {
    return mouseActionState?.startHeightBl ?? null;
  },

  setStartHeightBl: (startHeightBl: number | null): void => {
    if (mouseActionState == null) { return; }
    mouseActionState.startHeightBl = startHeightBl;
  },

  getStartChildAreaBoundsPx: (): BoundingBox | null => {
    return mouseActionState?.startChildAreaBoundsPx ?? null;
  },

  getStartCalendarMonthResize: (): CalendarMonthResize | null => {
    return mouseActionState?.startCalendarMonthResize ?? null;
  },

  setStartCalendarMonthResize: (startCalendarMonthResize: CalendarMonthResize | null): void => {
    if (mouseActionState == null) { return; }
    mouseActionState.startCalendarMonthResize = startCalendarMonthResize;
  },

  getGroupMoveItems: (): MouseActionStateType["groupMoveItems"] | undefined => {
    return mouseActionState?.groupMoveItems;
  },

  setGroupMoveItems: (groupMoveItems: MouseActionStateType["groupMoveItems"] | undefined): void => {
    if (mouseActionState == null) { return; }
    mouseActionState.groupMoveItems = groupMoveItems;
  },

  getLinkCreatedOnMoveStart: (): boolean => {
    return mouseActionState?.linkCreatedOnMoveStart ?? false;
  },

  setLinkCreatedOnMoveStart: (linkCreatedOnMoveStart: boolean): void => {
    if (mouseActionState == null) { return; }
    mouseActionState.linkCreatedOnMoveStart = linkCreatedOnMoveStart;
  },

  getStartAttachmentsItem: (): AttachmentsItem | null => {
    return mouseActionState?.startAttachmentsItem ?? null;
  },

  setStartAttachmentsItem: (startAttachmentsItem: AttachmentsItem | null): void => {
    if (mouseActionState == null) { return; }
    mouseActionState.startAttachmentsItem = startAttachmentsItem;
  },

  getStartCompositeItem: (): CompositeItem | null => {
    return mouseActionState?.startCompositeItem ?? null;
  },

  setStartCompositeItem: (startCompositeItem: CompositeItem | null): void => {
    if (mouseActionState == null) { return; }
    mouseActionState.startCompositeItem = startCompositeItem;
  },

  getNewPlaceholderItem: (): PlaceholderItem | null => {
    return mouseActionState?.newPlaceholderItem ?? null;
  },

  setNewPlaceholderItem: (newPlaceholderItem: PlaceholderItem | null): void => {
    if (mouseActionState == null) { return; }
    mouseActionState.newPlaceholderItem = newPlaceholderItem;
  },

  getMoveRollback: (): Array<MoveRollbackSnapshotEntry> | null => {
    return mouseActionState?.moveRollback ?? null;
  },

  setMoveRollback: (moveRollback: Array<MoveRollbackSnapshotEntry> | null): void => {
    if (mouseActionState == null) { return; }
    mouseActionState.moveRollback = moveRollback;
  },

  usesEmbeddedInteractiveHitTesting: (): boolean => {
    return mouseActionState?.hitEmbeddedInteractive ?? false;
  },

  getMoveOverContainerPath: (): VisualElementPath | null => {
    return mouseActionState?.moveOver_containerElement ?? null;
  },

  setMoveOverContainerPath: (path: VisualElementPath | null): void => {
    if (mouseActionState == null) { return; }
    mouseActionState.moveOver_containerElement = path;
  },

  readMoveOverContainer: (): VisualElement | null => {
    return readCurrentVisualElement(mouseActionState?.moveOver_containerElement ?? null);
  },

  getMoveOverAttachHitboxPath: (): VisualElementPath | null => {
    return mouseActionState?.moveOver_attachHitboxElement ?? null;
  },

  setMoveOverAttachHitboxPath: (path: VisualElementPath | null): void => {
    if (mouseActionState == null) { return; }
    mouseActionState.moveOver_attachHitboxElement = path;
  },

  readMoveOverAttachHitbox: (): VisualElement | null => {
    return readCurrentVisualElement(mouseActionState?.moveOver_attachHitboxElement ?? null);
  },

  getMoveOverAttachCompositePath: (): VisualElementPath | null => {
    return mouseActionState?.moveOver_attachCompositeHitboxElement ?? null;
  },

  setMoveOverAttachCompositePath: (path: VisualElementPath | null): void => {
    if (mouseActionState == null) { return; }
    mouseActionState.moveOver_attachCompositeHitboxElement = path;
  },

  readMoveOverAttachComposite: (): VisualElement | null => {
    return readCurrentVisualElement(mouseActionState?.moveOver_attachCompositeHitboxElement ?? null);
  },

  getScaleDefiningElementPath: (): VisualElementPath | null => {
    return mouseActionState?.moveOver_scaleDefiningElement ?? null;
  },

  setScaleDefiningElementPath: (path: VisualElementPath | null): void => {
    if (mouseActionState == null) { return; }
    mouseActionState.moveOver_scaleDefiningElement = path;
  },

  readScaleDefiningElement: (): VisualElement | null => {
    return readCurrentVisualElement(mouseActionState?.moveOver_scaleDefiningElement ?? null);
  },

  setActiveElementPath: (path: VisualElementPath, signalHint: VisualElementSignal | null = null): void => {
    setActiveElementPathInternal(MouseActionState.get(), path, signalHint);
  },

  getActiveElementPath: (): VisualElementPath | null => {
    return mouseActionState?.activeElementPath ?? null;
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
  setFromClientPx: (clientX: number, clientY: number, shiftDown: boolean = false, ctrlDown: boolean = false) => {
    lastMoveEvent = {
      clientX,
      clientY,
      shiftDown,
      ctrlDown,
    };
  },

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
