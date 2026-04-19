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

import { ContainerItem } from "../items/base/container-item";
import { asFileItem, isFile } from "../items/file-item";
import { asImageItem, isImage } from "../items/image-item";
import { itemState } from "../store/ItemState";


export interface ContainerChildrenStats {
  totalChildren: number,
  imageFileChildren: number,
  totalBytes: number,
}

export function calculateChildrenStats(containerItem: ContainerItem): ContainerChildrenStats {
  const children = containerItem.computed_children || [];
  let totalChildren = children.length;
  let imageFileChildren = 0;
  let totalBytes = 0;

  children.forEach((childId: string) => {
    const child = itemState.get(childId);
    if (child) {
      if (isImage(child)) {
        imageFileChildren++;
        totalBytes += asImageItem(child).fileSizeBytes || 0;
      } else if (isFile(child)) {
        imageFileChildren++;
        totalBytes += asFileItem(child).fileSizeBytes || 0;
      }
    }
  });

  return { totalChildren, imageFileChildren, totalBytes };
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}
