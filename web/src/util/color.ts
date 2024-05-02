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

export function hexToRGBA(hex: string, alpha: number) {
  return "rgba(" + parseInt(hex.slice(1, 3), 16) + ", " + parseInt(hex.slice(3, 5), 16) + ", " + parseInt(hex.slice(5, 7), 16) + ", " + alpha + ")";
}

export function rgbHexToArray(hex: string) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
}

export function rgbArrayToRgbaFunc(color: Array<number>) {
  return "rgba(" + color[0] + ", " + color[1] + ", " + color[2] + ", " + 1.0 + ")";
}
