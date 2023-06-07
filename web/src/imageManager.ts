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


const MAX_CONCURRENT_FETCH_REQUESTS: number = 5;
const CLEANUP_AFTER_MS: number = 10000;


interface ImageFetchTask {
  filename: string,
  resolve: (objectUrl: string) => void,
  reject: (reason: any) => void,
}


let waiting: Array<ImageFetchTask> = [];
let fetchInProgress: Map<string, Promise<string | void>> = new Map<string, Promise<void>>(); // filename -> the fetch promise.
let waitingForCleanup: Map<string, number> = new Map<string, number>(); // filename => timeoutId.

let objectUrls: Map<string, string | null> = new Map<string, string | null>(); // filename => objectUrl.
let objectUrlsRefCount: Map<string, number> = new Map<string, number>(); // filename => refCount.


export function getImage(filename: string): Promise<string> {
  // console.debug(`get: ${filename}`, objectUrls, objectUrlsRefCount);
  return new Promise((resolve, reject) => { // called when the Promise is constructed.
    if (objectUrlsRefCount.has(filename)) {
      objectUrlsRefCount.set(filename, (objectUrlsRefCount.get(filename) as number) + 1);
      if (objectUrls.get(filename) != null) {
        resolve(objectUrls.get(filename) as string);
        // console.debug(`have: ${filename}`, objectUrls, objectUrlsRefCount);
        return;
      }
      // TODO (LOW): this fallthrough case is not optimal, as the image will be fetched multiple times. however it is not incorrect.
    } else {
      objectUrlsRefCount.set(filename, 1);
      objectUrls.set(filename, null);
    }
    waiting.push({ filename, resolve, reject });
    serveWaiting();
  });
};

function serveWaiting() {
  if (fetchInProgress.size < MAX_CONCURRENT_FETCH_REQUESTS && waiting.length > 0) {
    const task = waiting.shift() as ImageFetchTask;
    if (objectUrls.has(task.filename) && objectUrls.get(task.filename) != null) {
      // a waiting task that has now completed might have been for the same filename.
      task.resolve(objectUrls.get(task.filename) as string);
      // console.debug(`have (2): ${task.filename}`, objectUrls, objectUrlsRefCount);
      serveWaiting();
      return;
    }
    const promise = fetch(task.filename)
      .then((resp) => {
        if (!resp.ok || resp.status != 200) {
          throw new Error(`Image fetch request failed: ${resp.status}`);
        }
        // if (resp.status == 403) {
        //   // Server rejected due to invalid session.
        //   // await logout!();
        //   // return;
        // }
        // if (resp.status == 503) {
        //   // Server rejected request due to too many existing outstanding file requests.
        //   // TODO (MEDIUM): global image download manager, which pipelines requests.
        //   // await new Promise(r => setTimeout(r, 1000 + Math.random()*3000));
        //   // return;
        // }
        return resp.blob();
      })
      .then((blob) => {
        fetchInProgress.delete(task.filename);
        if (objectUrls.get(task.filename) != null) {
          // it's possible another fetch request for the same filename completed whilst this one was waiting for the blob.
          task.resolve(objectUrls.get(task.filename) as string);
          // console.debug(`fetched (have): ${task.filename}`, objectUrls, objectUrlsRefCount);
        } else {
          const objectUrl: string = URL.createObjectURL(blob);
          objectUrls.set(task.filename, objectUrl);
          task.resolve(objectUrl);
          // console.debug(`fetched (added): ${task.filename}`, objectUrls, objectUrlsRefCount);
        }
      })
      .catch((error) => {
        fetchInProgress.delete(task.filename);
        task.reject(error);
      })
      .finally(() => {
        serveWaiting();
      });
    fetchInProgress.set(task.filename, promise);
  }
}

export function releaseImage(filename: string) {
  if (!objectUrlsRefCount.has(filename)) {
    throw new Error(`objectUrlRefCount map does not contain: ${filename}`);
  }
  if (objectUrlsRefCount.get(filename) == 0) {
    throw new Error(`objectUrlRefCount map value for ${filename} is 0.`);
  }
  const newRefCount = objectUrlsRefCount.get(filename) as number - 1;
  objectUrlsRefCount.set(filename, newRefCount);
  // console.debug(`released: ${filename}`, objectUrls, objectUrlsRefCount);
  if (newRefCount === 0) {
    let timeoutId = setTimeout(() => {
      if (objectUrlsRefCount.get(filename) == 0) {
        URL.revokeObjectURL(objectUrls.get(filename) as string);
        objectUrls.delete(filename);
        objectUrlsRefCount.delete(filename);
        waitingForCleanup.delete(filename);
        // console.debug(`deleted: ${filename}`, objectUrls, objectUrlsRefCount);
      }
    }, CLEANUP_AFTER_MS);
    waitingForCleanup.set(filename, timeoutId);
  }
}
