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

import { Component } from "solid-js";
import { Z_PANIC } from "../../constants";
import { panickedMessage } from "../../util/lang";


export const Panic: Component = () => {
  return (
    <div id="textEntryOverlay"
         class="absolute left-0 top-0 bottom-0 right-0 select-none outline-none"
         style={`background-color: #80000030; z-index: ${Z_PANIC};`}>
      <div style="font-size: 64px;">panic!</div>
      <div style="font-size: 20px;">${panickedMessage}</div>
    </div>
  );
}
