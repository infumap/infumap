/* Copyright (C) The Infumap Authors. SPDX-License-Identifier: AGPL-3.0-or-later */

// A single dynamic import keeps these optional features together without assigning their shared
// application dependencies to a manual chunk, which could pull the group back into startup loading.
export { default as QRCode } from "qrcode";
export { EditUserSettings } from "./overlay/UserSettings";
export { Toolbar_PageSizePopup } from "./toolbar/Toolbar_PageSizePopup";
export { Toolbar_PageGridLayoutPopup } from "./toolbar/Toolbar_PageGridLayoutPopup";
export { Toolbar_PageCatalogLayoutPopup } from "./toolbar/Toolbar_PageCatalogLayoutPopup";
export { Toolbar_PageShapePopup } from "./toolbar/Toolbar_PageShapePopup";
export { Toolbar_PageTableLayoutPopup } from "./toolbar/Toolbar_PageTableLayoutPopup";
export { Toolbar_PageDocumentLayoutPopup } from "./toolbar/Toolbar_PageDocumentLayoutPopup";
