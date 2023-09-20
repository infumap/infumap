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

import { Vector } from "../util/geometry";
import { panic } from "../util/lang";


export interface DialogMoveState {
  lastMousePosPx: Vector,
}

export let dialogMoveState: DialogMoveState | null = null;

export let DialogMoveState = {
  set: (state: DialogMoveState | null): void => { dialogMoveState = state; },
  empty: (): boolean => { return dialogMoveState == null; },
  get: (): DialogMoveState => { if (dialogMoveState == null) { panic(); } return dialogMoveState!; }
}
