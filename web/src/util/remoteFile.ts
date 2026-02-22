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

import { appendRemoteSessionHeader, applyRotatedRemoteSessionHeader } from "./remoteSession";

const OBJECT_URL_CLEANUP_MS = 60000;

function fileUrl(host: string, itemId: string): string {
  return new URL(`/files/${itemId}`, host).href;
}

async function fetchRemoteFileBlob(host: string, itemId: string): Promise<Blob> {
  const headers: Record<string, string> = {};
  appendRemoteSessionHeader(host, headers);
  const response = await fetch(fileUrl(host, itemId), {
    method: "GET",
    headers,
  });
  applyRotatedRemoteSessionHeader(host, response);

  if (!response.ok || response.status !== 200) {
    throw new Error(`File fetch request failed: ${response.status}`);
  }

  return response.blob();
}

function cleanupObjectUrl(url: string): void {
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, OBJECT_URL_CLEANUP_MS);
}

function safeDownloadName(nameMaybe: string | null | undefined, fallback: string): string {
  if (nameMaybe == null || nameMaybe.trim().length === 0) {
    return fallback;
  }
  return nameMaybe.replace(/[\\/:*?"<>|]/g, "_");
}

export async function downloadRemoteFile(host: string, itemId: string, downloadNameMaybe?: string): Promise<void> {
  const blob = await fetchRemoteFileBlob(host, itemId);
  const objectUrl = URL.createObjectURL(blob);

  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = safeDownloadName(downloadNameMaybe, itemId);
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  cleanupObjectUrl(objectUrl);
}

export async function openRemoteFileInNewTab(host: string, itemId: string): Promise<void> {
  const popup = window.open("", "_blank", "noopener");
  try {
    const blob = await fetchRemoteFileBlob(host, itemId);
    const objectUrl = URL.createObjectURL(blob);
    cleanupObjectUrl(objectUrl);
    if (popup) {
      popup.location.href = objectUrl;
    } else {
      window.open(objectUrl, "_blank", "noopener");
    }
  } catch (e) {
    if (popup) {
      popup.close();
    }
    throw e;
  }
}
