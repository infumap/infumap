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
import { VisualElementPath } from "../layout/visual-element";
import { Vector } from "../util/geometry";
import { panic } from "../util/lang";



// ### MouseAction State

export enum MouseAction {
  Ambiguous,
  Moving,
  MovingPopup,
  Resizing,
  ResizingColumn,
  ResizingPopup,
}

export interface MouseActionStateType {
  hitboxTypeOnMouseDown: HitboxFlags,
  compositeHitboxTypeMaybeOnMouseDown: HitboxFlags,

  hitMeta: HitboxMeta | null,

  activeElement: VisualElementPath,
  activeCompositeElementMaybe: VisualElementPath | null,

  activeRoot: VisualElementPath,

  moveOver_containerElement: VisualElementPath | null,
  moveOver_attachHitboxElement: VisualElementPath | null,
  moveOver_attachCompositeHitboxElement: VisualElementPath | null,
  moveOver_scaleDefiningElement: VisualElementPath | null,

  startPx: Vector,
  startPosBl: Vector | null,
  startWidthBl: number | null,
  startHeightBl: number | null,

  startAttachmentsItem: AttachmentsItem | null,     // when taking an attachment out of a table.
  startCompositeItem: CompositeItem | null,         // when taking an item out of a composite item.

  clickOffsetProp: Vector | null,

  action: MouseAction,

  onePxSizeBl: Vector,
  newPlaceholderItem: PlaceholderItem | null,
}


let mouseActionState: MouseActionStateType | null = null;

export let MouseActionState = {
  set: (state: MouseActionStateType | null): void => { mouseActionState = state; },

  empty: (): boolean => mouseActionState == null,

  get: (): MouseActionStateType => {
    if (mouseActionState == null) { panic!(); }
    return mouseActionState!;
  },

  debugLog: (): void => {
    if (mouseActionState == null) {
      console.debug("[null]");
      return;
    }
  }
}



// ### Dialog State

export interface DialogMoveStateType {
  lastMousePosPx: Vector,
}


export let dialogMoveState: DialogMoveStateType | null = null;

export let DialogMoveState = {
  set: (state: DialogMoveStateType | null): void => { dialogMoveState = state; },

  empty: (): boolean => dialogMoveState == null,

  get: (): DialogMoveStateType | null => dialogMoveState
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
}

let lastMoveEvent: TouchOrMouseEvent = {
  clientX: 0,
  clientY: 0,
  shiftDown: false,
};

export const LastMouseMoveEventState = {
  setFromMouseEvent: (ev: MouseEvent) => {
    lastMoveEvent = {
      clientX: ev.clientX,
      clientY: ev.clientY,
      shiftDown: ev.shiftKey,
    };
  },

  setFromTouchEvent: (ev: TouchEvent) => {
    lastMoveEvent = {
      clientX: ev.touches[0].clientX,
      clientY: ev.touches[0].clientY,
      shiftDown: false,
    }
  },

  get: (): TouchOrMouseEvent => lastMoveEvent
}



// ### Double Click State

const DOUBLE_CLICK_TIMEOUT_MS = 500; // this is standard.
let canDoubleClick = true;
let timer: number | undefined = undefined;

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

let linkWasClicked: boolean = false;
export const ClickState = {
  setLinkWasClicked: (clickState: boolean): void => {
    linkWasClicked = clickState;
  },

  getLinkWasClicked: (): boolean => {
    return linkWasClicked;
  }
}
