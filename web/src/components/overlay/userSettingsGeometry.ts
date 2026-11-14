/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

import type { StoreContextModel } from "../../store/StoreProvider";
import { boundingBoxFromPosSize } from "../../util/geometry";

// Pointer handling and the toolbar need these bounds before the settings component is downloaded.
export const editUserSettingsSizePx = { w: 510, h: 662 };

export function initialEditUserSettingsBounds(store: StoreContextModel) {
  return boundingBoxFromPosSize({
    x: (store.desktopBoundsPx().w - editUserSettingsSizePx.w) / 2.0,
    y: 120.0,
  }, { ...editUserSettingsSizePx });
}
