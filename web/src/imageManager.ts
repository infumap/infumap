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


const MAX_CONCURRENT_FETCH_REQUESTS: number = 3;
const CLEANUP_AFTER_MS: number = 30000;


interface ImageFetchTask {
  path: string,
  baseUrlMaybe: string | null,
  resolve: (objectUrl: string) => void,
  reject: (reason: any) => void,
}


let waiting: Array<ImageFetchTask> = [];
let fetchInProgress: Map<string, Promise<string | void>> = new Map<string, Promise<void>>(); // filename -> the fetch promise.
let waitingForCleanup: Map<string, number> = new Map<string, number>(); // filename => timeoutId.

let objectUrls: Map<string, string | null> = new Map<string, string | null>(); // filename => objectUrl.
let objectUrlsRefCount: Map<string, number> = new Map<string, number>(); // filename => refCount.

const debug = false;

function containerDebugCounts(): string {
  return `objectUrls.size: ${objectUrls.size}. objectURlsRefCount.size: ${objectUrlsRefCount.size}. waitingForCleanup.size: ${waitingForCleanup.size}. fetchInProgress.size: ${fetchInProgress.size}. waiting.length: ${waiting.length}. `;
}

function debugMsg(filename: string): string {
  return (
    `${filename}. currentObjectUrl: ${objectUrls.get(filename)}. refCountBeforeGet: ${objectUrlsRefCount.get(filename)}. ` +
    `wasWaitingForCleanup: ${typeof waitingForCleanup.get(filename) !== 'undefined'}. hasFetchInProgress: ${typeof fetchInProgress.get(filename) !== 'undefined'}. `
  );
}

export function getImage(path: string, origin: string | null, highPriority: boolean): Promise<string> {
  if (debug) { console.debug(`getImage: ` + debugMsg(path) + containerDebugCounts()); }

  const cleanupIdMaybe = waitingForCleanup.get(path);
  if (cleanupIdMaybe) {
    if (debug) { console.debug(`cancelling cleanup: ${path}.`); }
    clearTimeout(cleanupIdMaybe);
    waitingForCleanup.delete(path);
  }

  return new Promise((resolve, reject) => { // called when the Promise is constructed.
    if (!objectUrlsRefCount.has(path)) {
      if (debug) { console.debug(`init bookkeeping for: ${path}.`); }
      objectUrlsRefCount.set(path, 0);
      if (objectUrls.has(path)) { throw new Error('objectUrls and ObjectUrlsRefCount out of sync.'); }
      objectUrls.set(path, null);
    }

    objectUrlsRefCount.set(path, (objectUrlsRefCount.get(path) as number) + 1);
    if (objectUrls.get(path) != null) {
      if (debug) { console.debug(`in cache: ${path}.`); }
      resolve(objectUrls.get(path) as string);
      return;
    }

    if (debug) { console.debug(`not in cache: ${path}. (highPriority: ${highPriority}).`); }
    if (highPriority) {
      function prepend(value: ImageFetchTask, array: Array<ImageFetchTask>) {
        var newArray = array.slice();
        newArray.unshift(value);
        return newArray;
      }
      waiting = prepend({ path, baseUrlMaybe: origin, resolve, reject }, waiting);
    } else {
      waiting.push({ path, baseUrlMaybe: origin, resolve, reject });
    }
    serveWaiting();
  });
};


function serveWaiting() {
  if (fetchInProgress.size < MAX_CONCURRENT_FETCH_REQUESTS && waiting.length > 0) {
    const task = waiting.shift() as ImageFetchTask;
    if (debug) { console.debug(`executing waiting fetch task: ${task.path}. ` + debugMsg(task.path) + containerDebugCounts()); }
    if (objectUrls.has(task.path) && objectUrls.get(task.path) != null) {
      // a waiting task that has now completed might have been for the same filename.
      task.resolve(objectUrls.get(task.path) as string);
      if (debug) { console.debug(`previous waiting task satisfied a subsequent request: ${task.path}.`) }
      serveWaiting();
      return;
    }
    const url = task.baseUrlMaybe == null
      ? task.path
      : new URL(task.path, task.baseUrlMaybe).href;
    const promise = fetch(url)
      .then((resp) => {
        if (!resp.ok || resp.status != 200) {
          throw new Error(`Image fetch request failed: ${resp.status}`);
        }
        return resp.blob();
      })
      .then((blob) => {
        fetchInProgress.delete(task.path);
        if (objectUrls.get(task.path) != null) {
          // it's possible another fetch request for the same filename completed whilst this one was waiting for the blob.
          if (debug) { console.debug(`fetched complete but task already resolved: ${task.path}.`); }
          task.resolve(objectUrls.get(task.path) as string);
        } else {
          const objectUrl: string = URL.createObjectURL(blob);
          objectUrls.set(task.path, objectUrl);
          if (debug) { console.debug(`fetch complete: ${task.path}`); }
          task.resolve(objectUrl);
        }
      })
      .catch((error) => {
        if (debug) { console.debug(`fetch failed: ${task.path}`); }
        fetchInProgress.delete(task.path);
        task.reject(error);
      })
      .finally(() => {
        serveWaiting();
      });
    fetchInProgress.set(task.path, promise);
  } else {
    if (debug) { console.debug(`serveWaiting noop: fetchInProgress.size: ${fetchInProgress.size}. waiting.length: ${waiting.length}.`); }
  }
}

export function releaseImage(filename: string) {
  if (!objectUrlsRefCount.has(filename)) {
    console.error(`objectUrlRefCount map does not contain: ${filename}`);
    return;
  }
  if (objectUrlsRefCount.get(filename) == 0) {
    console.error(`objectUrlRefCount map value for ${filename} is 0.`);
    return;
  }
  const newRefCount = objectUrlsRefCount.get(filename) as number - 1;
  objectUrlsRefCount.set(filename, newRefCount);
  if (debug) { console.debug(`releaseImage called: ${filename}. newRefCount: ${newRefCount}.`); }
  if (newRefCount === 0) {
    const waitingSizeBefore = waiting.length;
    waiting = waiting.filter(t => t.path != filename);
    if (waitingSizeBefore > waiting.length) {
      if (debug) { console.debug(`${waitingSizeBefore - waiting.length} waiting fetch task(s) for ${filename} aborted.`); }
    }
    if (debug) { console.debug(`setting revoke objectURL timer: ${filename}.`); }
    let timeoutId: any = setTimeout(() => {
      if (objectUrlsRefCount.get(filename) == 0) {
        URL.revokeObjectURL(objectUrls.get(filename) as string);
        objectUrls.delete(filename);
        objectUrlsRefCount.delete(filename);
        waitingForCleanup.delete(filename);
        if (debug) { console.debug(`revoke objectURL complete: ${filename}.`); }
      } else {
        console.error(`WARNING: release called when ref count > 0: ${filename}.`);
      }
    }, CLEANUP_AFTER_MS);
    waitingForCleanup.set(filename, timeoutId);
  } else {
    if (debug) { console.debug(`image still in use: ${filename}.`); }
  }
}
