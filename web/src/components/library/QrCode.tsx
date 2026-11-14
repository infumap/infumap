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

import { Show, createMemo, createResource } from "solid-js";
import { loadDeferredFeatures } from "../deferred";


/**
 * A QR code drawn as SVG, so it is sharp at any size and pixel density. The library only encodes
 * the text. The symbol has no quiet zone of its own, so place it on a light background with padding.
 */
export function QrCode(props: { text: string, sizePx: number }) {
  const [qrCode, { refetch }] = createResource(async () => (await loadDeferredFeatures())?.QRCode ?? null);

  const symbol = createMemo(() => {
    const encoder = qrCode();
    if (!encoder) { return; }
    const modules = encoder.create(props.text).modules;
    let path = "";
    for (let row = 0; row < modules.size; ++row) {
      let col = 0;
      while (col < modules.size) {
        if (!modules.get(row, col)) { col++; continue; }
        const start = col;
        while (col < modules.size && modules.get(row, col)) { col++; }
        path += `M${start} ${row}h${col - start}v1h${start - col}z`;
      }
    }
    return { size: modules.size, path };
  });

  return (
    <div class="flex shrink-0 items-center justify-center"
      style={`width: ${props.sizePx}px; height: ${props.sizePx}px;`}>
      <Show when={symbol()} fallback={
        <Show when={qrCode.loading} fallback={
          <div class="text-center text-neutral-500">
            <div>QR code unavailable</div>
            <button type="button" class="text-blue-700 cursor-pointer hover:underline"
              onClick={() => { void refetch(); }}>Retry</button>
          </div>
        }>
          <span role="status" class="text-neutral-500">Loading QR code…</span>
        </Show>
      }>{generated =>
        <svg width={props.sizePx} height={props.sizePx} viewBox={`0 0 ${generated().size} ${generated().size}`}
          shape-rendering="crispEdges" style="display: block;">
          <path d={generated().path} fill="#000" />
        </svg>
      }</Show>
    </div>
  );
}
