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


export function currentUnixTimeSeconds(): number {
  return Math.floor(new Date().getTime()/1000);
}

let panickedMessage: string | null = null;
export function getPanickedMessage(): string | null { return panickedMessage; }
export function panic(errorMessage: string): never {
  panickedMessage = errorMessage;
  console.trace();
  throw new Error("logic error: " + errorMessage);
}

export function assert(condition: boolean, errorMessage: string): void {
  if (!condition) {
    panic(errorMessage);
  }
}
