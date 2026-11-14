/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import { Component, For } from "solid-js";
import { useStore } from "../../store/StoreProvider";
import { asPageItem } from "../../items/page-item";
import { asImageItem, isImage } from "../../items/image-item";
import { LinkFns, asLinkItem, isLink } from "../../items/link-item";
import { itemState } from "../../store/ItemState";
import { Item } from "../../items/base/item";
import { TOOLBAR_DIALOG_INPUT_CLASS, roundAspect, toolbarDialogNumberInput } from "./toolbarDialog";
import { DIALOG_LABEL_CLASS, dialogButtonClass } from "../library/dialogStyle";


const CELL_SHAPES: Array<{ label: string, aspect: number }> = [
  { label: "Square", aspect: 1 },
  { label: "4:3", aspect: 4 / 3 },
  { label: "3:2", aspect: 3 / 2 },
  { label: "16:9", aspect: 16 / 9 },
  { label: "3:4", aspect: 3 / 4 },
  { label: "2:3", aspect: 2 / 3 },
];

const shapeMatches = (a: number, b: number): boolean => Math.abs(a - b) < 0.005;

/** A cell shape as shown on a toolbar button: a preset's name, or the aspect. */
export function cellShapeLabel(aspect: number): string {
  const preset = CELL_SHAPES.find(shape => shapeMatches(shape.aspect, aspect));
  return preset == null ? String(roundAspect(aspect)) : preset.label.toLowerCase();
}

/** Width / height of each image among the page's children, including images they link to. */
export function childImageAspects(pageId: string): Array<number> {
  const result: Array<number> = [];
  for (const childId of asPageItem(itemState.get(pageId)!).computed_children) {
    let item: Item | null = itemState.get(childId);
    if (item != null && isLink(item)) { item = itemState.get(LinkFns.getLinkToId(asLinkItem(item))); }
    if (item == null || !isImage(item)) { continue; }
    const sizePx = asImageItem(item).imageSizePx;
    if (sizePx.w > 0 && sizePx.h > 0) { result.push(sizePx.w / sizePx.h); }
  }
  return result;
}

function median(values: Array<number>): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 == 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Preset cell shapes, the aspect to type, and the shape of the page's images, for a grid cell or catalog preview. */
export const ToolbarDialogCellShapeSection: Component<{
  label: string,
  aspect: () => number,
  apply: (aspect: number) => void,
  imageAspects: Array<number>,
  minAspect: number,
  maxAspect: number,
}> = (props) => {
  const store = useStore();
  const imageCount = props.imageAspects.length;
  const matchImagesTitle = imageCount == 0
    ? "There are no images on this page"
    : `Use the typical shape of the ${imageCount} image${imageCount == 1 ? "" : "s"} on this page`;
  return (
    <>
      <div class={`mt-3 ${DIALOG_LABEL_CLASS}`}>{props.label}</div>
      <div class="mt-[6px] flex gap-[6px]" role="radiogroup" aria-label={props.label}>
        <For each={CELL_SHAPES}>{shape =>
          <button type="button" role="radio" aria-checked={shapeMatches(shape.aspect, props.aspect())}
            class={dialogButtonClass(shapeMatches(shape.aspect, props.aspect()))}
            onClick={() => props.apply(shape.aspect)}>{shape.label}</button>
        }</For>
      </div>
      <div class="mt-2 flex items-center gap-2">
        <label class={`flex items-center gap-[6px] ${DIALOG_LABEL_CLASS}`}>Aspect
          <input class={TOOLBAR_DIALOG_INPUT_CLASS} type="number" min={props.minAspect} max={props.maxAspect} step="0.01"
            value={roundAspect(props.aspect())} {...toolbarDialogNumberInput(store, props.aspect, props.apply, 0.01, v => String(roundAspect(v)))} />
        </label>
        <button type="button" class={dialogButtonClass()} disabled={imageCount == 0}
          title={matchImagesTitle} onClick={() => props.apply(roundAspect(median(props.imageAspects)))}>Match images</button>
      </div>
    </>
  );
};
