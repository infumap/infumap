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

import { breadcrumbStore } from "../store/BreadcrumbStore";
import { itemStore } from "../store/ItemStore";
import { EMPTY_UID } from "./uid";


export function updateHref() {
  if (itemStore.getItem(breadcrumbStore.currentPage()!)?.parentId == EMPTY_UID) {
    window.history.replaceState(null, "", "/"); 
  } else {
    window.history.replaceState(null, "", `/${breadcrumbStore.currentPage()}`);
  }
}
