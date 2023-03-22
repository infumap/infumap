/*
  Copyright (C) 2023 The Infumap Authors
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

import { Accessor, createSignal, Setter } from "solid-js";
import { Uid } from "./uid";


export interface NumberSignal {
  get: Accessor<number>,
  set: Setter<number>,
}

export function createNumberSignal(number: number): NumberSignal {
  let [numberAccessor, numberSetter] = createSignal<number>(number, { equals: false });
  return { get: numberAccessor, set: numberSetter };
}


export interface BooleanSignal {
  get: Accessor<boolean>,
  set: Setter<boolean>,
}

export function createBooleanSignal(v: boolean): BooleanSignal {
  let [booleanAccessor, booleanSetter] = createSignal<boolean>(v, { equals: false });
  return { get: booleanAccessor, set: booleanSetter };
}


export interface UidArraySignal {
  get: Accessor<Array<Uid>>,
  set: Setter<Array<Uid>>,
}

export function createUidArraySignal(array: Array<Uid>): UidArraySignal {
  let [arrayAccessor, arraySetter] = createSignal<Array<Uid>>([], { equals: false });
  return { get: arrayAccessor, set: arraySetter };
}