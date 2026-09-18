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

import { JSX, ParentComponent, Show, createSignal, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { Z_INDEX_GLOBAL_APP_OVERLAY } from "../../constants";

const SHOW_DELAY_MS = 120;
const VIEWPORT_MARGIN_PX = 8;
const MAX_WIDTH_PX = 280;
const GAP_PX = 5;

interface QuickTooltipProps {
  text: string,
  children: JSX.Element,
}

export const QuickTooltip: ParentComponent<QuickTooltipProps> = (props: QuickTooltipProps) => {
  const [anchorRect, setAnchorRect] = createSignal<DOMRect | null>(null);
  const [visible, setVisible] = createSignal(false);
  let showTimeout: number | undefined;

  const cancelPendingShow = () => {
    if (showTimeout != null) {
      window.clearTimeout(showTimeout);
      showTimeout = undefined;
    }
  };

  const showSoon = (anchor: HTMLElement) => {
    cancelPendingShow();
    setAnchorRect(anchor.getBoundingClientRect());
    showTimeout = window.setTimeout(() => {
      showTimeout = undefined;
      setVisible(true);
    }, SHOW_DELAY_MS);
  };

  const showNow = (anchor: HTMLElement) => {
    cancelPendingShow();
    setAnchorRect(anchor.getBoundingClientRect());
    setVisible(true);
  };

  const hide = () => {
    cancelPendingShow();
    setVisible(false);
  };

  onCleanup(cancelPendingShow);

  const tooltipStyle = (): string => {
    const rect = anchorRect();
    if (rect == null) { return ""; }
    const halfMaxWidth = MAX_WIDTH_PX / 2;
    const center = Math.max(
      VIEWPORT_MARGIN_PX + halfMaxWidth,
      Math.min(rect.left + rect.width / 2, window.innerWidth - VIEWPORT_MARGIN_PX - halfMaxWidth),
    );
    return `left: ${center}px; bottom: ${window.innerHeight - rect.top + GAP_PX}px; ` +
      `max-width: ${MAX_WIDTH_PX}px; transform: translateX(-50%); z-index: ${Z_INDEX_GLOBAL_APP_OVERLAY + 2};`;
  };

  return (
    <span
      class="inline-flex"
      onMouseEnter={(ev) => showSoon(ev.currentTarget)}
      onMouseLeave={hide}
      onFocusIn={(ev) => showNow(ev.currentTarget)}
      onFocusOut={hide}
      onMouseDown={hide}>
      {props.children}
      <Show when={visible() && anchorRect() != null}>
        <Portal mount={document.body}>
          <div
            class="pointer-events-none fixed rounded bg-slate-800 px-2 py-1 text-center text-[11px] leading-4 text-white shadow-sm"
            style={tooltipStyle()}
            role="tooltip">
            {props.text}
          </div>
        </Portal>
      </Show>
    </span>
  );
};
