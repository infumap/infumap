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


interface ImageFetchTask {
  key: string,
  path: string,
  baseUrlMaybe: string | null,
  resolve: (objectUrl: string) => void,
  reject: (reason: any) => void,
}


let waiting: Array<ImageFetchTask> = [];
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

export function getImage(path: string, origin: string | null, highPriority: boolean): Promise<string> {
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

    if (debug) { console.debug(`not in cache: ${key}. (highPriority: ${highPriority}).`); }
    if (highPriority) {
      function prepend(value: ImageFetchTask, array: Array<ImageFetchTask>) {
        var newArray = array.slice();
        newArray.unshift(value);
        return newArray;
      }
      waiting = prepend({ key, path, baseUrlMaybe: origin, resolve, reject }, waiting);
    } else {
      waiting.push({ key, path, baseUrlMaybe: origin, resolve, reject });
    }
    serveWaiting();
  });
};


function serveWaiting() {
  if (fetchInProgress.size < MAX_CONCURRENT_FETCH_REQUESTS && waiting.length > 0) {
    const task = waiting.shift() as ImageFetchTask;
    if (debug) { console.debug(`executing waiting fetch task: ${task.key}. ` + debugMsg(task.key) + containerDebugCounts()); }
    if (objectUrls.has(task.key) && objectUrls.get(task.key) != null) {
      // a waiting task that has now completed might have been for the same filename.
      task.resolve(objectUrls.get(task.key) as string);
      if (debug) { console.debug(`previous waiting task satisfied a subsequent request: ${task.key}.`) }
      serveWaiting();
      return;
    }
    const url = task.baseUrlMaybe == null
      ? task.path
      : new URL(task.path, task.baseUrlMaybe).href;
    const headers: Record<string, string> = {};
    if (task.baseUrlMaybe != null) {
      appendRemoteSessionHeader(task.baseUrlMaybe, headers);
    }
    const promise = fetch(url, { headers })
      .then((resp) => {
        if (task.baseUrlMaybe != null) {
          applyRotatedRemoteSessionHeader(task.baseUrlMaybe, resp);
        }
        if (!resp.ok || resp.status != 200) {
          throw new Error(`Image fetch request failed: ${resp.status}`);
        }
        return resp.blob();
      })
      .then((blob) => {
        fetchInProgress.delete(task.key);
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
        task.reject(error);
      })
      .finally(() => {
        serveWaiting();
      });
    fetchInProgress.set(task.key, promise);
  } else {
    if (debug) { console.debug(`serveWaiting noop: fetchInProgress.size: ${fetchInProgress.size}. waiting.length: ${waiting.length}.`); }
  }
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
    waiting = waiting.filter(t => t.key != key);
    if (waitingSizeBefore > waiting.length) {
      if (debug) { console.debug(`${waitingSizeBefore - waiting.length} waiting fetch task(s) for ${key} aborted.`); }
    }
    if (debug) { console.debug(`setting revoke objectURL timer: ${key}.`); }
    let timeoutId: any = setTimeout(() => {
      if (objectUrlsRefCount.get(key) == 0) {
        URL.revokeObjectURL(objectUrls.get(key) as string);
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
