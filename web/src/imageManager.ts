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


// TODO (LOW):
//  1. cancel fetches if no longer required. https://javascript.info/fetch-abort
//  2. retry failed fetches.

import { appendRemoteSessionHeader, applyRotatedRemoteSessionHeader } from "./util/remoteSession";

const MAX_CONCURRENT_FETCH_REQUESTS: number = 3;
const CLEANUP_AFTER_MS: number = 30000;

// An image request is first made with DEFER_IMAGE_HEADER_NAME set, to which the server responds without waiting for
// anything slow: with the image if it is cached, otherwise with a smaller cached rendition marked with
// PARTIAL_IMAGE_HEADER_NAME (shown as an interim image), or 202 if there is none. In the latter two cases, the server
// starts generating the image, and a follow-up request (without the header) is queued, which waits for it. All initial
// requests are made before any follow-up requests, so everything that is quick to get is got first. Neither partial nor
// 202 responses are cached by the browser. Servers that do not support this ignore the header.
const DEFER_IMAGE_HEADER_NAME = "x-infumap-image-defer";
const PARTIAL_IMAGE_HEADER_NAME = "x-infumap-partial-image";
// Sent with the initial request for a high priority image, so that generating it on the server does not queue behind
// other images.
const HIGH_PRIORITY_IMAGE_HEADER_NAME = "x-infumap-image-priority-high";


export enum ImageFetchPriority {
  High = 0,    // e.g. images in popups.
  Normal = 1,  // images on interactive pages.
  Low = 2,     // images in translucent (preview) pages.
}

interface ImageFetchTask {
  key: string,
  priority: ImageFetchPriority,
  path: string,
  baseUrlMaybe: string | null,
  onInterim: ((objectUrl: string) => void) | null,
  resolve: (objectUrl: string) => void,
  reject: (reason: any) => void,
  isFollowUp: boolean,
  interimObjectUrl: string | null,
}


let waiting: Array<ImageFetchTask> = [];
let highPriorityFetchesInProgress = 0;
let fetchInProgress: Map<string, Promise<string | void>> = new Map<string, Promise<string | void>>(); // cache key -> fetch promise.
let waitingForCleanup: Map<string, number> = new Map<string, number>(); // cache key => timeoutId.

let objectUrls: Map<string, string | null> = new Map<string, string | null>(); // cache key => objectUrl.
let objectUrlsRefCount: Map<string, number> = new Map<string, number>(); // cache key => refCount.

const debug = false;

function containerDebugCounts(): string {
  return `objectUrls.size: ${objectUrls.size}. objectURlsRefCount.size: ${objectUrlsRefCount.size}. waitingForCleanup.size: ${waitingForCleanup.size}. fetchInProgress.size: ${fetchInProgress.size}. waiting.length: ${waiting.length}. `;
}

function debugMsg(cacheKey: string): string {
  return (
    `${cacheKey}. currentObjectUrl: ${objectUrls.get(cacheKey)}. refCountBeforeGet: ${objectUrlsRefCount.get(cacheKey)}. ` +
    `wasWaitingForCleanup: ${typeof waitingForCleanup.get(cacheKey) !== 'undefined'}. hasFetchInProgress: ${typeof fetchInProgress.get(cacheKey) !== 'undefined'}. `
  );
}

function cacheKey(path: string, baseUrlMaybe: string | null): string {
  if (baseUrlMaybe == null) {
    return path;
  }
  try {
    return `${new URL(baseUrlMaybe).origin}${path}`;
  } catch (_e) {
    return `${baseUrlMaybe}${path}`;
  }
}

/**
 * Fetch the image at path. onInterim, if provided, may be called with a lower resolution rendition of the image before
 * the returned promise resolves. An interim object url is revoked some time after the promise settles.
 */
export function getImage(
    path: string,
    origin: string | null,
    priority: ImageFetchPriority,
    onInterim: ((objectUrl: string) => void) | null = null): Promise<string> {
  const key = cacheKey(path, origin);
  if (debug) { console.debug(`getImage: ` + debugMsg(key) + containerDebugCounts()); }

  const cleanupIdMaybe = waitingForCleanup.get(key);
  if (cleanupIdMaybe) {
    if (debug) { console.debug(`cancelling cleanup: ${key}.`); }
    clearTimeout(cleanupIdMaybe);
    waitingForCleanup.delete(key);
  }

  return new Promise((resolve, reject) => { // called when the Promise is constructed.
    if (!objectUrlsRefCount.has(key)) {
      if (debug) { console.debug(`init bookkeeping for: ${key}.`); }
      objectUrlsRefCount.set(key, 0);
      if (objectUrls.has(key)) { throw new Error('objectUrls and ObjectUrlsRefCount out of sync.'); }
      objectUrls.set(key, null);
    }

    objectUrlsRefCount.set(key, (objectUrlsRefCount.get(key) as number) + 1);
    if (objectUrls.get(key) != null) {
      if (debug) { console.debug(`in cache: ${key}.`); }
      resolve(objectUrls.get(key) as string);
      return;
    }

    if (debug) { console.debug(`not in cache: ${key}. (priority: ${priority}).`); }
    enqueue({ key, path, baseUrlMaybe: origin, priority, onInterim, resolve, reject, isFollowUp: false, interimObjectUrl: null });
    serveWaiting();
  });
};

// High priority requests (initial or follow-up) come first. Then all other initial requests come before all other
// follow-up requests, then by priority.
const taskRank = (task: ImageFetchTask): number =>
  task.priority == ImageFetchPriority.High ? 0 : (task.isFollowUp ? 3 : 0) + task.priority;

function enqueue(task: ImageFetchTask) {
  if (task.priority == ImageFetchPriority.High) {
    // Most recently requested first: the user is most likely to be looking at the latest popup.
    waiting = [task, ...waiting];
    return;
  }
  // After all waiting tasks of the same or higher rank.
  const rank = taskRank(task);
  const insertIdx = waiting.findIndex(t => taskRank(t) > rank);
  waiting = insertIdx == -1
    ? [...waiting, task]
    : [...waiting.slice(0, insertIdx), task, ...waiting.slice(insertIdx)];
}

function revokeInterimLater(task: ImageFetchTask) {
  if (task.interimObjectUrl == null) { return; }
  // Delayed, since the interim image may still be displayed until the final one has loaded.
  const toRevoke = task.interimObjectUrl;
  task.interimObjectUrl = null;
  setTimeout(() => { URL.revokeObjectURL(toRevoke); }, CLEANUP_AFTER_MS);
}


function canStartNextWaiting(): boolean {
  if (waiting.length == 0) { return false; }
  // High priority fetches are started immediately, and whilst any are in progress no others are started, so they get
  // as much of the bandwidth as possible.
  if (waiting[0].priority == ImageFetchPriority.High) { return true; }
  return highPriorityFetchesInProgress == 0 && fetchInProgress.size < MAX_CONCURRENT_FETCH_REQUESTS;
}

function serveWaiting() {
  if (!canStartNextWaiting() && debug) {
    console.debug(`serveWaiting noop: fetchInProgress.size: ${fetchInProgress.size}. waiting.length: ${waiting.length}.`);
  }
  while (canStartNextWaiting()) {
    const task = waiting.shift() as ImageFetchTask;
    if (debug) { console.debug(`executing waiting fetch task: ${task.key}. ` + debugMsg(task.key) + containerDebugCounts()); }
    if (objectUrls.has(task.key) && objectUrls.get(task.key) != null) {
      // a waiting task that has now completed might have been for the same filename.
      revokeInterimLater(task);
      task.resolve(objectUrls.get(task.key) as string);
      if (debug) { console.debug(`previous waiting task satisfied a subsequent request: ${task.key}.`) }
      continue;
    }
    startFetch(task);
  }
}

function startFetch(task: ImageFetchTask) {
  const isHighPriority = task.priority == ImageFetchPriority.High;
  if (isHighPriority) { highPriorityFetchesInProgress += 1; }
  const url = task.baseUrlMaybe == null
    ? task.path
    : new URL(task.path, task.baseUrlMaybe).href;
  const headers: Record<string, string> = {};
  if (task.baseUrlMaybe != null) {
    appendRemoteSessionHeader(task.baseUrlMaybe, headers);
  }
  if (!task.isFollowUp) {
    headers[DEFER_IMAGE_HEADER_NAME] = "1";
    if (isHighPriority) {
      headers[HIGH_PRIORITY_IMAGE_HEADER_NAME] = "1";
    }
  }
  const queueFollowUp = () => {
    fetchInProgress.delete(task.key);
    if (!((objectUrlsRefCount.get(task.key) ?? 0) > 0)) {
      // Released whilst the initial request was in progress, so no longer required.
      if (debug) { console.debug(`follow-up not required: ${task.key}.`); }
      revokeInterimLater(task);
      return;
    }
    enqueue({ ...task, isFollowUp: true });
  };
  const promise = fetch(url, { headers })
    .then(async (resp) => {
      if (task.baseUrlMaybe != null) {
        applyRotatedRemoteSessionHeader(task.baseUrlMaybe, resp);
      }
      if (!task.isFollowUp && resp.status == 202) {
        if (debug) { console.debug(`image pending: ${task.key}.`); }
        queueFollowUp();
        return;
      }
      if (!resp.ok || resp.status != 200) {
        throw new Error(`Image fetch request failed: ${resp.status}`);
      }
      if (!task.isFollowUp && resp.headers.get(PARTIAL_IMAGE_HEADER_NAME) != null) {
        if (debug) { console.debug(`partial image received: ${task.key}.`); }
        task.interimObjectUrl = URL.createObjectURL(await resp.blob());
        try {
          task.onInterim?.(task.interimObjectUrl);
        } catch (e) {
          console.warn(`Interim image handler for '${task.key}' failed:`, e);
        }
        queueFollowUp();
        return;
      }
      const blob = await resp.blob();
      fetchInProgress.delete(task.key);
      revokeInterimLater(task);
      if (objectUrls.get(task.key) != null) {
        // it's possible another fetch request for the same filename completed whilst this one was waiting for the blob.
        if (debug) { console.debug(`fetched complete but task already resolved: ${task.key}.`); }
        task.resolve(objectUrls.get(task.key) as string);
      } else {
        const objectUrl: string = URL.createObjectURL(blob);
        objectUrls.set(task.key, objectUrl);
        if (debug) { console.debug(`fetch complete: ${task.key}`); }
        task.resolve(objectUrl);
      }
    })
    .catch((error) => {
      if (debug) { console.debug(`fetch failed: ${task.key}`); }
      fetchInProgress.delete(task.key);
      revokeInterimLater(task);
      task.reject(error);
    })
    .finally(() => {
      if (isHighPriority) { highPriorityFetchesInProgress -= 1; }
      serveWaiting();
    });
  fetchInProgress.set(task.key, promise);
}

export function releaseImage(path: string, origin: string | null) {
  const key = cacheKey(path, origin);
  if (!objectUrlsRefCount.has(key)) {
    console.error(`objectUrlRefCount map does not contain: ${key}`);
    return;
  }
  if (objectUrlsRefCount.get(key) == 0) {
    console.error(`objectUrlRefCount map value for ${key} is 0.`);
    return;
  }
  const newRefCount = objectUrlsRefCount.get(key) as number - 1;
  objectUrlsRefCount.set(key, newRefCount);
  if (debug) { console.debug(`releaseImage called: ${key}. newRefCount: ${newRefCount}.`); }
  if (newRefCount === 0) {
    const waitingSizeBefore = waiting.length;
    waiting.filter(t => t.key == key).forEach(revokeInterimLater);
    waiting = waiting.filter(t => t.key != key);
    if (waitingSizeBefore > waiting.length) {
      if (debug) { console.debug(`${waitingSizeBefore - waiting.length} waiting fetch task(s) for ${key} aborted.`); }
    }
    if (debug) { console.debug(`setting revoke objectURL timer: ${key}.`); }
    let timeoutId: any = setTimeout(() => {
      if (objectUrlsRefCount.get(key) == 0) {
        const objectUrl = objectUrls.get(key);
        if (objectUrl != null) {
          URL.revokeObjectURL(objectUrl);
        }
        objectUrls.delete(key);
        objectUrlsRefCount.delete(key);
        waitingForCleanup.delete(key);
        if (debug) { console.debug(`revoke objectURL complete: ${key}.`); }
      } else {
        console.error(`WARNING: release called when ref count > 0: ${key}.`);
      }
    }, CLEANUP_AFTER_MS);
    waitingForCleanup.set(key, timeoutId);
  } else {
    if (debug) { console.debug(`image still in use: ${key}.`); }
  }
}

/**
 * Synchronously acquires the widest rendition of an image that has already been fetched, if any. The caller must
 * release it with releaseImage(path, origin).
 */
export function acquireFetchedImageMaybe(itemId: string, origin: string | null): { path: string, objectUrl: string } | null {
  const pathPrefix = `/files/${itemId}_`;
  const keyPrefix = cacheKey(pathPrefix, origin);
  let bestKey: string | null = null;
  let bestWidthPx = -1;
  for (const [key, objectUrl] of objectUrls) {
    if (objectUrl == null || !key.startsWith(keyPrefix)) { continue; }
    const widthPx = parseInt(key.substring(keyPrefix.length));
    if (widthPx > bestWidthPx) {
      bestKey = key;
      bestWidthPx = widthPx;
    }
  }
  if (bestKey == null) { return null; }

  const cleanupIdMaybe = waitingForCleanup.get(bestKey);
  if (cleanupIdMaybe) {
    clearTimeout(cleanupIdMaybe);
    waitingForCleanup.delete(bestKey);
  }
  objectUrlsRefCount.set(bestKey, (objectUrlsRefCount.get(bestKey) as number) + 1);
  return { path: pathPrefix + bestWidthPx, objectUrl: objectUrls.get(bestKey) as string };
}

/**
 * Whether any image fetches are waiting or in progress.
 */
export function imageFetchesPending(): boolean {
  return waiting.length > 0 || fetchInProgress.size > 0;
}
