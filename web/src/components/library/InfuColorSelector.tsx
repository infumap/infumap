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

import { Component } from "solid-js";
import { server } from "../../server";
import { Item } from "../../items/base/item";
import { asPageItem } from "../../items/page-item";
import { useStore } from "../../store/StoreProvider";
import { itemState } from "../../store/ItemState";
import { arrange } from "../../layout/arrange";
import { InfuColorButton } from "./InfuColorButton";


export const InfuColorSelector: Component<{ item: Item }> = (props: {item: Item }) => {
  let store = useStore();

  let itemId = props.item.id;

  const handleClick = (col: number) => {
    asPageItem(itemState.get(props.item.id)!).backgroundColorIndex = col;
    arrange(store);
    server.updateItem(itemState.get(itemId)!);
  }

  return (
    <div class="inline-block">
      <InfuColorButton col={0} onClick={handleClick} />
      <InfuColorButton col={1} onClick={handleClick} />
      <InfuColorButton col={2} onClick={handleClick} />
      <InfuColorButton col={3} onClick={handleClick} />
      <InfuColorButton col={4} onClick={handleClick} />
      <InfuColorButton col={5} onClick={handleClick} />
      <InfuColorButton col={6} onClick={handleClick} />
      <InfuColorButton col={7} onClick={handleClick} />
    </div>
  );
}
