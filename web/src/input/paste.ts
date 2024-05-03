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

import { StoreContextModel } from "../store/StoreProvider";


export function pasteHandler(_store: StoreContextModel, ev: ClipboardEvent) {
  let text = ev.clipboardData!.getData('text/plain');
  text = text.replace('\n', ' ');
  text = text.replace('\r', ' ');
  text = text.replace('\t', ' ');
  document.execCommand("insertHTML", false, text);
  ev.preventDefault();
}
