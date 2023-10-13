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

import { Accessor, createSignal, Setter } from "solid-js";
import { Vector } from "./geometry";
import { Uid } from "./uid";
import { VisualElement, VisualElementPath } from "../layout/visual-element";


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


export interface VectorSignal {
  get: Accessor<Vector>,
  set: Setter<Vector>,
}

export function createVectorSignal(v: Vector): VectorSignal {
  let [vectorAccessor, vectorSetter] = createSignal<Vector>(v, { equals: false });
  return { get: vectorAccessor, set: vectorSetter };
}


export interface VisualElementSignal {
  get: Accessor<VisualElement>,
  set: Setter<VisualElement>,
}

export function createVisualElementSignal(v: VisualElement): VisualElementSignal {
  let [visualElementAccessor, visualElementSetter] = createSignal<VisualElement>(v, { equals: false });
  return { get: visualElementAccessor, set: visualElementSetter };
}


export interface UidSignal {
  get: Accessor<Uid>,
  set: Setter<Uid>,
}

export function createUidSignal(uid: Uid): UidSignal {
  let [uidAccessor, uidSetter] = createSignal<Uid>(uid, { equals: false });
  return { get: uidAccessor, set: uidSetter };
}


export interface VisualElementPathSignal {
  get: Accessor<VisualElementPath>,
  set: Setter<VisualElementPath>,
}

export function createVisualElementPathSignal(v: VisualElementPath): VisualElementPathSignal {
  let [visualElementPathAccessor, visualElementPathSetter] = createSignal<VisualElementPath>(v, { equals: false });
  return { get: visualElementPathAccessor, set: visualElementPathSetter };
}
