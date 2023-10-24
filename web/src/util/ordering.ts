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

import { panic } from "./lang";

const N = 1;

export function newOrderingBefore(start: Uint8Array): Uint8Array {
  let r: Array<number> = [];

  for (let i=0; i<start.length; ++i) {
    if (start[i] == 0) {
      r.push(0);
      continue;
    }

    if (start[i] > N) {
      r.push(start[i] - N);
      return new Uint8Array(r);
    }

    let toAdd = start[i] - 1;
    if (toAdd > 0) {
      r.push(toAdd);
      return new Uint8Array(r);
    }

    r.push(0);
    r.push(255-N);
    return new Uint8Array(r);
  }

  // should never happen, but define longer string of 0's to be before shorter one in the case it does.
  r.push(0);
  return new Uint8Array(r);
}

export function newOrderingAfter(end: Uint8Array): Uint8Array {
  let r: Array<number> = [];

  for (let i=0; i<end.length; ++i) {
    if (end[i] == 255) {
      r.push(255);
      continue;
    }

    if (end[i] > 255 - N) {
      r.push(end[i] + 1);
      return new Uint8Array(r);
    }

    r.push(end[i] + N);
    return new Uint8Array(r);
  }

  r.push(N);
  return new Uint8Array(r);
}

export function newOrderingBetween(p1: Uint8Array, p2: Uint8Array): Uint8Array {

  let cmpResult = compareOrderings(p1, p2);
  if (cmpResult == 0) {
    // should never happen, but if it does, just return the same.
    return new Uint8Array(p1);
  }
  if (cmpResult > 0) {
    let p = p1;
    p1 = p2;
    p2 = p;
  }

  let r: Array<number> = [];
  let len = Math.max(p1.length, p2.length);
  let halveNext = false;

  for (let i=0; i<len; ++i) {
    let a = i < p1.length ? p1[i] : 0;
    let b = i < p2.length ? p2[i] : 256;
    let n = Math.floor((a + b) / 2);
    if (halveNext) {
      if (a == 255) {
        r.push(255);
        r.push(128);
        return new Uint8Array(r);
      }
      n = Math.floor((a + 256) / 2);
      r.push(n);
      return new Uint8Array(r);
    }
    r.push(n)
    if (a != n) { // .. b will also never equal n because n is rounded down.
      return new Uint8Array(r);
    }
    if (b != n) {
      halveNext = true;
    }
  }

  r.push(128);

  return new Uint8Array(r);
}

// 0: if (x==y), -1: if (x < y), 1: if (x > y)
export function compareOrderings(p1: Uint8Array, p2: Uint8Array): number {
  let len = Math.min(p1.length, p2.length);
  for (let i=0; i<len; ++i) {
    if (p1[i] < p2[i]) { return -1; }
    if (p1[i] > p2[i]) { return 1; }
  }
  if (p2.length > p1.length) { return -1; }
  if (p2.length < p1.length) { return 1; }
  return 0;
}

export function newOrdering(): Uint8Array {
  return new Uint8Array([128]);
}

export function newOrderingAtEnd(orderings: Array<Uint8Array>): Uint8Array {
  if (orderings.length == 0) { return newOrdering(); }
  let highest = orderings[0];
  for (let i=1; i<orderings.length; i+=1) {
    if (compareOrderings(highest, orderings[i]) <= 0) { highest = orderings[i]; }
  }
  return newOrderingAfter(highest);
}

export function newOrderingAtBeginning(orderings: Array<Uint8Array>): Uint8Array {
  if (orderings.length == 0) { return newOrdering(); }
  let lowest = orderings[0];
  for (let i=1; i<orderings.length; i+=1) {
    if (compareOrderings(lowest, orderings[i]) >= 0) { lowest = orderings[i]; }
  }
  return newOrderingBefore(lowest);
}

export function newOrderingDirectlyAfter(orderings: Array<Uint8Array>, find: Uint8Array): Uint8Array {
  let idx = -1;
  for (let i=0; i<orderings.length; ++i) {
    if (compareOrderings(orderings[i], find) == 0) {
      idx = i;
      break;
    }
  }
  if (idx == -1) { panic("newOrderingDirectlyAfter: idx == -1"); }
  if (idx == orderings.length-1) {
    return newOrderingAtEnd(orderings);
  }
  return newOrderingBetween(orderings[idx], orderings[idx+1]);
}


export function testOrdering(): void {
  console.log('### -- Start Ordering tests');

  console.log('### -- compare');

  let p1 = new Uint8Array([55, 23]);
  let p2 = new Uint8Array([55, 24]);
  let r = compareOrderings(p1, p2);
  console.log('expect: -1', r);

  p1 = new Uint8Array([55, 24]);
  p2 = new Uint8Array([55, 23]);
  r = compareOrderings(p1, p2);
  console.log('expect: 1', r);

  p1 = new Uint8Array([55]);
  p2 = new Uint8Array([55, 23]);
  r = compareOrderings(p1, p2);
  console.log('expect: -1', r);

  p1 = new Uint8Array([55, 23]);
  p2 = new Uint8Array([55]);
  r = compareOrderings(p1, p2);
  console.log('expect: 1', r);

  p1 = new Uint8Array([55, 23]);
  p2 = new Uint8Array([55, 23]);
  r = compareOrderings(p1, p2);
  console.log('expect: 0', r);

  p1 = new Uint8Array([55, 23]);
  p2 = new Uint8Array([]);
  r = compareOrderings(p1, p2);
  console.log('expect: 1', r);

  p1 = new Uint8Array([]);
  p2 = new Uint8Array([55, 23]);
  r = compareOrderings(p1, p2);
  console.log('expect: -1', r);


  console.log('### -- newOrderingBetween tests');

  p1 = new Uint8Array([55, 23]);
  p2 = new Uint8Array([55, 24]);
  let p = newOrderingBetween(p1, p2);
  console.log('expect: [55, 23, 128]', Array.from(p));

  p1 = new Uint8Array([55, 23]);
  p2 = new Uint8Array([55, 23]);
  p = newOrderingBetween(p1, p2);
  console.log('expect: [55, 23]', Array.from(p));

  p1 = new Uint8Array([1]);
  p2 = new Uint8Array([0, 254]);
  p = newOrderingBetween(p1, p2);
  console.log('expect: [0, 255]', Array.from(p));

  p1 = new Uint8Array([1]);
  p2 = new Uint8Array([0, 250]);
  p = newOrderingBetween(p1, p2);
  console.log('expect: [0, 253]', Array.from(p));

  p1 = new Uint8Array([1]);
  p2 = new Uint8Array([0, 255]);
  p = newOrderingBetween(p1, p2);
  console.log('expect: [0, 255, 128]', Array.from(p));

  p1 = new Uint8Array([1, 31]);
  p2 = new Uint8Array([1, 32]);
  p = newOrderingBetween(p1, p2);
  console.log('expect: [1, 31, 128]', Array.from(p));

  p1 = new Uint8Array([1, 30]);
  p2 = new Uint8Array([1, 32]);
  p = newOrderingBetween(p1, p2);
  console.log('expect: [1, 31]', Array.from(p));

  p1 = new Uint8Array([1, 30]);
  p2 = new Uint8Array([1, 30, 255]);
  p = newOrderingBetween(p1, p2);
  console.log('expect: [1, 30, 127]', Array.from(p));

  p1 = new Uint8Array([1, 30]);
  p2 = new Uint8Array([1, 30, 1]);
  p = newOrderingBetween(p1, p2);
  console.log('expect: [1, 30, 0, 128]', Array.from(p));


  console.log('### -- newOrderingAfter tests');

  p1 = new Uint8Array([55]);
  p = newOrderingAfter(p1);
  console.log('expect: [63]', Array.from(p));

  p1 = new Uint8Array([254]);
  p = newOrderingAfter(p1);
  console.log('expect: [255]', Array.from(p));

  p1 = new Uint8Array([255]);
  p = newOrderingAfter(p1);
  console.log('expect: [255, 8]', Array.from(p));

  p1 = new Uint8Array([42, 255, 255]);
  p = newOrderingAfter(p1);
  console.log('expect: [50]', Array.from(p));


  console.log('### -- newOrderingBefore tests')

  p1 = new Uint8Array([1]);
  p = newOrderingBefore(p1);
  console.log('expect: [0, 247]', Array.from(p));

  p1 = new Uint8Array([2]);
  p = newOrderingBefore(p1);
  console.log('expect: [1]', [1], Array.from(p));

  p1 = new Uint8Array([0, 1]);
  p = newOrderingBefore(p1);
  console.log('expect: [0, 0, 247]', Array.from(p));

  p1 = new Uint8Array([0, 0]);
  p = newOrderingBefore(p1);
  console.log('expect: [0, 0, 0]', Array.from(p));
}
