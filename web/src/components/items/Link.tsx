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

import { Component } from "solid-js";
import { VisualElementInTableProps } from "../VisualElementInTable";
import { VisualElementOnDesktopProps } from "../VisualElementOnDesktop";


// export const Link: Component<ItemOnDesktopProps> = (props: ItemOnDesktopProps) => {
//   const desktopStore = useDesktopStore();
//   const linkItem = () => asLinkItem(props.item);
//   const linkedToItem = () => desktopStore.getItem(linkItem().linkToId)!;

//   return (
//     <ItemOnDesktop item={linkedToItem()} renderArea={props.renderArea} renderTreeParentId={linkItem().id} />
//   );
// }

export const LinkFn: Component<VisualElementOnDesktopProps> = (props: VisualElementOnDesktopProps) => {
  return <></>;
}

// export const LinkInTable: Component<ItemInTableProps> = (props: ItemInTableProps) => {
//   const desktopStore = useDesktopStore();
//   const linkItem = () => asLinkItem(props.item);
//   const linkedToItem = () => desktopStore.getItem(linkItem().linkToId)!;

//   return (
//     <ItemInTable item={linkedToItem()} renderArea={props.renderArea} parentTable={props.parentTable} renderTreeParentId={linkItem().id} />
//   );
// }

export const LinkInTableFn: Component<VisualElementInTableProps> = (props: VisualElementInTableProps) => {
  return <></>;
}