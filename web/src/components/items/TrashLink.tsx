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

import { Component, Show } from "solid-js";
import { asTitledItem, isTitledItem } from "../../items/base/titled-item";
import { isLink } from "../../items/link-item";
import { VeFns, VisualElementFlags } from "../../layout/visual-element";
import { FIND_HIGHLIGHT_COLOR, FOCUS_RING_BOX_SHADOW, SELECTED_DARK, SELECTED_LIGHT, SELECTION_HIGHLIGHT_COLOR } from "../../style";
import { Z_INDEX_LOCAL_OVERLAY } from "../../constants";
import { useStore } from "../../store/StoreProvider";
import type { VisualElementProps } from "../VisualElement";
import { InfuLinkTriangle } from "../library/InfuLinkTriangle";
import { autoMovedIntoViewWarningStyle, desktopStackRootStyle } from "./helper";

const HELP_TEXT = "Emptying Trash removes this link. The target is removed only if it is separately in Trash.";
const STRIPES = "repeating-linear-gradient(135deg, rgba(248,250,252,0.65), rgba(248,250,252,0.65) 9px, rgba(218,226,236,0.65) 9px, rgba(218,226,236,0.65) 18px)";

function trashLinkTitle(props: VisualElementProps): string {
  const ve = props.visualElement;
  const override = ve.actualLinkItemMaybe?.overrideTitle ?? ve.linkItemMaybe?.overrideTitle;
  if (override) { return override; }
  if (isTitledItem(ve.displayItem)) {
    return asTitledItem(ve.displayItem).title || `Untitled ${ve.displayItem.itemType}`;
  }
  if (isLink(ve.displayItem)) { return "Unavailable link target"; }
  return ve.displayItem.itemType[0].toUpperCase() + ve.displayItem.itemType.slice(1);
}

export const TrashLink_Desktop: Component<VisualElementProps> = (props) => {
  const store = useStore();
  const bounds = () => props.visualElement.boundsPx;
  const vePath = () => VeFns.veToPath(props.visualElement);
  const showTitle = () => bounds().w >= 48 && bounds().h >= 24;
  const showExplanation = () => bounds().w >= 170 && bounds().h >= 64;
  const showShortLabel = () => bounds().w >= 80 && bounds().h >= 42 && !showExplanation();
  const focused = () => store.history.getFocusPathMaybe() === vePath();

  return (
    <div
      class="absolute rounded-xs border border-slate-400 overflow-hidden"
      title={HELP_TEXT}
      aria-label={`Link to ${trashLinkTitle(props)}. ${HELP_TEXT}`}
      style={`left: ${bounds().x}px; top: ${bounds().y}px; width: ${bounds().w}px; height: ${bounds().h}px; ` +
        `background: ${STRIPES}; background-color: white; ${desktopStackRootStyle(props.visualElement)}`}>
      <InfuLinkTriangle />
      <Show when={showTitle()}>
        <div class="absolute flex items-center justify-center text-center text-slate-800 font-medium pointer-events-none"
          style={`left: 10px; top: 0px; ` +
            `width: ${Math.max(0, bounds().w - 20)}px; height: ${showExplanation() || showShortLabel() ? Math.max(0, bounds().h - 20) : bounds().h}px; ` +
            `overflow: hidden; font-size: ${Math.min(16, Math.max(11, bounds().h / 3))}px;`}>
          <span class="block truncate" title={trashLinkTitle(props)}>{trashLinkTitle(props)}</span>
        </div>
      </Show>
      <Show when={showExplanation() || showShortLabel()}>
        <div class="absolute left-2 bottom-1 rounded-xs bg-white/85 px-1 text-slate-700 pointer-events-none"
          style="font-size: 10px; line-height: 14px;">
          {showExplanation() ? "Only this link is removed" : "Link"}
        </div>
      </Show>
      <Show when={props.visualElement.flags & VisualElementFlags.FindHighlighted}>
        <div class="absolute inset-0 pointer-events-none" style={`background-color: ${FIND_HIGHLIGHT_COLOR};`} />
      </Show>
      <Show when={focused() || (props.visualElement.flags & VisualElementFlags.SelectionHighlighted)}>
        <div class="absolute inset-0 rounded-xs pointer-events-none"
          style={`box-shadow: ${FOCUS_RING_BOX_SHADOW}; z-index: ${Z_INDEX_LOCAL_OVERLAY};`} />
      </Show>
      <Show when={store.perVe.getAutoMovedIntoView(vePath())}>
        <div class="absolute rounded-xs pointer-events-none"
          style={autoMovedIntoViewWarningStyle(bounds().w, bounds().h)} />
      </Show>
    </div>
  );
};

export const TrashLink_LineItem: Component<VisualElementProps> = (props) => {
  const store = useStore();
  const bounds = () => props.visualElement.boundsPx;
  const vePath = () => VeFns.veToPath(props.visualElement);
  const focused = () => store.history.getFocusPathMaybe() === vePath();
  const selected = () => !!(props.visualElement.flags & VisualElementFlags.Selected);

  return (
    <div class="absolute flex items-center rounded-xs border border-slate-300 overflow-hidden pl-3"
      title={HELP_TEXT}
      aria-label={`Link to ${trashLinkTitle(props)}. ${HELP_TEXT}`}
      style={`left: ${bounds().x}px; top: ${bounds().y}px; width: ${bounds().w}px; height: ${bounds().h}px; ` +
        `background: ${STRIPES}; background-color: ${selected() ? (props.visualElement.flags & VisualElementFlags.FocusPageSelected ? SELECTED_DARK : SELECTED_LIGHT) : "white"}; ` +
        `font-size: ${Math.min(16, Math.max(8, bounds().h * 0.7))}px;`}>
      <InfuLinkTriangle />
      <Show when={bounds().w >= 120 && bounds().h >= 16}>
        <span class="shrink-0 mr-2 rounded-xs bg-white/85 px-1 text-slate-700 pointer-events-none"
          style="font-size: 10px; line-height: 14px;">Link</span>
      </Show>
      <span class="min-w-0 truncate pr-2 text-slate-800 pointer-events-none">{trashLinkTitle(props)}</span>
      <Show when={props.visualElement.flags & (VisualElementFlags.FindHighlighted | VisualElementFlags.SelectionHighlighted)}>
        <div class="absolute inset-0 pointer-events-none"
          style={`background-color: ${props.visualElement.flags & VisualElementFlags.FindHighlighted ? FIND_HIGHLIGHT_COLOR : SELECTION_HIGHLIGHT_COLOR};`} />
      </Show>
      <Show when={focused()}>
        <div class="absolute inset-0 pointer-events-none"
          style={`box-shadow: ${FOCUS_RING_BOX_SHADOW}; z-index: ${Z_INDEX_LOCAL_OVERLAY};`} />
      </Show>
    </div>
  );
};
