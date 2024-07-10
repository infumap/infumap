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
import "tailwindcss/tailwind.css";
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
    } catch {}
    location.href = location.href.substring(0, location.href.length - addPath.length) + "/login?redirect=add";
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
      <input type="file" id="file-input" style="display: none" onchange={handleFileInputUpdated} multiple={false} />
      <div style="padding-left: 10px;">
        <button class="border border-slate-700 rounded-md"
                style="padding: 5px;"
                onclick={handleImageSubmit}>submit image</button>
      </div>
    </>
  );
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
    originalCreationDate: Math.round(file.lastModified/1000.0),
    mimeType: file.type,
    fileSizeBytes: file.size,
  });
  await fetch("/command", {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ command: "add-item", jsonData, base64Data })
  });
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
  document.getElementById("status")!.textContent = "adding";
  await fetch("/command", {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ command: "add-item", jsonData })
  });
  document.getElementById("status")!.textContent = "added";
  setTimeout(() => {
    document.getElementById("status")!.textContent = "";
  }, 2000);
}


render(() => (
  <App />
), document.getElementById("rootDiv") as HTMLElement);
