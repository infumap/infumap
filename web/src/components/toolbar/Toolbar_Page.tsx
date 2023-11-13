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

import { Component, Show, createEffect } from "solid-js";
import { useDesktopStore } from "../../store/DesktopStoreProvider";
import { ArrangeAlgorithm, asPageItem } from "../../items/page-item";
import { itemState } from "../../store/ItemState";
import { InfuIconButton } from "../library/InfuIconButton";
import { InfuColorButton } from "../library/InfuColorButton";
import { panic } from "../../util/lang";
import { arrange } from "../../layout/arrange";
import { createBooleanSignal } from "../../util/signals";
import { GRID_SIZE } from "../../constants";
import { useUserStore } from "../../store/UserStoreProvider";
import { server } from "../../server";


export const Toolbar_Page: Component = () => {
  const desktopStore = useDesktopStore();
  const userStore = useUserStore();

  let divBeforeColroSelect: HTMLInputElement | undefined;
  let widthDiv: HTMLInputElement | undefined;
  let aspectDiv: HTMLInputElement | undefined;
  let numColsDiv: HTMLInputElement | undefined;

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
    server.updateItem(pageItem());
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

  const widthText = () => {
    desktopStore.pageWidthOverlayInfoMaybe.get();
    return pageItem().innerSpatialWidthGr / GRID_SIZE;
  }

  const aspectText = () => {
    desktopStore.pageAspectOverlayInfoMaybe.get();
    return Math.round(pageItem().naturalAspect * 1000.0) / 1000.0;
  }

  const numColsText = () => {
    desktopStore.pageNumColsOverlayInfoMaybe.get();
    return pageItem().gridNumberOfColumns;
  }

  const orderByTitle = () => {};

  const togglePublic = () => {};

  const deleteButtonHandler = () => {};

  const handleColorClick = () => {
    desktopStore.pageColorOverlayInfoMaybe.set(
      { topLeftPx: { x: divBeforeColroSelect!.getBoundingClientRect().x, y: divBeforeColroSelect!.getBoundingClientRect().y + 16 } });
  };

  const handleAspectClick = () => {
    desktopStore.pageAspectOverlayInfoMaybe.set(
      { topLeftPx: { x: aspectDiv!.getBoundingClientRect().x, y: aspectDiv!.getBoundingClientRect().y + 30 } });
  };

  const handleWidthClick = () => {
    desktopStore.pageWidthOverlayInfoMaybe.set(
      { topLeftPx: { x: widthDiv!.getBoundingClientRect().x, y: widthDiv!.getBoundingClientRect().y + 30 } });
  };

  const handleNumColsClick = () => {
    desktopStore.pageNumColsOverlayInfoMaybe.set(
      { topLeftPx: { x: numColsDiv!.getBoundingClientRect().x, y: numColsDiv!.getBoundingClientRect().y + 30 } });
  };

  return (
    <div class="inline-block p-[4px] flex-grow-0">
      <div class="inline-block w-[70px] border border-slate-400 text-center rounded-md ml-[10px]" style={`font-size: 13px;`}>
        {arrangeAlgoText()}
      </div>
      <InfuIconButton icon="fa fa-refresh" highlighted={false} clickHandler={handleChangeAlgorithm} />
      <div ref={divBeforeColroSelect} class="inline-block ml-[7px]"></div>
      <div class="inline-block h-[22px] align-middle">
        <InfuColorButton col={colorNumber()} onClick={handleColorClick} />
      </div>
      <div ref={widthDiv} class="inline-block ml-[10px]" style={`font-size: 13px;`} onClick={handleWidthClick}>
        <i class="bi-arrows" /> <span style={`font-size: 13px;`}>{widthText()}</span>
      </div>
      <div ref={aspectDiv} class="inline-block ml-[10px] align-middle" onClick={handleAspectClick}>
        <i class="bi-aspect-ratio" /> <span style={`font-size: 13px;`}>{aspectText()}</span>
      </div>
      <div ref={numColsDiv} class="inline-block ml-[10px] align-middle" onClick={handleNumColsClick}>
        <i class="bi-layout-three-columns" /> <span style={`font-size: 13px;`}>{numColsText()}</span>
      </div>
      <InfuIconButton icon="bi-sort-alpha-down" highlighted={false} clickHandler={orderByTitle} />
      <InfuIconButton icon="bi-globe-americas" highlighted={false} clickHandler={togglePublic} />
      <Show when={userStore.getUserMaybe() != null && userStore.getUser().userId == pageItem().ownerId}>
        <InfuIconButton icon="fa fa-trash" highlighted={false} clickHandler={deleteButtonHandler} />
      </Show>
    </div>
  );
}
