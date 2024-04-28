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


export const InfuLinkTriangle = () =>
  <div style={"width: 0px; height: 0px; " +
              `border-bottom-width: ${LINK_TRIANGLE_SIZE_PX}px; border-bottom-style: solid; border-bottom-color: transparent; ` +
              `border-left-width: ${LINK_TRIANGLE_SIZE_PX}px; border-left-style: solid; border-left-color: #5005;`} />;
