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

import { createSignal } from "solid-js";


export enum NoteFaviconLoadStatus {
  Idle = "idle",
  Loading = "loading",
  Loaded = "loaded",
  Failed = "failed",
}


const statuses = new Map<string, NoteFaviconLoadStatus>();
const [statusVersion, setStatusVersion] = createSignal(0);


export function noteFaviconKey(path: string, origin: string | null): string {
  return `${origin ?? ""}|${path}`;
}


export function noteFaviconStatus(path: string | null, origin: string | null): NoteFaviconLoadStatus {
  statusVersion();
  if (path == null) { return NoteFaviconLoadStatus.Idle; }
  return statuses.get(noteFaviconKey(path, origin)) ?? NoteFaviconLoadStatus.Idle;
}


export function setNoteFaviconStatus(path: string, origin: string | null, status: NoteFaviconLoadStatus): void {
  const key = noteFaviconKey(path, origin);
  if (statuses.get(key) == status) { return; }
  statuses.set(key, status);
  setStatusVersion(v => v + 1);
}


export function clearNoteFaviconStatus(path: string | null, origin: string | null): void {
  if (path == null) { return; }
  if (!statuses.delete(noteFaviconKey(path, origin))) { return; }
  setStatusVersion(v => v + 1);
}
