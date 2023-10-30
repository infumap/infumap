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

import { LINE_HEIGHT_PX } from "../../../constants";
import { PageFns, asPageItem } from "../../../items/page-item";
import { DesktopStoreContextModel } from "../../../store/DesktopStoreProvider";
import { itemState } from "../../../store/ItemState";
import { VesCache } from "../../ves-cache";
import { VisualElementFlags, VisualElementSpec } from "../../visual-element";


export const arrange_document = (desktopStore: DesktopStoreContextModel): void => {
  VesCache.initFullArrange();

  const currentPage = asPageItem(itemState.get(desktopStore.currentPage()!.itemId)!);
  const currentPath = currentPage.id;

  const pageBoundsPx = desktopStore.desktopBoundsPx();

  const _headingMarginPx = LINE_HEIGHT_PX * PageFns.pageTitleStyle().lineHeightMultiplier;

  const topLevelVisualElementSpec: VisualElementSpec = {
    displayItem: currentPage,
    flags: VisualElementFlags.Detailed | VisualElementFlags.ShowChildren,
    boundsPx: desktopStore.desktopBoundsPx(),
    childAreaBoundsPx: pageBoundsPx,
  };

  VesCache.finalizeFullArrange(topLevelVisualElementSpec, currentPath, desktopStore);
}
