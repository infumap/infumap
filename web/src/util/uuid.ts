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

export type Uuid = string;

export const uuid = {
  createV4: () => {
    let rs = crypto.getRandomValues(new Uint8Array(32));
    let idx = 0;
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      let r = Math.floor(rs[idx++] / 16);
      let v = c == 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  },

  toBytes: (uuid: Uuid) : Uint8Array => {
    let r = new Uint8Array(16);
    _parse(uuid, r, 0);
    return r;
  },

  fromBytes: (bytes: Uint8Array) : string => {
    return _unparse(bytes, 0);
  }
};


// ---- Adapted from: https://github.com/zefferus/uuid-parse

// The MIT License (MIT)
// Copyright (c) 2010-2012 Robert Kieffer

// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the "Software"),
// to deal in the Software without restriction, including without limitation
// the rights to use, copy, modify, merge, publish, distribute, sublicense,
// and/or sell copies of the Software, and to permit persons to whom the
// Software is furnished to do so, subject to the following conditions:

// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.

// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
// FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
// IN THE SOFTWARE.

let _byteToHex : Array<string> = [];
let _hexToByte : { [hex: string]: number } = {};
for (let i = 0; i < 256; i++) {
  _byteToHex[i] = (i + 0x100).toString(16).substr(1);
  _hexToByte[_byteToHex[i]] = i;
}

function _parse(s: string, buf: Uint8Array, offset: number) {
  let i = (buf && offset) || 0;
  let ii = 0;

  buf = buf || [];
  s = s.toLowerCase();

  if (s.length != 36) { throw new Error("invalid uuid [1]"); }
  let htb = _hexToByte;
  buf[i+0]  = htb[s.substring(0, 2)];
  buf[i+1]  = htb[s.substring(2, 4)];
  buf[i+2]  = htb[s.substring(4, 6)];
  buf[i+3]  = htb[s.substring(6, 8)];
  if (s[8] != '-') { throw new Error("invalid uuid [2]"); }
  buf[i+4]  = htb[s.substring(9, 11)];
  buf[i+5]  = htb[s.substring(11, 13)];
  if (s[13] != '-') { throw new Error("invalid uuid [3]"); }
  buf[i+6]  = htb[s.substring(14, 16)];
  buf[i+7]  = htb[s.substring(16, 18)];
  if (s[18] != '-') { throw new Error("invalid uuid [4]"); }
  buf[i+8]  = htb[s.substring(19, 21)];
  buf[i+9]  = htb[s.substring(21, 23)];
  if (s[23] != '-') { throw new Error("invalid uuid [5]"); }
  buf[i+10] = htb[s.substring(24, 26)];
  buf[i+11] = htb[s.substring(26, 28)];
  buf[i+12] = htb[s.substring(28, 30)];
  buf[i+13] = htb[s.substring(30, 32)];
  buf[i+14] = htb[s.substring(32, 34)];
  buf[i+15] = htb[s.substring(34, 36)];

  return buf;
}

function _unparse(buf: Uint8Array, offset: number) {
  let i = offset || 0;
  let bth = _byteToHex;
  return (bth[buf[i++]] + bth[buf[i++]] +
          bth[buf[i++]] + bth[buf[i++]] + '-' +
          bth[buf[i++]] + bth[buf[i++]] + '-' +
          bth[buf[i++]] + bth[buf[i++]] + '-' +
          bth[buf[i++]] + bth[buf[i++]] + '-' +
          bth[buf[i++]] + bth[buf[i++]] +
          bth[buf[i++]] + bth[buf[i++]] +
          bth[buf[i++]] + bth[buf[i++]]);
}
