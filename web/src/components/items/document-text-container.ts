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

import { edit_inputListener, edit_keyDownHandler, edit_keyUpHandler } from "../../input/edit";
import { VisualElement } from "../../layout/visual-element";
import { StoreContextModel } from "../../store/StoreProvider";


/**
 * Handlers for the contenteditable element that holds a document page's children. It is contenteditable while one of
 * them is edited, and also while the page is read-only, so that a text selection can run across paragraphs and table
 * cells and be extended with the keyboard. When read-only, these stop anything that would change the text.
 */
export function createDocumentTextContainerHandlers(
  store: StoreContextModel,
  visualElement: () => VisualElement,
  readOnly: () => boolean,
) {
  return {
    keyUpHandler: (ev: KeyboardEvent) => {
      if (readOnly()) { return; }
      edit_keyUpHandler(store, ev);
    },
    keyDownHandler: (ev: KeyboardEvent) => {
      if (readOnly()) {
        if (ev.key == "Backspace" || ev.key == "Delete" || ev.key == "Enter" || ev.key == "Tab") {
          ev.preventDefault();
          ev.stopPropagation();
        }
        return;
      }
      edit_keyDownHandler(store, visualElement(), ev);
    },
    inputListener: (ev: InputEvent) => {
      if (readOnly()) {
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      edit_inputListener(store, ev);
    },
    beforeInputListener: (ev: InputEvent) => {
      if (!readOnly()) { return; }
      ev.preventDefault();
      ev.stopPropagation();
    },
  };
}
