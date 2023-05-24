/*
  Copyright (C) 2023 The Infumap Authors
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

import { panic } from "../../../util/lang";
import { VisualElementSignal } from "../../../util/signals";
import { Uid } from "../../../util/uid";
import { DesktopStoreContextModel, visualElementsWithId } from "../DesktopStoreProvider";
import { isPage } from "../items/page-item";
import { arrange, arrangeItem } from "./arrange";


export const rearrangeVisualElementsWithId = (desktopStore: DesktopStoreContextModel, id: Uid, pageChildrenOnly: boolean): void => {
  if (!pageChildrenOnly) {
    // TODO.
    panic();
  }
  const ves = visualElementsWithId(desktopStore, id);
  ves.forEach(ve => {
    if (ve.get().parent == null) {
      rearrangeVisualElement(desktopStore, ve);
    } else {
      if (isPage(ve.get().parent!.get().item)) {
        rearrangeVisualElement(desktopStore, ve);
      }
    }
  });
}

export const rearrangeVisualElement = (desktopStore: DesktopStoreContextModel, visualElementSignal: VisualElementSignal): void => {
  const ve = visualElementSignal.get();
  if (desktopStore.topLevelPageId() == ve.item.id) {
    arrange(desktopStore);
    return;
  }

  // TODO: this seems too much of a hack...
  let item = visualElementSignal.get().item;
  if (visualElementSignal.get().linkItemMaybe != null) {
    item = visualElementSignal.get().linkItemMaybe!;
  }

  const visualElement = arrangeItem(
    desktopStore,
    item,
    visualElementSignal.get().parent!.get().childAreaBoundsPx!,
    visualElementSignal.get().parent!,
    visualElementSignal.get().parent!.get().isPopup,
    visualElementSignal.get().isPopup).get();

  visualElementSignal.set(visualElement);
}
