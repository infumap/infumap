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

import { Component, Show } from "solid-js";
import { useStore } from "../../store/StoreProvider";
import { Z_INDEX_TEXT_OVERLAY } from "../../constants";

export const UploadOverlay: Component = () => {
  const store = useStore();

  const uploadInfo = () => store.overlay.uploadOverlayInfo.get();

  const boxBoundsPx = () => {
    const desktopBounds = store.desktopBoundsPx();
    const boxWidth = 320;
    const boxHeight = 125;
    return ({
      x: (desktopBounds.w - boxWidth) / 2,
      y: (desktopBounds.h - boxHeight) / 2,
      w: boxWidth,
      h: boxHeight
    });
  };

  const progressPercentage = () => {
    const info = uploadInfo();
    if (!info) return 0;
    return Math.round((info.currentFile / info.totalFiles) * 100);
  };

  return (
    <Show when={uploadInfo() != null}>
      <div class="absolute left-0 top-0 bottom-0 right-0 select-none outline-hidden"
           style={`background-color: #00000040; z-index: ${Z_INDEX_TEXT_OVERLAY}; display: flex; align-items: center; justify-content: center;`}>
        <div class="border border-slate-700 rounded-md bg-white shadow-lg"
             style={`width: ${boxBoundsPx().w}px; height: ${boxBoundsPx().h}px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);`}>
          <div class="px-4 py-3 h-full flex flex-col justify-center">
            <div class="flex items-center mb-3">
              <span class="font-medium">Uploading files...</span>
            </div>
            <div class="mb-2">
              <div class="flex justify-between text-sm text-gray-600 mb-1">
                <span>{uploadInfo()!.currentFile} of {uploadInfo()!.totalFiles}</span>
                <span>{progressPercentage()}%</span>
              </div>
              <div class="w-full bg-gray-200 rounded-md h-2">
                <div class="bg-blue-500 h-2 rounded-md transition-all duration-300"
                     style={`width: ${progressPercentage()}%;`} />
              </div>
            </div>
            <div class="text-xs text-gray-500 truncate">
              {uploadInfo()!.currentFileName}
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
};