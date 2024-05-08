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

import { LINK_TRIANGLE_SIZE_PX } from "../../constants";


export const InfuResizeTriangle = () =>
  <div class="absolute"
       style={"width: 0px; height: 0px; bottom: 2px; right: 2px; " +
              `border-top-width: ${LINK_TRIANGLE_SIZE_PX-4}px; border-top-style: solid; border-top-color: transparent; ` +
              `border-right-width: ${LINK_TRIANGLE_SIZE_PX-4}px; border-right-style: solid; border-right-color: #bbbb;`} />;
