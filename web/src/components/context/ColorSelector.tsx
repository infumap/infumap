/*
  Copyright (C) 2022 The Infumap Authors
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
import { server } from "../../server";
import { Item } from "../../store/desktop/items/base/item";
import { asPageItem } from "../../store/desktop/items/page-item";
import { useDesktopStore } from "../../store/desktop/DesktopStoreProvider";
import { useUserStore } from "../../store/UserStoreProvider";
import { Colors } from "../../style";


const ColorButton: Component<{ col: number, onClick: (col: number) => void }> = (props: { col: number, onClick: (col: number) => void }) => {
  const clickHandler = (_ev: MouseEvent) => { props.onClick(props.col); }
  return (
    <div onClick={clickHandler}
         class="border rounded w-[29px] h-[28px] inline-block text-center cursor-pointer ml-[5px] text-[18px]"
         style={`background-color: ${Colors[props.col]};`}></div>
  );
}

export const ColorSelector: Component<{ item: Item }> = (props: {item: Item }) => {
  let userStore = useUserStore();
  let desktopStore = useDesktopStore();

  let itemId = props.item.id;

  const handleClick = (col: number) => {
    desktopStore.updateItem(props.item.id, item => asPageItem(item).backgroundColorIndex = col);
    server.updateItem(userStore.getUser(), desktopStore.getItem(itemId)!);
  }

  return (
    <div>
      <ColorButton col={0} onClick={handleClick} />
      <ColorButton col={1} onClick={handleClick} />
      <ColorButton col={2} onClick={handleClick} />
      <ColorButton col={3} onClick={handleClick} />
      <ColorButton col={4} onClick={handleClick} />
      <ColorButton col={5} onClick={handleClick} />
      <ColorButton col={6} onClick={handleClick} />
      <ColorButton col={7} onClick={handleClick} />
    </div>
  );
}
