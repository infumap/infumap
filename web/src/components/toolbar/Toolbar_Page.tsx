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

import { Component, createEffect } from "solid-js";
import { useDesktopStore } from "../../store/DesktopStoreProvider";
import { ArrangeAlgorithm, asPageItem } from "../../items/page-item";
import { itemState } from "../../store/ItemState";
import { InfuIconButton } from "../library/InfuIconButton";
import { InfuColorButton } from "../library/InfuColorButton";
import { panic } from "../../util/lang";
import { arrange } from "../../layout/arrange";
import { createBooleanSignal } from "../../util/signals";


export const Toolbar_Page: Component = () => {
  const desktopStore = useDesktopStore();

  let divBeforeColroSelect: HTMLInputElement | undefined;

  let alwaysFalseSignal = createBooleanSignal(false);
  const rerenderToolbar = () => { alwaysFalseSignal.set(false); }

  const pageItem = () => asPageItem(itemState.get(desktopStore.getToolbarFocus()!.itemId)!);

  const handleChangeAlgorithm = () => {
    let newAA;
    if (pageItem().arrangeAlgorithm == ArrangeAlgorithm.SpatialStretch) { newAA = ArrangeAlgorithm.Grid; }
    else if (pageItem().arrangeAlgorithm == ArrangeAlgorithm.Grid) { newAA = ArrangeAlgorithm.List; }
    else if (pageItem().arrangeAlgorithm == ArrangeAlgorithm.List) { newAA = ArrangeAlgorithm.Document; }
    else if (pageItem().arrangeAlgorithm == ArrangeAlgorithm.Document) { newAA = ArrangeAlgorithm.SpatialStretch; }
    else { panic("unexpected arrange algorithm " + pageItem().arrangeAlgorithm); }
    pageItem().arrangeAlgorithm = newAA;
    arrange(desktopStore);
    rerenderToolbar();
  };

  const handleColorClick = () => {
    desktopStore.pageColorOverlayInfoMaybe.set(
      { topLeftPx: { x: divBeforeColroSelect!.getBoundingClientRect().x, y: divBeforeColroSelect!.getBoundingClientRect().y } });
  };

  // force rerender when color selector closes.
  createEffect(() => {
    rerenderToolbar();
  });

  const arrangeAlgoText = () => {
    if (alwaysFalseSignal.get()) { panic("unexpected state"); }
    const aa = pageItem().arrangeAlgorithm;
    if (aa == ArrangeAlgorithm.SpatialStretch) { return "spatial"; }
    if (aa == ArrangeAlgorithm.Document) { return "document"; }
    if (aa == ArrangeAlgorithm.Grid) { return "grid"; }
    if (aa == ArrangeAlgorithm.List) { return "list"; }
    panic("unexpected arrange algorithm " + aa);
  }

  const colorNumber = () => {
    desktopStore.pageColorOverlayInfoMaybe.get();
    return pageItem().backgroundColorIndex;
  }

  return (
    <div class="inline-block p-[4px] flex-grow-0">
      <div class="inline-block w-[70px] border border-slate-400 text-center rounded-md ml-[10px]" style={`font-size: 13px;`}>
        {arrangeAlgoText()}
      </div>
      <InfuIconButton icon="refresh" highlighted={false} clickHandler={handleChangeAlgorithm} />
      <div ref={divBeforeColroSelect} class="inline-block ml-[7px]"></div>
      <div class="inline-block h-[22px] align-middle">
        <InfuColorButton col={colorNumber()} onClick={handleColorClick} />
      </div>
    </div>
  );
}
