/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import type { StoreContextModel } from "../../store/StoreProvider";
import { boundingBoxFromPosSize } from "../../util/geometry";

// Pointer handling and the toolbar need these bounds before the settings component is downloaded.
// The content scrolls, so the height is for the usual content (the local tab, with a form open), not the longest.
export const editUserSettingsSizePx = { w: 490, h: 520 };

export function initialEditUserSettingsBounds(store: StoreContextModel) {
  return boundingBoxFromPosSize({
    x: (store.desktopBoundsPx().w - editUserSettingsSizePx.w) / 2.0,
    y: 130.0,
  }, { ...editUserSettingsSizePx });
}
