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

import { asContainerItem, isContainer } from "../../items/base/container-item";
import { Uid } from "../../util/uid";
import { VisualElementFlags, VisualElementPath, VisualElementSpec } from "../visual-element";
import { SceneOutputs } from "./state";

export function maybeTrackLoadedContainer(outputs: SceneOutputs, spec: VisualElementSpec) {
  if (isContainer(spec.displayItem) &&
    ((spec.flags ?? VisualElementFlags.None) & VisualElementFlags.ShowChildren) &&
    asContainerItem(spec.displayItem).childrenLoaded) {
    addSceneWatchContainerUid(outputs, spec.displayItem.id, spec.displayItem.origin);
  }
}

export function addSceneWatchContainerUid(outputs: SceneOutputs, uid: Uid, origin: string | null) {
  if (!outputs.watchContainerUidsByOrigin.has(origin)) {
    outputs.watchContainerUidsByOrigin.set(origin, new Set<Uid>());
  }
  outputs.watchContainerUidsByOrigin.get(origin)!.add(uid);
}

export function pushTopTitledPage(outputs: SceneOutputs, vePath: VisualElementPath) {
  outputs.topTitledPages.push(vePath);
}

export function removeSceneWatchContainerUid(outputs: SceneOutputs, uid: Uid, origin: string | null) {
  const uidSet = outputs.watchContainerUidsByOrigin.get(origin);
  if (!uidSet) {
    return;
  }
  uidSet.delete(uid);
  if (uidSet.size === 0) {
    outputs.watchContainerUidsByOrigin.delete(origin);
  }
}
