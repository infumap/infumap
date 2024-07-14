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
import { StoreContextModel } from "../store/StoreProvider";
import { BoundingBox, Vector, desktopPxFromMouseEvent } from "../util/geometry";
import { panic } from "../util/lang";


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
  Selecting,
}


export interface MouseActionStateType {
  hitboxTypeOnMouseDown: HitboxFlags,
  compositeHitboxTypeMaybeOnMouseDown: HitboxFlags,

  hitMeta: HitboxMeta | null,

  startActiveElementParent: VisualElementPath,
  activeElementPath: VisualElementPath,
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
  startDockWidthPx: number | null,

  startAttachmentsItem: AttachmentsItem | null,     // when taking an attachment out of a table.
  startCompositeItem: CompositeItem | null,         // when taking an item out of a composite item.

  clickOffsetProp: Vector | null,

  action: MouseAction,
  linkCreatedOnMoveStart: boolean,

  onePxSizeBl: Vector,
  newPlaceholderItem: PlaceholderItem | null,

  hitEmbeddedInteractive: boolean,
}


let mouseActionState: MouseActionStateType | null = null;

export let MouseActionState = {
  set: (state: MouseActionStateType | null): void => { mouseActionState = state; },

  empty: (): boolean => mouseActionState == null,

  get: (): MouseActionStateType => {
    if (mouseActionState == null) { panic!("MouseActionState.get: no mouseActionState."); }
    return mouseActionState!;
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
}

let lastMoveEvent: TouchOrMouseEvent = {
  clientX: 0,
  clientY: 0,
  shiftDown: false,
};

export const CursorEventState = {
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
