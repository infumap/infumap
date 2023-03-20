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

import { Component, For, Match, onMount, Switch } from "solid-js";
import { GRID_SIZE } from "../constants";
import { useDesktopStore } from "../store/desktop/DesktopStoreProvider";
import { isPage } from "../store/desktop/items/page-item";
import { asTableItem, isTable } from "../store/desktop/items/table-item";
// import { VisualElement, VisualElementSignal } from "../store/desktop/visual-element";
import { HEADER_HEIGHT_BL } from "./items/Table";


// export interface VisualElementProps {
//   visualElement: VisualElement,
//   parentVisualElement: VisualElement,
// }


// export const VisualElementChildren: Component<VisualElementProps> = (props: VisualElementProps) => {
//   return (
//     <Switch>
//       <Match when={isPage(props.visualElement) && props.visualElement.childAreaBoundsPx != null}>
//         <PageChildItems {...props} />
//       </Match>
//       <Match when={isTable(props.visualElement)}>
//         <TableChildItems {...props} />
//       </Match>
//     </Switch>
//   )
// }


// const PageChildItems: Component<VisualElementProps> = (props: VisualElementProps) => {
//   return (
//     <div class="absolute"
//         style={`left: ${props.visualElement.childAreaBoundsPx!.x}px; top: ${props.visualElement.childAreaBoundsPx!.y}px; ` +
//                `width: ${props.visualElement.childAreaBoundsPx!.w}px; height: ${props.visualElement.childAreaBoundsPx!.h}px;`}>
//       <For each={props.visualElement.children}>{childVisualElementSignal =>
//         <VisualElementOnDesktop visualElement={childVisualElementSignal.get()} />
//       }</For>
//     </div>
//   );
// }


// const TableChildItems: Component<VisualElementProps> = (props: VisualElementProps) => {
//   const desktopStore = useDesktopStore();

//   let outerDiv: HTMLDivElement | undefined;

//   const tableItem = () => asTableItem(desktopStore.getItem(props.visualElement.itemId)!);

//   const blockHeightPx = () => {
//     let heightBr = tableItem().spatialHeightGr / GRID_SIZE - HEADER_HEIGHT_BL;
//     let heightPx = props.visualElement.childAreaBoundsPx!.h;
//     return heightPx / heightBr;
//   }

//   const totalScrollableHeightPx = () =>
//     tableItem().computed_children.length * blockHeightPx();

//   const scrollHandler = (_ev: Event) => {
//     tableItem().setScrollYPx((outerDiv!)!.scrollTop);
//   }

//   onMount(() => {
//     outerDiv!.scrollTop = tableItem().scrollYPx();
//   });

//   const drawVisibleItems = () => {
//     const children = props.visualElement.children;
//     const visibleChildrenIds = [];
//     const firstItemIdx = Math.floor(tableItem().scrollYPx() / blockHeightPx());
//     let lastItemIdx = Math.ceil((tableItem().scrollYPx() + props.visualElement.childAreaBoundsPx!.h) / blockHeightPx());
//     if (lastItemIdx > children.length - 1) { lastItemIdx = children.length - 1; }
//     for (let i=firstItemIdx; i<=lastItemIdx; ++i) {
//       visibleChildrenIds.push(children[i]);
//     }

//     const drawChild = (child: VisualElementSignal) => {
//       // const item = desktopStore.getItem(childId)!;
//       // let attachments: Array<Item> = [];
//       // if (isAttachmentsItem(item)) {
//       //   attachments = asAttachmentsItem(item).computed_attachments.map(attachmentId => desktopStore.getItem(attachmentId)!);
//       // }

//       return (
//         <>
//           <VisualElementInTable visualElement={child.get()} parentVisualElement={props.visualElement} />
//           {/* <For each={attachments}>{attachmentItem =>
//             <ItemInTable item={attachmentItem} parentTable={tableItem()} renderArea={props.renderArea} renderTreeParentId={tableItem().id} />
//           }</For> */}
//         </>
//       );
//     }

//     return (
//       <For each={visibleChildrenIds}>
//         {child => drawChild(child)}
//       </For>
//     );
//   }

//   return (
//     <div ref={outerDiv}
//          class="absolute"
//          style={`left: ${props.visualElement.childAreaBoundsPx!.x}px; top: ${props.visualElement.childAreaBoundsPx!.y}px; ` +
//                 `width: ${props.visualElement.childAreaBoundsPx!.w}px; height: ${props.visualElement.childAreaBoundsPx!.h}px; overflow-y: auto;`}
//                 onscroll={scrollHandler}>
//       <div class="absolute" style={`width: ${props.visualElement.childAreaBoundsPx!.w}px; height: ${totalScrollableHeightPx()}px;`}>
//         {drawVisibleItems()}
//       </div>
//     </div>
//   );
// }



{/* <Show when={visualElementSignal.visualElement().children.length > 0 && visualElementSignal.visualElement().itemType == ITEM_TYPE_TABLE}>
<div class="absolute"
     style={`left: ${visualElementSignal.visualElement().childAreaBoundsPx!.x}px; top: ${visualElementSignal.visualElement().childAreaBoundsPx!.y}px; ` +
            `width: ${visualElementSignal.visualElement().childAreaBoundsPx!.w}px; height: ${visualElementSignal.visualElement().childAreaBoundsPx!.h}px;`}>
  <For each={visualElementSignal.visualElement().children}>{childVisualElementSignal =>
    <VisualElementComponent visualElement={childVisualElementSignal.visualElement()} parentVisualElement={visualElementSignal.visualElement()} />
  }</For>
</div> */}
