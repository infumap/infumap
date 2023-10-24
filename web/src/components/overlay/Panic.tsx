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
import { getPanickedMessage } from "../../util/lang";


export const Panic: Component = () => {
  const eatMouseEvent = (ev: MouseEvent) => { ev.stopPropagation(); }
  const eatTouchEvent = (ev: TouchEvent) => { ev.stopPropagation(); }
  const reload = (ev: MouseEvent) => { ev.preventDefault(); window.location = window.location; }

  return (
    <div id="panicOverlay"
         class="fixed left-0 top-0 bottom-0 right-0"
         style={`background-color: #ff000010; z-index: ${Z_PANIC};`}
         onMouseDown={eatMouseEvent}
         onMouseUp={eatMouseEvent}
         onMouseMove={eatMouseEvent}
         onDblClick={eatMouseEvent}
         onTouchStart={eatTouchEvent}
         onTouchEnd={eatTouchEvent}
         onTouchMove={eatTouchEvent}
         onTouchCancel={eatTouchEvent}
         >
      <div class="fixed select-text"
           style="color: #ff0000; border-width: 8px; border-color: #ff0000; border-style: solid; background-color: #000000dd; text-align: center; padding: 5px 20px 20px 20px; width: 100%;">
        <div style="font-size: 64px;">Logic Error</div>
        <div style="font-size: 20px;">Something the programmers thought should never happen happened - there is a bug in the code.</div>
        <div style="font-size: 20px;">There is a good chance it is safe to ignore this and <a style="color: #88f;" href="" onClick={reload}>reload</a> the page to continue.</div>
        <div style="font-size: 20px;">If the problem persists, try removing lines from the end of your items.json database file.</div>
        <div style="font-size: 20px;">You might consider letting the developers know this happened and provide them with the following message:</div>
        <div style={`font-size: 20px; z-index: ${Z_PANIC+1}`}>{getPanickedMessage()}</div>
      </div>
    </div>
  );
}
