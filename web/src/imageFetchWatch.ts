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

import { ImageFetchBlockage, ImageFetchBlocker, ImageFetchPriority, imageFetchBlockage } from "./imageManager";
import { asTitledItem, isTitledItem } from "./items/base/titled-item";
import { itemState } from "./store/ItemState";
import { StoreContextModel } from "./store/StoreProvider";
import { TransientMessage, TransientMessageType } from "./store/StoreProvider_Overlay";

const POLL_MS = 2000;
// Whilst a page of images loads, fetches start and finish every second or two, so a gap this long means the images
// that are waiting are held up behind fetches that are much slower than usual (e.g. the server is slow getting
// originals from the object store), or that never finish.
const WARN_AFTER_STALLED_MS = 10000;
const RESUMED_MESSAGE_MS = 4000;

const seconds = (ms: number): string => `${Math.round(ms / 1000)}s`;

function describeBlocker(blocker: ImageFetchBlocker): string {
  const match = blocker.path.match(/^\/files\/([^_/]+)_/);
  const item = match == null ? null : itemState.get(match[1]);
  const title = item != null && isTitledItem(item) ? asTitledItem(item).title : null;
  const what = blocker.path.startsWith("/favicons/") ? "a favicon" : title ? `'${title}'` : blocker.path;
  const stage = blocker.isGenerating ? "generating on the server" : "fetching";
  return `${what} (${stage}, ${seconds(blocker.ageMs)}${blocker.stillWanted ? "" : ", no longer shown"})`;
}

function blockageText(blockage: ImageFetchBlockage, nowMs: number): string {
  const head = `${blockage.waitingCount} image${blockage.waitingCount == 1 ? "" : "s"} on hold for ` +
    `${seconds(nowMs - blockage.stalledSinceMs)}`;
  if (blockage.blockers.length == 0) {
    // Should not happen: nothing can start, but nothing is in progress.
    return `${head}, behind nothing in progress.`;
  }
  if (blockage.blockers[0].priority == ImageFetchPriority.High) {
    return `${head}, behind popup image ${describeBlocker(blockage.blockers[0])}.`;
  }
  return `${head}, behind ${blockage.blockers.map(describeBlocker).join("; ")}.`;
}

/**
 * Shows a toolbar message whilst images can't load because the fetches ahead of them are taking unusually long, and
 * briefly when they resume. Polls, since how long the image manager has been stalled is a matter of time passing.
 * Returns a function that stops it.
 */
export function startImageFetchBlockageWatch(store: StoreContextModel): () => void {
  // The current stall, once it has lasted long enough to report.
  let reportedStallSinceMs: number | null = null;
  let shownMessage: TransientMessage | null = null;
  let dismissed = false;

  const showMessage = (message: TransientMessage) => {
    shownMessage = message;
    store.overlay.toolbarTransientMessage.set(message);
  };

  const tick = () => {
    const nowMs = Date.now();
    const blockage = imageFetchBlockage(nowMs);
    const current = store.overlay.toolbarTransientMessage.get();
    const ownMessageShowing = shownMessage != null && current === shownMessage;

    if (blockage == null || nowMs - blockage.stalledSinceMs < WARN_AFTER_STALLED_MS) {
      if (reportedStallSinceMs != null) {
        const text = `Images resumed after ${seconds(nowMs - reportedStallSinceMs)} on hold.`;
        console.info(text);
        if (ownMessageShowing || current == null) {
          const resumed = { text, type: TransientMessageType.Info };
          showMessage(resumed);
          setTimeout(() => {
            if (store.overlay.toolbarTransientMessage.get() === resumed) { store.overlay.toolbarTransientMessage.set(null); }
          }, RESUMED_MESSAGE_MS);
        }
      }
      reportedStallSinceMs = null;
      shownMessage = null;
      dismissed = false;
      return;
    }

    if (reportedStallSinceMs == null) {
      reportedStallSinceMs = blockage.stalledSinceMs;
      console.warn(blockageText(blockage, nowMs), blockage);
    }
    if (dismissed) { return; }
    if (shownMessage != null && !ownMessageShowing) {
      // Dismissed (e.g. by a click), or replaced by another message. Not shown again until the next stall.
      dismissed = true;
      shownMessage = null;
      return;
    }
    // Don't replace another message. Try again next tick.
    if (shownMessage == null && current != null) { return; }
    showMessage({ text: blockageText(blockage, nowMs), type: TransientMessageType.Info });
  };

  const intervalId = setInterval(tick, POLL_MS);
  return () => clearInterval(intervalId);
}
