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

import { Component, onMount } from 'solid-js';
import { render } from 'solid-js/web';
import { base64ArrayBuffer } from "./util/base64ArrayBuffer";
import { sanitizeOriginalCreationDate } from "./util/time";
import './index.css';


const App: Component = () => {
  onMount(async () => {
    const addPath = "/add";
    if (!location.href.endsWith(addPath)) {
      throw "Unexpected path";
    }
    const response = await fetch("/account/validate-session", { method: 'POST' });
    try {
      if (response.status == 200) {
        const body = await response.json();
        if (body.success) {
          return;
        }
      }
    } catch (e) { console.warn("Session validation failed:", e); }
    location.href = location.href.substring(0, location.href.length - addPath.length) + "/login?redirect=" + encodeURIComponent("/add");
  });

  return (
    <>
      <div style="padding-top: 10px; padding-left: 10px; font-weight: bold;">Add Note</div>
      <div style="padding-left: 10px; padding-right: 10px; padding-top: 2px; padding-bottom: 2px;">
        <textarea id="note" rows="6"
          class="border border-slate-700 rounded-md"
          style="position: relative; width: 100%; box-sizing: border-box; font-size: 16px; padding: 5px;" />
      </div>
      <div style="padding-left: 10px;">
        <button class="border border-slate-700 rounded-md"
          style="padding: 5px;"
          onclick={handleSubmit}>submit</button>
      </div>
      <div style="padding-left: 10px; padding-right: 10px; padding-top: 2px; padding-bottom: 16px;" id="status"></div>

      <div style="padding-top: 5px; padding-left: 10px; font-weight: bold;">Add Link</div>
      <div style="padding-left: 10px; padding-right: 10px; padding-top: 2px; padding-bottom: 2px;">
        <input type="text" id="link" inputmode="url" autocomplete="url"
          class="border border-slate-700 rounded-md"
          style="position: relative; width: 100%; box-sizing: border-box; font-size: 16px; padding: 5px;"
          onkeydown={handleLinkKeyDown} />
      </div>
      <div style="padding-left: 10px;">
        <button class="border border-slate-700 rounded-md"
          style="padding: 5px;"
          onclick={handleLinkSubmit}>add</button>
      </div>
      <div style="padding-left: 10px; padding-right: 10px; padding-top: 2px; padding-bottom: 16px;" id="link_status"></div>

      <div style="padding-top: 5px; padding-left: 10px; padding-bottom: 4px; font-weight: bold;">Add Image</div>
      <input type="file" id="file-input" style="display: none" onchange={handleFileInputUpdated} multiple={false} />
      <div style="padding-left: 10px;">
        <button class="border border-slate-700 rounded-md"
          style="padding: 5px;"
          onclick={handleImageSubmit}>upload</button>
      </div>
      <div style="padding-left: 10px; padding-right: 10px; padding-top: 2px; padding-bottom: 16px;" id="image_status"></div>
    </>
  );
}


type CommandResponse = {
  success: boolean,
  failReason?: string | null,
  jsonData?: string | null,
};

const STATUS_TIMEOUT_MS = 2000;
const statusClearTimeouts = new Map<string, number>();

function setStatus(statusElementId: string, text: string) {
  const existingTimeout = statusClearTimeouts.get(statusElementId);
  if (existingTimeout != null) {
    window.clearTimeout(existingTimeout);
    statusClearTimeouts.delete(statusElementId);
  }
  document.getElementById(statusElementId)!.textContent = text;
}

function showTimedStatus(statusElementId: string, text: string) {
  setStatus(statusElementId, text);
  const timeout = window.setTimeout(() => {
    document.getElementById(statusElementId)!.textContent = "";
    statusClearTimeouts.delete(statusElementId);
  }, STATUS_TIMEOUT_MS);
  statusClearTimeouts.set(statusElementId, timeout);
}

async function postCommand(command: string, jsonData: string, base64Data?: string): Promise<CommandResponse> {
  const body: { command: string, jsonData: string, base64Data?: string } = { command, jsonData };
  if (base64Data != null) {
    body.base64Data = base64Data;
  }
  const response = await fetch("/command", {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  return await response.json();
}

async function handleFileInputUpdated() {
  const fileInputElement = document.getElementById("file-input")! as HTMLInputElement;
  if (fileInputElement.value == null || fileInputElement.files == null) {
    console.error("no file");
    return;
  }
  const file = fileInputElement.files[0];
  let base64Data = base64ArrayBuffer(await file.arrayBuffer());
  const jsonData = JSON.stringify({
    itemType: "image",
    title: file.name,
    spatialWidthGr: 4.0 * 60,
    originalCreationDate: sanitizeOriginalCreationDate(Math.round(file.lastModified / 1000.0), `adding image ${file.name}`),
    fileSizeBytes: file.size,
  });
  setStatus("image_status", "adding");
  try {
    const response = await postCommand("add-item", jsonData, base64Data);
    showTimedStatus("image_status", response.success ? "added" : "error");
  } catch (e) {
    console.warn("Could not add image:", e);
    showTimedStatus("image_status", "error");
  }
}


function handleImageSubmit() {
  const fileInputElement = document.getElementById("file-input")!;
  fileInputElement.click();
}


async function handleSubmit() {
  const jsonData = JSON.stringify({
    itemType: "note",
    title: (document.getElementById("note")! as HTMLInputElement).value,
    url: "",
    spatialWidthGr: 8 * 60,
  });
  setStatus("status", "adding");
  (document.getElementById("note")! as HTMLInputElement).value = "";
  try {
    const response = await postCommand("add-item", jsonData);
    showTimedStatus("status", response.success ? "added" : "error");
  } catch (e) {
    console.warn("Could not add note:", e);
    showTimedStatus("status", "error");
  }
}


function handleLinkKeyDown(event: KeyboardEvent) {
  if (event.key == "Enter") {
    event.preventDefault();
    handleLinkSubmit();
  }
}


async function handleLinkSubmit() {
  const linkInputElement = document.getElementById("link")! as HTMLInputElement;
  const normalizedUrl = normalizeLinkUrl(linkInputElement.value);
  if (normalizedUrl == null) {
    showTimedStatus("link_status", "invalid link");
    return;
  }

  setStatus("link_status", "adding");
  try {
    const response = await postCommand("add-link-note", JSON.stringify({ url: normalizedUrl }));
    if (response.success) {
      linkInputElement.value = "";
      showTimedStatus("link_status", "added");
    } else {
      showTimedStatus("link_status", "error");
    }
  } catch (e) {
    console.warn("Could not add link:", e);
    showTimedStatus("link_status", "error");
  }
}


function normalizeLinkUrl(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed == "") {
    return null;
  }

  const candidate = trimmed.includes("://")
    ? trimmed
    : hasNonHttpUrlScheme(trimmed)
      ? null
      : looksLikeUrlWithoutScheme(trimmed)
        ? `https://${trimmed}`
        : null;
  if (candidate == null) {
    return null;
  }

  try {
    const url = new URL(candidate);
    if ((url.protocol != "http:" && url.protocol != "https:") || url.hostname == "") {
      return null;
    }
    return url.href;
  } catch (_e) {
    return null;
  }
}


function hasNonHttpUrlScheme(value: string): boolean {
  const colonIdx = value.indexOf(":");
  if (colonIdx == -1) {
    return false;
  }
  const firstPathIdx = minNonNegativeIndex(value.indexOf("/"), value.indexOf("?"), value.indexOf("#"));
  if (firstPathIdx != -1 && colonIdx > firstPathIdx) {
    return false;
  }
  const scheme = value.substring(0, colonIdx);
  return !scheme.includes(".") &&
    /^[a-zA-Z]/.test(scheme) &&
    /^[a-zA-Z0-9+.-]+$/.test(scheme);
}


function looksLikeUrlWithoutScheme(value: string): boolean {
  const authority = value.split(/[/?#]/, 1)[0] ?? "";
  const hostPort = authority.split("@").pop() ?? authority;
  const host = hostPort.startsWith("[")
    ? hostPort.substring(0, hostPort.indexOf("]") + 1)
    : hostPort.split(":", 1)[0];
  return host.includes(".") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || (host.startsWith("[") && host.endsWith("]"));
}


function minNonNegativeIndex(...indices: Array<number>): number {
  const nonNegative = indices.filter(index => index != -1);
  if (nonNegative.length == 0) {
    return -1;
  }
  return Math.min(...nonNegative);
}


render(() => (
  <App />
), document.getElementById("rootDiv") as HTMLElement);
