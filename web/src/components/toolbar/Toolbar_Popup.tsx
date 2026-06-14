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

import { Component, For, Match, Show, Switch, createSignal, onMount } from "solid-js";
import { StoreContextModel, useStore } from "../../store/StoreProvider";
import { ArrangeAlgorithm, asPageItem, isPage, PageItem } from "../../items/page-item";
import { asRatingItem } from "../../items/rating-item";
import { BoundingBox } from "../../util/geometry";
import { GRID_SIZE, Z_INDEX_GLOBAL_TOOLBAR_OVERLAY } from "../../constants";
import { arrangeNow, requestArrange } from "../../layout/arrange";
import { ToolbarPopupType, TransientMessageType } from "../../store/StoreProvider_Overlay";
import { itemState } from "../../store/ItemState";
import { ItemIconMode } from "../../items/base/icon-item";
import { NoteFns, NoteTextStyle, asNoteItem, isNote } from "../../items/note-item";
import { NoteFaviconLoadStatus, clearNoteFaviconStatus, noteFaviconStatus } from "../../items/note-favicon-state";
import { InfuColorButton } from "../library/InfuColorButton";
import { asCompositeItem, isComposite } from "../../items/composite-item";
import { serverOrRemote } from "../../server";
import { panic } from "../../util/lang";
import { MOUSE_RIGHT } from "../../input/mouse_down";
import { asTableItem, isTable } from "../../items/table-item";
import QRCode from "qrcode";
import {
  openRemoteItemFragmentsInNewTab,
  openRemoteItemTextInNewTab
} from "../../util/remoteFile";
import { calculateChildrenStats, formatBytes } from "../../util/item-metadata";
import { FileFns, asFileItem, isFile } from "../../items/file-item";
import { TextFns, asTextItem, isText } from "../../items/text-item";
import { PasswordFns, asPasswordItem, isPassword } from "../../items/password-item";
import { isImage } from "../../items/image-item";
import { asDataItem, isDataItem } from "../../items/base/data-item";
import { asContainerItem } from "../../items/base/container-item";
import { getToolbarFocusItem, getToolbarFocusPathMaybe } from "./toolbarFocus";
import { getNoteIndentLevel, getPageCalendarDisplayMode, PageCalendarDisplayMode, setNoteIndentLevel, setPageCalendarDisplayMode } from "../../items/base/flags-item";
import { alignCalendarWindowStartMonthIndex, getCalendarMonthsPerPageForDisplayMode } from "../../util/calendar-layout";
import { VesCache } from "../../layout/ves-cache";
import { isVirtualTextDocumentPage, persistVirtualTextDocumentPageOptions, sourceTextItemForVirtualTextDocumentPage } from "../../items/text-document";


const EMOJI_CATEGORIES = [
  {
    name: "Smileys & People",
    emojis: [
      "😀", "😃", "😄", "😁", "😆", "🙂", "🙃", "😉", "😊",
      "😍", "😘", "😗", "😙", "😚", "😋", "😛", "😜", "🤪",
      "🤔", "🫡", "🤨", "😐", "😑", "😶", "🙄", "😏", "😴",
      "😮", "😲", "😳", "🥺", "😢", "😭", "😤", "😡", "😎",
      "🤩", "🥳", "😇", "🤠", "🤓", "🫠", "🙋", "👍", "👏",
      "🙏", "💪", "👀", "🧠", "👑", "🧑‍💻", "👨‍👩‍👧", "🧘", "🏃",
    ],
  },
  {
    name: "Animals & Nature",
    emojis: [
      "🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🐻", "🐼", "🐨",
      "🐯", "🦁", "🐮", "🐷", "🐸", "🐵", "🐔", "🐧", "🐦",
      "🐤", "🦆", "🦅", "🦉", "🦇", "🐺", "🐴", "🦄", "🐝",
      "🐛", "🦋", "🐌", "🐞", "🐜", "🕷️", "🐢", "🐍", "🦎",
      "🦖", "🐙", "🦑", "🦀", "🐠", "🐬", "🐳", "🦈", "🐘",
      "🌱", "🌿", "🍀", "🌵", "🌲", "🌳", "🌴", "🌸", "🌻",
      "🌞", "🌙", "⭐", "🌈", "☁️", "⛈️", "❄️", "🔥", "💧",
    ],
  },
  {
    name: "Food & Drink",
    emojis: [
      "🍏", "🍎", "🍐", "🍊", "🍋", "🍌", "🍉", "🍇", "🍓",
      "🫐", "🍒", "🍑", "🥭", "🍍", "🥥", "🥝", "🍅", "🥑",
      "🥦", "🥕", "🌽", "🌶️", "🥐", "🥯", "🍞", "🥨", "🧀",
      "🥚", "🍳", "🥞", "🥓", "🍔", "🍟", "🍕", "🌭", "🥪",
      "🌮", "🌯", "🥗", "🍝", "🍜", "🍲", "🍣", "🍱", "🥟",
      "🍦", "🍩", "🍪", "🎂", "🍰", "🍫", "🍿", "☕", "🍵",
      "🥤", "🧃", "🍺", "🍷", "🍸", "🍹", "🥂", "🍽️", "🥄",
    ],
  },
  {
    name: "Travel & Places",
    emojis: [
      "🚗", "🚕", "🚌", "🚎", "🏎️", "🚓", "🚑", "🚒", "🚚",
      "🚲", "🛴", "🏍️", "🚂", "🚆", "🚇", "🚊", "✈️", "🚀",
      "🛸", "🚁", "⛵", "🚢", "⚓", "⛽", "🚧", "🚦", "🗺️",
      "🗽", "🗼", "🏰", "🏯", "🏟️", "🎡", "🎢", "🏠", "🏡",
      "🏢", "🏫", "🏥", "🏦", "🏨", "🏪", "🏛️", "⛪", "🕌",
      "🏖️", "🏝️", "🏜️", "🏔️", "⛰️", "🌋", "🏕️", "🌃", "🌉",
    ],
  },
  {
    name: "Activities",
    emojis: [
      "⚽", "🏀", "🏈", "⚾", "🎾", "🏐", "🏉", "🥏", "🎱",
      "🏓", "🏸", "🥅", "🏒", "🏑", "🏏", "🥍", "⛳", "🪁",
      "🏹", "🎣", "🥊", "🥋", "🎽", "🛹", "🛼", "⛸️", "🎿",
      "⛷️", "🏂", "🏋️", "🤸", "🤾", "🏌️", "🏄", "🚣", "🏊",
      "🎯", "🎮", "🕹️", "🎲", "🧩", "♟️", "🎭", "🎨", "🎬",
      "🎤", "🎧", "🎼", "🎹", "🥁", "🎷", "🎺", "🎸", "🎻",
    ],
  },
  {
    name: "Events & Planning",
    emojis: [
      "🎈", "🎉", "🎊", "🎁", "🎀", "🪅", "🪩", "🎆", "🎇",
      "🧨", "🎃", "🎄", "🎅", "🤶", "🧑‍🎄", "🎋", "🎍", "🎎",
      "🎏", "🎐", "🎑", "🧧", "🎟️", "🎫", "🏆", "🥇", "🥈",
      "🥉", "🏅", "🎖️", "💐", "🌹", "📅", "📆", "🗓️", "⏰",
      "⏱️", "⏲️", "⌚", "🧭", "🗒️", "📓", "📔", "📕", "📗",
      "📘", "📙", "🔖", "📋", "📊", "📈", "📉", "🧾", "📤",
      "📥", "📦", "✉️", "📧", "💼", "🗃️", "🗄️", "🗑️", "🛍️",
    ],
  },
  {
    name: "Objects",
    emojis: [
      "💡", "🔦", "🕯️", "🧯", "🛠️", "🔧", "🔨", "⚙️", "🧰",
      "🧲", "🧪", "🧫", "🧬", "🔬", "🔭", "📡", "💉", "🩺",
      "🚪", "🪑", "🛏️", "🛋️", "🚿", "🧴", "🧷", "🧵", "🪡",
      "🔑", "🔒", "🔓", "🗝️", "💰", "💳", "💎", "⚖️", "🪪",
      "📱", "💻", "⌨️", "🖥️", "🖨️", "📷", "🎥", "📞", "☎️",
      "📚", "📖", "📝", "📌", "📍", "✂️", "📎", "🔗", "🏷️",
      "📁", "🗂️",
    ],
  },
  {
    name: "Symbols",
    emojis: [
      "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "💔",
      "✅", "☑️", "✔️", "❌", "❎", "➕", "➖", "➗", "✖️",
      "❗", "❓", "‼️", "⁉️", "⚠️", "🚫", "🔔", "🔕", "♻️",
      "⭐", "🌟", "✨", "💫", "🔥", "💥", "💯", "🔴", "🟠",
      "🟡", "🟢", "🔵", "🟣", "⚫", "⚪", "⬆️", "⬇️", "➡️",
      "⬅️", "↗️", "↘️", "↙️", "↖️", "🔙", "🔚", "🔜", "🔝",
      "🔁", "🔄", "🔎", "💬", "💭",
    ],
  },
  {
    name: "Flags",
    emojis: [
      "🏁", "🚩", "🎌", "🏴", "🏳️", "🏳️‍🌈", "🇺🇸", "🇬🇧", "🇪🇺",
      "🇮🇹", "🇫🇷", "🇩🇪", "🇪🇸", "🇵🇹", "🇳🇱", "🇨🇭", "🇸🇪", "🇳🇴",
      "🇩🇰", "🇫🇮", "🇮🇪", "🇬🇷", "🇹🇷", "🇹🇭", "🇯🇵", "🇰🇷", "🇨🇳",
      "🇮🇳", "🇦🇺", "🇳🇿", "🇨🇦", "🇲🇽", "🇧🇷", "🇦🇷", "🇿🇦", "🇺🇦",
    ],
  },
];
const DEFAULT_NOTE_ICON_TEXT = "\uf249";
const DEFAULT_FILE_ICON_TEXT = "\uf15b";
const DEFAULT_TEXT_ICON_TEXT = "\uf031";
const DEFAULT_PASSWORD_ICON_TEXT = "\uf070";

type NoteTextStyleOption = {
  textStyle: NoteTextStyle,
  label: string,
  icon: string,
  hideInTable?: boolean,
  selectedTextStyle?: NoteTextStyle | null,
};

const NOTE_TEXT_STYLE_OPTIONS: Array<NoteTextStyleOption> = [
  { textStyle: NoteTextStyle.Normal, label: "Text", icon: "fa fa-font", selectedTextStyle: NoteTextStyle.Normal },
  { textStyle: NoteTextStyle.Heading1, label: "H1", icon: "bi-type-h1", hideInTable: true, selectedTextStyle: NoteTextStyle.Heading1 },
  { textStyle: NoteTextStyle.Heading2, label: "H2", icon: "bi-type-h2", hideInTable: true, selectedTextStyle: NoteTextStyle.Heading2 },
  { textStyle: NoteTextStyle.Heading3, label: "H3", icon: "bi-type-h3", selectedTextStyle: NoteTextStyle.Heading3 },
  { textStyle: NoteTextStyle.Heading4, label: "H4", icon: "bi-type-h4", selectedTextStyle: NoteTextStyle.Heading4 },
  { textStyle: NoteTextStyle.Bullet, label: "Bullet", icon: "fa fa-list", hideInTable: true, selectedTextStyle: NoteTextStyle.Bullet },
  { textStyle: NoteTextStyle.Numbered, label: "Numbered", icon: "fa fa-list-ol", hideInTable: true, selectedTextStyle: NoteTextStyle.Numbered },
  { textStyle: NoteTextStyle.Code, label: "Code", icon: "fa fa-code", selectedTextStyle: NoteTextStyle.Code },
];

function noteIsInTable(note: ReturnType<typeof asNoteItem>): boolean {
  let parentId = note.parentId;
  while (parentId) {
    const parentItem = itemState.get(parentId);
    if (!parentItem) { return false; }
    if (isTable(parentItem)) { return true; }
    if (parentItem.parentId == null || parentItem.parentId === parentId) { return false; }
    parentId = parentItem.parentId;
  }
  return false;
}

function visibleNoteTextStyleOptions(store: StoreContextModel): Array<NoteTextStyleOption> {
  const focusItem = getToolbarFocusItem(store);
  const inTable = isNote(focusItem) && noteIsInTable(asNoteItem(focusItem));
  return NOTE_TEXT_STYLE_OPTIONS.filter(option => !option.hideInTable || !inTable);
}


function toolbarPopupHeight(overlayType: ToolbarPopupType, isComposite: boolean): number {
  if (overlayType == ToolbarPopupType.NoteUrl) { return 38; }
  if (overlayType == ToolbarPopupType.NoteIndent) { return 36; }
  if (overlayType == ToolbarPopupType.ItemIcon) { return 292; }
  if (overlayType == ToolbarPopupType.PageWidth) { return 74; }
  if (overlayType == ToolbarPopupType.PageAspect) { return 92; }
  if (overlayType == ToolbarPopupType.PageNumCols) { return 36; }
  if (overlayType == ToolbarPopupType.TableNumCols) { return 36; }
  if (overlayType == ToolbarPopupType.PageDocWidth) { return 74; }
  if (overlayType == ToolbarPopupType.PageCellAspect) { return 60; }
  if (overlayType == ToolbarPopupType.PageJustifiedRowAspect) { return 60; }
  if (overlayType == ToolbarPopupType.PageCalendarDisplayMode) { return 138; }
  if (overlayType == ToolbarPopupType.QrLink) {
    if (isComposite) {
      return 500;
    }
    return 450;
  }
  return 30;
}

export function toolbarPopupBoxBoundsPx(store: StoreContextModel): BoundingBox {
  const popupType = store.overlay.toolbarPopupInfoMaybe.get()!.type;
  const compositeItemMaybe = () => {
    const focusItem = getToolbarFocusItem(store);
    if (!isComposite(focusItem)) { return null; }
    return asCompositeItem(focusItem);
  };
  const showSeparateCompositeSection = () =>
    compositeItemMaybe() != null && compositeItemMaybe()!.id != getToolbarFocusItem(store).id;

  if (popupType != ToolbarPopupType.PageColor &&
    popupType != ToolbarPopupType.NoteTextStyle &&
    popupType != ToolbarPopupType.PageArrangeAlgorithm &&
    popupType != ToolbarPopupType.PageCalendarDisplayMode &&
    popupType != ToolbarPopupType.RatingType) {
    const popupWidth = popupType == ToolbarPopupType.TableNumCols || popupType == ToolbarPopupType.NoteIndent ? 300 : popupType == ToolbarPopupType.ItemIcon ? 334 : 330;
    const maxX = store.desktopBoundsPx().w - popupWidth - 20;
    let x = store.overlay.toolbarPopupInfoMaybe.get()!.topLeftPx.x;
    if (x > maxX) { x = maxX; }
    return {
      x,
      y: store.overlay.toolbarPopupInfoMaybe.get()!.topLeftPx.y,
      w: popupWidth,
      h: toolbarPopupHeight(popupType, showSeparateCompositeSection())
    }
  } else if (popupType == ToolbarPopupType.PageColor) {
    return {
      x: store.overlay.toolbarPopupInfoMaybe.get()!.topLeftPx.x,
      y: store.overlay.toolbarPopupInfoMaybe.get()!.topLeftPx.y,
      w: 96, h: 56
    }
  } else if (popupType == ToolbarPopupType.NoteTextStyle) {
    return {
      x: store.overlay.toolbarPopupInfoMaybe.get()!.topLeftPx.x,
      y: store.overlay.toolbarPopupInfoMaybe.get()!.topLeftPx.y,
      w: 136,
      h: visibleNoteTextStyleOptions(store).length * 25 + 15
    }
  } else if (popupType == ToolbarPopupType.PageArrangeAlgorithm) {
    return {
      x: store.overlay.toolbarPopupInfoMaybe.get()!.topLeftPx.x,
      y: store.overlay.toolbarPopupInfoMaybe.get()!.topLeftPx.y,
      w: 96,
      h: 190
    }
  } else if (popupType == ToolbarPopupType.PageCalendarDisplayMode) {
    return {
      x: store.overlay.toolbarPopupInfoMaybe.get()!.topLeftPx.x,
      y: store.overlay.toolbarPopupInfoMaybe.get()!.topLeftPx.y,
      w: 112,
      h: toolbarPopupHeight(popupType, showSeparateCompositeSection())
    }
  } else if (popupType == ToolbarPopupType.RatingType) {
    return {
      x: store.overlay.toolbarPopupInfoMaybe.get()!.topLeftPx.x,
      y: store.overlay.toolbarPopupInfoMaybe.get()!.topLeftPx.y,
      w: 140,
      h: 128
    }
  } else {
    panic("unexpected popup type: " + popupType);
  }
}


export const Toolbar_Popup: Component = () => {
  const store = useStore();

  let textElement: HTMLInputElement | undefined;
  let emojiInputElement: HTMLInputElement | undefined;

  const pageItem = () => asPageItem(getToolbarFocusItem(store));
  const noteItem = () => asNoteItem(getToolbarFocusItem(store));
  const fileItem = () => asFileItem(getToolbarFocusItem(store));
  const textItem = () => asTextItem(getToolbarFocusItem(store));
  const passwordItem = () => asPasswordItem(getToolbarFocusItem(store));
  const tableItem = () => asTableItem(getToolbarFocusItem(store));
  const ratingItem = () => asRatingItem(getToolbarFocusItem(store));
  const compositeItemMaybe = () => {
    const focusItem = getToolbarFocusItem(store);
    if (!isComposite(focusItem)) { return null; }
    return asCompositeItem(focusItem);
  };
  const showSeparateCompositeSection = () =>
    compositeItemMaybe() != null && compositeItemMaybe()!.id != getToolbarFocusItem(store).id;

  const overlayTypeConst = store.overlay.toolbarPopupInfoMaybe.get()!.type;
  const overlayType = () => store.overlay.toolbarPopupInfoMaybe.get()!.type;
  const [sliderValue, setSliderValue] = createSignal(
    isTable(getToolbarFocusItem(store))
      ? asTableItem(getToolbarFocusItem(store)).numberOfVisibleColumns.toString()
      : isPage(getToolbarFocusItem(store))
        ? asPageItem(getToolbarFocusItem(store)).gridNumberOfColumns.toString()
        : isNote(getToolbarFocusItem(store))
          ? (getNoteIndentLevel(asNoteItem(getToolbarFocusItem(store))) + 1).toString()
          : "1"
  );
  const [itemIconVisible, setItemIconVisible] = createSignal(
    overlayTypeConst == ToolbarPopupType.ItemIcon && isNote(getToolbarFocusItem(store))
      ? noteItem().iconMode == ItemIconMode.Symbol || noteItem().iconMode == ItemIconMode.Favicon
      : overlayTypeConst == ToolbarPopupType.ItemIcon && isFile(getToolbarFocusItem(store))
        ? fileItem().iconMode == ItemIconMode.Symbol
        : overlayTypeConst == ToolbarPopupType.ItemIcon && isText(getToolbarFocusItem(store))
          ? textItem().iconMode == ItemIconMode.Symbol
          : overlayTypeConst == ToolbarPopupType.ItemIcon && isPassword(getToolbarFocusItem(store))
            ? passwordItem().iconMode == ItemIconMode.Symbol
            : false
  );
  const [selectedEmojiValue, setSelectedEmojiValue] = createSignal<string | null>(
    overlayTypeConst == ToolbarPopupType.ItemIcon && isNote(getToolbarFocusItem(store))
      ? NoteFns.emoji(noteItem())
      : overlayTypeConst == ToolbarPopupType.ItemIcon && isFile(getToolbarFocusItem(store))
        ? FileFns.emoji(fileItem())
        : overlayTypeConst == ToolbarPopupType.ItemIcon && isText(getToolbarFocusItem(store))
          ? TextFns.emoji(textItem())
          : overlayTypeConst == ToolbarPopupType.ItemIcon && isPassword(getToolbarFocusItem(store))
            ? PasswordFns.emoji(passwordItem())
            : null
  );
  const [customEmojiInputFocused, setCustomEmojiInputFocused] = createSignal(false);

  const noteUrlSelection = () => {
    const selection = store.overlay.noteTextSelectionInfo.get();
    if (selection == null || selection.itemPath != getToolbarFocusPathMaybe(store)) { return null; }
    return selection;
  };

  const handleKeyDown = (ev: KeyboardEvent) => {
    if (ev.code == "Enter") {
      handleTextChange();
      store.touchToolbar();
      if (isNote(getToolbarFocusItem(store))) {
        serverOrRemote.updateItem(getToolbarFocusItem(store), store.general.networkStatus);
        setTimeout(() => {
          store.overlay.toolbarPopupInfoMaybe.set(null);
          document.getElementById("noteEditOverlayTextArea")!.focus();
        }, 0);
      }
    }
    ev.stopPropagation();
  }
  const handleKeyUp = (ev: KeyboardEvent) => { ev.stopPropagation(); }
  const handleKeyPress = (ev: KeyboardEvent) => { ev.stopPropagation(); }

  const handleTextChange = () => {
    if (overlayTypeConst == ToolbarPopupType.PageWidth) {
      pageItem().innerSpatialWidthGr = Math.round(parseFloat(textElement!.value)) * GRID_SIZE;
    } else if (overlayTypeConst == ToolbarPopupType.PageAspect) {
      pageItem().naturalAspect = parseFloat(textElement!.value);
    } else if (overlayTypeConst == ToolbarPopupType.PageCellAspect) {
      pageItem().gridCellAspect = parseFloat(textElement!.value);
    } else if (overlayTypeConst == ToolbarPopupType.PageJustifiedRowAspect) {
      pageItem().justifiedRowAspect = parseFloat(textElement!.value);
    } else if (overlayTypeConst == ToolbarPopupType.NoteUrl) {
      NoteFns.setUrlForToolbarEdit(noteItem(), noteUrlSelection(), textElement!.value);
    } else if (overlayTypeConst == ToolbarPopupType.PageDocWidth) {
      const docWidthBl = Math.round(parseFloat(textElement!.value));
      if (!Number.isFinite(docWidthBl)) { return; }
      pageItem().docWidthBl = Math.max(1, docWidthBl);
      if (isVirtualTextDocumentPage(pageItem().id)) {
        persistVirtualTextDocumentPageOptions(store, pageItem());
      }
    } else if (overlayTypeConst == ToolbarPopupType.TableNumCols) {
      panic("unexpected overlay type in handleTextChange: " + overlayTypeConst);
    }
    requestArrange(store, "toolbar-popup-text-change");
  };

  const inputWidthPx = (): number => {
    if (overlayType() == ToolbarPopupType.NoteUrl) { return 292; }
    if (overlayType() == ToolbarPopupType.PageWidth) { return 196; }
    if (overlayType() == ToolbarPopupType.PageAspect) { return 180; }
    if (overlayType() == ToolbarPopupType.PageCellAspect) { return 238; }
    if (overlayType() == ToolbarPopupType.PageNumCols) { return 260; }
    if (overlayType() == ToolbarPopupType.PageJustifiedRowAspect) { return 230; }
    if (overlayType() == ToolbarPopupType.PageDocWidth) { return 162; }
    if (overlayType() == ToolbarPopupType.TableNumCols) { return 190; }
    if (overlayType() == ToolbarPopupType.NoteIndent) { return 190; }
    return 200;
  }

  const boxBoundsPx = () => toolbarPopupBoxBoundsPx(store);

  onMount(() => {
    if (overlayType() == ToolbarPopupType.TableNumCols) {
      setSliderValue(asTableItem(getToolbarFocusItem(store)).numberOfVisibleColumns.toString());
    } else if (overlayType() == ToolbarPopupType.NoteIndent) {
      setSliderValue((getNoteIndentLevel(asNoteItem(getToolbarFocusItem(store))) + 1).toString());
    }

    if (overlayType() != ToolbarPopupType.PageColor &&
      overlayType() != ToolbarPopupType.ItemIcon &&
      overlayType() != ToolbarPopupType.QrLink &&
      overlayType() != ToolbarPopupType.NoteTextStyle &&
      overlayType() != ToolbarPopupType.PageArrangeAlgorithm &&
      overlayType() != ToolbarPopupType.PageCalendarDisplayMode &&
      overlayType() != ToolbarPopupType.TableNumCols &&
      overlayType() != ToolbarPopupType.NoteIndent &&
      overlayType() != ToolbarPopupType.PageNumCols &&
      overlayType() != ToolbarPopupType.RatingType) {
      textElement!.focus();
    }
  });

  const handleColorClick = (col: number) => {
    if (!isPage(getToolbarFocusItem(store))) {
      panic(`unexpected item type ${getToolbarFocusItem(store).itemType} changing color.`);
    }
    pageItem().backgroundColorIndex = col;
    store.overlay.toolbarPopupInfoMaybe.set(store.overlay.toolbarPopupInfoMaybe.get());
    serverOrRemote.updateItem(getToolbarFocusItem(store), store.general.networkStatus);
    store.overlay.toolbarPopupInfoMaybe.set(null);
    store.touchToolbar();
    requestArrange(store, "toolbar-popup-page-color");
  }

  const textEntryValue = (): string | null => {
    if (overlayType() == ToolbarPopupType.NoteUrl) { return NoteFns.urlForToolbarEdit(noteItem(), noteUrlSelection()); }
    if (overlayType() == ToolbarPopupType.PageWidth) { return "" + pageItem().innerSpatialWidthGr / GRID_SIZE; }
    if (overlayType() == ToolbarPopupType.PageAspect) { return "" + pageItem().naturalAspect; }
    if (overlayType() == ToolbarPopupType.PageNumCols) { return "" + pageItem().gridNumberOfColumns; }
    if (overlayType() == ToolbarPopupType.PageDocWidth) { return "" + pageItem().docWidthBl; }
    if (overlayType() == ToolbarPopupType.PageCellAspect) { return "" + pageItem().gridCellAspect; }
    if (overlayType() == ToolbarPopupType.PageJustifiedRowAspect) { return "" + pageItem().justifiedRowAspect; }
    if (overlayType() == ToolbarPopupType.QrLink) { return null; }
    return "[unknown]";
  }

  const label = (): string | null => {
    if (overlayType() == ToolbarPopupType.NoteUrl) { return "Url"; }
    if (overlayType() == ToolbarPopupType.PageWidth) { return "Inner Block Width"; }
    if (overlayType() == ToolbarPopupType.PageAspect) { return "Page Aspect"; }
    if (overlayType() == ToolbarPopupType.PageNumCols) { return "Num Cols"; }
    if (overlayType() == ToolbarPopupType.TableNumCols) { return "Num Visible Cols"; }
    if (overlayType() == ToolbarPopupType.NoteIndent) { return "Indent"; }
    if (overlayType() == ToolbarPopupType.PageDocWidth) { return "Document Block Width"; }
    if (overlayType() == ToolbarPopupType.PageCellAspect) { return "Cell Aspect"; }
    if (overlayType() == ToolbarPopupType.PageJustifiedRowAspect) { return "Row Aspect"; }
    if (overlayType() == ToolbarPopupType.QrLink) { return null; }
    return "[unknown]";
  }

  const tooltip = (): string | null => {
    if (overlayType() == ToolbarPopupType.PageWidth) { return "The width of the page in 'blocks'. One block is equal to the height of one line of normal sized text."; }
    if (overlayType() == ToolbarPopupType.PageAspect) { return "The natural aspect ratio (width / height) of the page. The actual displayed aspect ratio may be stretched or quantized as required."; }
    if (overlayType() == ToolbarPopupType.PageCellAspect) { return "The aspect ratio (width / height) of a grid cell."; }
    if (overlayType() == ToolbarPopupType.PageJustifiedRowAspect) { return "The aspect ratio (width / height) of one row of items."; }
    if (overlayType() == ToolbarPopupType.PageDocWidth) { return "The width of the document area in 'blocks'. One block is equal to the height of one line of normal sized text."; }
    return null;
  }

  const showAutoButton = (): boolean => overlayType() == ToolbarPopupType.PageAspect;

  const selectedEmoji = () => selectedEmojiValue();
  const itemIconChoiceClass = (selected: boolean): string =>
    `inline-flex items-center justify-center w-[32px] h-[32px] border rounded-md text-[18px] leading-none cursor-pointer focus:outline-none ` +
    `disabled:cursor-not-allowed disabled:opacity-40 disabled:bg-slate-50 disabled:text-slate-400 disabled:hover:bg-slate-50 disabled:hover:border-slate-200 ` +
    (selected ? `bg-blue-50 border-blue-500 shadow-inner` : `bg-white border-slate-200 hover:bg-slate-100 hover:border-slate-300`);
  const emojiChoiceClass = (selected: boolean): string =>
    `inline-flex items-center justify-center w-[32px] h-[32px] rounded-md text-[18px] leading-none cursor-pointer focus:outline-none ` +
    (selected ? `bg-blue-50 ring-1 ring-blue-500 shadow-inner` : `bg-transparent hover:bg-slate-100`);
  const emojiFontStyle = () =>
    `font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif;`;
  const defaultItemIconText = (): string =>
    isFile(getToolbarFocusItem(store)) ? DEFAULT_FILE_ICON_TEXT :
      isText(getToolbarFocusItem(store)) ? DEFAULT_TEXT_ICON_TEXT :
        isPassword(getToolbarFocusItem(store)) ? DEFAULT_PASSWORD_ICON_TEXT :
          DEFAULT_NOTE_ICON_TEXT;
  const defaultItemIconClass = (): string =>
    isFile(getToolbarFocusItem(store)) ? "fas fa-file" :
      isText(getToolbarFocusItem(store)) ? "fas fa-font" :
        isPassword(getToolbarFocusItem(store)) ? "fas fa-eye-slash" :
          "fas fa-sticky-note";
  const itemIconLabel = (): string =>
    isFile(getToolbarFocusItem(store)) ? "file" :
      isText(getToolbarFocusItem(store)) ? "text" :
        isPassword(getToolbarFocusItem(store)) ? "password" :
          "note";
  const iconMode = (): ItemIconMode | null =>
    isNote(getToolbarFocusItem(store)) ? noteItem().iconMode :
      isFile(getToolbarFocusItem(store)) ? fileItem().iconMode :
        isText(getToolbarFocusItem(store)) ? textItem().iconMode :
          isPassword(getToolbarFocusItem(store)) ? passwordItem().iconMode :
            null;
  const itemIconIsAuto = (): boolean => iconMode() == ItemIconMode.Auto;
  const itemIconIsNone = (): boolean => iconMode() == ItemIconMode.None;
  const itemIconIsSymbol = (): boolean => iconMode() == ItemIconMode.Symbol;
  const noteIconIsFavicon = (): boolean => isNote(getToolbarFocusItem(store)) && noteItem().iconMode == ItemIconMode.Favicon;
  const noteHasFaviconUrl = (): boolean => isNote(getToolbarFocusItem(store)) && NoteFns.hasFaviconUrl(noteItem());
  const noteFaviconPath = (): string | null => isNote(getToolbarFocusItem(store)) ? NoteFns.faviconPath(noteItem()) : null;
  const noteFaviconLoadStatus = (): NoteFaviconLoadStatus => isNote(getToolbarFocusItem(store))
    ? noteFaviconStatus(noteFaviconPath(), noteItem().origin)
    : NoteFaviconLoadStatus.Idle;
  const noteFaviconButtonTitle = (): string => {
    if (!noteHasFaviconUrl()) { return "Add a URL to use site icon"; }
    if (!noteIconIsFavicon()) { return "Use site icon"; }
    if (noteFaviconLoadStatus() == NoteFaviconLoadStatus.Loading) { return "Loading site icon"; }
    if (noteFaviconLoadStatus() == NoteFaviconLoadStatus.Loaded) { return "Using site icon"; }
    if (noteFaviconLoadStatus() == NoteFaviconLoadStatus.Failed) { return "Site icon unavailable. Click to retry"; }
    return "Use site icon";
  };
  const noteFaviconButtonClass = (): string => {
    const statusClass = noteIconIsFavicon() && noteFaviconLoadStatus() == NoteFaviconLoadStatus.Failed
      ? " text-amber-600 hover:text-amber-700"
      : "";
    return itemIconChoiceClass(noteIconIsFavicon()) + statusClass;
  };
  const noteFaviconButtonIconClass = (): string => {
    if (!noteIconIsFavicon()) { return "fas fa-globe"; }
    if (noteFaviconLoadStatus() == NoteFaviconLoadStatus.Loading) { return "fa fa-spinner fa-spin"; }
    if (noteFaviconLoadStatus() == NoteFaviconLoadStatus.Failed) { return "fas fa-exclamation-triangle"; }
    return "fas fa-globe";
  };
  const regularIconSelected = (): boolean =>
    itemIconIsSymbol() && selectedEmoji() == null;
  const emojiInputIsDefaultItemIcon = (): boolean => regularIconSelected() && !customEmojiInputFocused();
  const emojiInputFontStyle = (): string => emojiInputIsDefaultItemIcon()
    ? `font-family: "Font Awesome 5 Free"; font-weight: 900;`
    : emojiFontStyle();
  const emojiInputValue = (): string => {
    if (customEmojiInputFocused()) { return ""; }
    return itemIconIsSymbol() ? selectedEmoji() || defaultItemIconText() : "";
  };
  const emojiInputFontSize = (): number => emojiInputValue() == "" ? 10 : 18;
  const handleCustomEmojiFocus = (): void => {
    setCustomEmojiInputFocused(true);
    if (emojiInputElement != null && itemIconVisible() && selectedEmoji() == null) {
      emojiInputElement.value = "";
    }
  };
  const firstGrapheme = (value: string): string => {
    const trimmed = value.trim();
    if (trimmed == "") { return ""; }
    if ("Segmenter" in Intl) {
      const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
      const first = segmenter.segment(trimmed)[Symbol.iterator]().next();
      if (!first.done) { return first.value.segment; }
    }
    return Array.from(trimmed)[0] || "";
  };
  const normalizeCustomEmojiInput = (): string => {
    const emoji = firstGrapheme(emojiInputElement?.value || "");
    if (emojiInputElement != null && emojiInputElement.value != emoji) {
      emojiInputElement.value = emoji;
    }
    return emoji;
  };
  const chooseItemIcon = (emoji: string | null, useSymbol: boolean = true, closePopup: boolean = true): void => {
    setItemIconVisible(useSymbol);
    setSelectedEmojiValue(useSymbol ? emoji : null);
    if (emojiInputElement != null) {
      emojiInputElement.value = useSymbol ? emoji || "" : "";
    }
    const focusItem = getToolbarFocusItem(store);
    if (useSymbol) {
      if (isNote(focusItem)) {
        noteItem().emoji = emoji;
        noteItem().iconMode = ItemIconMode.Symbol;
      } else if (isFile(focusItem)) {
        fileItem().emoji = emoji;
        fileItem().iconMode = ItemIconMode.Symbol;
      } else if (isText(focusItem)) {
        textItem().emoji = emoji;
        textItem().iconMode = ItemIconMode.Symbol;
      } else if (isPassword(focusItem)) {
        passwordItem().emoji = emoji;
        passwordItem().iconMode = ItemIconMode.Symbol;
      }
    } else {
      if (isNote(focusItem)) {
        noteItem().emoji = null;
        noteItem().iconMode = ItemIconMode.None;
      } else if (isFile(focusItem)) {
        fileItem().emoji = null;
        fileItem().iconMode = ItemIconMode.None;
      } else if (isText(focusItem)) {
        textItem().emoji = null;
        textItem().iconMode = ItemIconMode.None;
      } else if (isPassword(focusItem)) {
        passwordItem().emoji = null;
        passwordItem().iconMode = ItemIconMode.None;
      }
    }
    serverOrRemote.updateItem(focusItem, store.general.networkStatus);
    if (closePopup) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
    } else if (emojiInputElement != null) {
      emojiInputElement.value = emojiInputValue();
    }
    store.touchToolbar();
    requestArrange(store, "toolbar-popup-item-icon");
  };
  const chooseAutoIcon = (closePopup: boolean = true): void => {
    const focusItem = getToolbarFocusItem(store);
    if (!isNote(focusItem) && !isFile(focusItem) && !isText(focusItem) && !isPassword(focusItem)) { return; }
    setItemIconVisible(false);
    setSelectedEmojiValue(null);
    if (emojiInputElement != null) {
      emojiInputElement.value = "";
    }
    if (isNote(focusItem)) {
      noteItem().emoji = null;
      noteItem().iconMode = ItemIconMode.Auto;
    } else if (isFile(focusItem)) {
      fileItem().emoji = null;
      fileItem().iconMode = ItemIconMode.Auto;
    } else if (isText(focusItem)) {
      textItem().emoji = null;
      textItem().iconMode = ItemIconMode.Auto;
    } else if (isPassword(focusItem)) {
      passwordItem().emoji = null;
      passwordItem().iconMode = ItemIconMode.Auto;
    }
    serverOrRemote.updateItem(focusItem, store.general.networkStatus);
    if (closePopup) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
    } else if (emojiInputElement != null) {
      emojiInputElement.value = emojiInputValue();
    }
    store.touchToolbar();
    requestArrange(store, "toolbar-popup-item-icon");
  };
  const chooseFaviconIcon = (closePopup: boolean = true): void => {
    const focusItem = getToolbarFocusItem(store);
    if (!isNote(focusItem) || !noteHasFaviconUrl()) { return; }
    setItemIconVisible(true);
    setSelectedEmojiValue(null);
    if (emojiInputElement != null) {
      emojiInputElement.value = "";
    }
    noteItem().emoji = null;
    noteItem().iconMode = ItemIconMode.Favicon;
    if (noteFaviconLoadStatus() == NoteFaviconLoadStatus.Failed) {
      clearNoteFaviconStatus(NoteFns.faviconPath(noteItem()), noteItem().origin);
    }
    serverOrRemote.updateItem(focusItem, store.general.networkStatus);
    if (closePopup) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
    }
    store.touchToolbar();
    requestArrange(store, "toolbar-popup-item-icon");
  };
  const applyCustomEmoji = (): void => {
    const emoji = normalizeCustomEmojiInput();
    if (emoji && emoji != "" && emoji != selectedEmoji()) {
      chooseItemIcon(emoji, true, false);
    } else if (emojiInputElement != null) {
      emojiInputElement.value = emojiInputValue();
    }
  };
  const handleCustomEmojiInput = (): void => {
    normalizeCustomEmojiInput();
  };
  const handleCustomEmojiBlur = (): void => {
    applyCustomEmoji();
    setCustomEmojiInputFocused(false);
    if (emojiInputElement != null) {
      emojiInputElement.value = emojiInputValue();
    }
  };
  const handleCustomEmojiKeyDown = (ev: KeyboardEvent): void => {
    if (ev.code == "Enter") {
      applyCustomEmoji();
      emojiInputElement?.blur();
    }
    ev.stopPropagation();
  };
  const handleCustomEmojiKeyUp = (ev: KeyboardEvent): void => { ev.stopPropagation(); };
  const handleCustomEmojiKeyPress = (ev: KeyboardEvent): void => { ev.stopPropagation(); };

  const copyItemIdClickHandler = (): void => { navigator.clipboard.writeText(qrInfoItem().id); }
  const linkItemIdClickHandler = (): void => {
    const item = qrInfoItem();
    navigator.clipboard.writeText(window.location.origin + "/" + item.id);
    store.overlay.toolbarPopupInfoMaybe.set(null);
    store.overlay.toolbarTransientMessage.set({ text: item.itemType + " id → clipboard", type: TransientMessageType.Info });
    setTimeout(() => { store.overlay.toolbarTransientMessage.set(null); }, 1000);
  }

  const copyCompositeIdClickHandler = (): void => { navigator.clipboard.writeText(compositeItemMaybe()!.id); }
  const linkCompositeIdClickHandler = (): void => {
    navigator.clipboard.writeText(window.location.origin + "/" + compositeItemMaybe()!.id);
    store.overlay.toolbarPopupInfoMaybe.set(null);
    store.overlay.toolbarTransientMessage.set({ text: "composite id → clipboard", type: TransientMessageType.Info });
    setTimeout(() => { store.overlay.toolbarTransientMessage.set(null); }, 1000);
  }

  const openItemTextClickHandler = (): void => {
    openGeneratedItemClickHandler("text", "text");
  }

  const openItemFragmentsClickHandler = (): void => {
    openGeneratedItemClickHandler("fragments", "fragments");
  }

  const openGeneratedItemClickHandler = (suffix: "text" | "fragments", artifactLabel: string): void => {
    const currentItem = qrInfoItem();
    store.overlay.toolbarPopupInfoMaybe.set(null);
    if (currentItem.origin != null) {
      const openPromise = suffix == "text"
        ? openRemoteItemTextInNewTab(currentItem.origin, currentItem.id)
        : openRemoteItemFragmentsInNewTab(currentItem.origin, currentItem.id);
      void openPromise.catch((e) => {
        console.error(`Could not open ${artifactLabel} for remote item '${currentItem.id}' from '${currentItem.origin}':`, e);
        store.overlay.toolbarTransientMessage.set({ text: `could not open ${artifactLabel}`, type: TransientMessageType.Error });
        setTimeout(() => { store.overlay.toolbarTransientMessage.set(null); }, 1500);
      });
      return;
    }
    window.open(`/files/${currentItem.id}/${suffix}`, "_blank", "noopener");
  }

  const qrInfoItem = () => {
    const currentItem = getToolbarFocusItem(store);
    if (isPage(currentItem) && isVirtualTextDocumentPage(currentItem.id)) {
      return sourceTextItemForVirtualTextDocumentPage(currentItem.id) ?? currentItem;
    }
    return currentItem;
  };

  const isDebugSupportedItem = () => {
    const currentItem = qrInfoItem();
    return isFile(currentItem) || isText(currentItem) || isImage(currentItem) || isPage(currentItem) || isTable(currentItem);
  };

  const showExtractedTextDebugLink = () => {
    const currentItem = qrInfoItem();
    return isFile(currentItem) || isText(currentItem) || isImage(currentItem);
  };

  const showFragmentsDebugLink = () => {
    const currentItem = qrInfoItem();
    return isFile(currentItem) || isText(currentItem) || isImage(currentItem) || isPage(currentItem) || isTable(currentItem);
  };

  const renderDebugLinks = () => {
    return (
      <>
        <Show when={showExtractedTextDebugLink()}>
          <span class="ml-2 text-blue-700 cursor-pointer hover:underline" onClick={openItemTextClickHandler}>extracted text</span>
        </Show>
        <Show when={showExtractedTextDebugLink() && showFragmentsDebugLink()}>
          <span class="ml-2 text-slate-400">|</span>
        </Show>
        <Show when={showFragmentsDebugLink()}>
          <span class="ml-2 text-blue-700 cursor-pointer hover:underline" onClick={openItemFragmentsClickHandler}>fragments</span>
        </Show>
      </>
    );
  };

  const handleAutoClick = (): void => {
    const aspect = "" + Math.round(store.desktopMainAreaBoundsPx().w / store.desktopMainAreaBoundsPx().h * 1000) / 1000;
    textElement!.value = aspect;
    if (!isPage(getToolbarFocusItem(store))) {
      panic(`unexpected item type ${getToolbarFocusItem(store).itemType} changing aspect (auto).`);
    }
    pageItem().naturalAspect = parseFloat(textElement!.value);
    requestArrange(store, "toolbar-popup-page-aspect-auto");
  }

  const finalizeAAChange = (targetPage: PageItem) => {
    itemState.sortChildren(targetPage.id);
    store.overlay.toolbarPopupInfoMaybe.set(null);
    store.touchToolbar();
    arrangeNow(store, "toolbar-popup-arrange-algorithm");
    serverOrRemote.updateItem(targetPage, store.general.networkStatus);
  }

  const focusIsQueriesPage = () => {
    const focusItem = getToolbarFocusItem(store);
    const userMaybe = store.user.getUserMaybe();
    return userMaybe != null && isPage(focusItem) && focusItem.id == userMaybe.queriesPageId;
  }

  const handlePageArrangeAlgorithmChange = (arrangeAlgorithm: ArrangeAlgorithm) => {
    const focusItem = getToolbarFocusItem(store);
    if (!isPage(focusItem)) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      return;
    }
    if (focusIsQueriesPage()) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      return;
    }
    const targetPage = asPageItem(focusItem);
    targetPage.arrangeAlgorithm = arrangeAlgorithm;
    finalizeAAChange(targetPage);
  };

  const handleNoteTextStyleChange = (textStyle: NoteTextStyle) => {
    const focusItem = getToolbarFocusItem(store);
    if (!isNote(focusItem)) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      return;
    }
    NoteFns.setTextStyle(asNoteItem(focusItem), textStyle);
    store.overlay.toolbarPopupInfoMaybe.set(null);
    store.touchToolbar();
    requestArrange(store, "toolbar-popup-note-text-style");
  };
  const noteTextStyle = () => {
    const focusItem = getToolbarFocusItem(store);
    return isNote(focusItem) ? NoteFns.textStyle(asNoteItem(focusItem)) : NoteTextStyle.Normal;
  };
  const noteTextStyleChoiceClass = (option: NoteTextStyleOption): string => {
    const selected = option.selectedTextStyle != null && noteTextStyle() == option.selectedTextStyle;
    return `text-sm hover:bg-slate-300 ml-[3px] mr-[5px] p-[3px] ${selected ? "font-bold text-slate-900" : ""}`;
  };
  const aaSpatialClick = () => { handlePageArrangeAlgorithmChange(ArrangeAlgorithm.SpatialStretch); }
  const aaGridClick = () => { handlePageArrangeAlgorithmChange(ArrangeAlgorithm.Grid); }
  const aaCatalogClick = () => { handlePageArrangeAlgorithmChange(ArrangeAlgorithm.Catalog); }
  const aaJustifiedClick = () => { handlePageArrangeAlgorithmChange(ArrangeAlgorithm.Justified); }
  const aaListClick = () => { handlePageArrangeAlgorithmChange(ArrangeAlgorithm.List); }
  const aaDocumentClick = () => { handlePageArrangeAlgorithmChange(ArrangeAlgorithm.Document); }
  const aaCalendarClick = () => { handlePageArrangeAlgorithmChange(ArrangeAlgorithm.Calendar); }
  const pageArrangeAlgorithm = () => {
    const focusItem = getToolbarFocusItem(store);
    return isPage(focusItem) ? asPageItem(focusItem).arrangeAlgorithm : ArrangeAlgorithm.None;
  };
  const pageArrangeAlgorithmChoiceClass = (arrangeAlgorithm: ArrangeAlgorithm): string =>
    `text-sm hover:bg-slate-300 ml-[3px] mr-[5px] p-[3px] ${pageArrangeAlgorithm() == arrangeAlgorithm ? "font-bold text-slate-900" : ""}`;
  const calendarDisplayMode = () => getPageCalendarDisplayMode(pageItem());
  const handleCalendarDisplayModeChange = (displayMode: PageCalendarDisplayMode) => {
    const focusItem = getToolbarFocusItem(store);
    if (!isPage(focusItem)) {
      store.overlay.toolbarPopupInfoMaybe.set(null);
      return;
    }
    const targetPage = asPageItem(focusItem);
    setPageCalendarDisplayMode(targetPage, displayMode);
    const focusPath = store.history.getFocusPathMaybe();
    if (focusPath) {
      const focusVe = VesCache.render.getNode(focusPath)?.get();
      const pageWidthPx = focusVe?.childAreaBoundsPx?.w ?? store.desktopMainAreaBoundsPx().w;
      const monthsPerPage = getCalendarMonthsPerPageForDisplayMode(pageWidthPx, displayMode, store.smallScreenMode());
      const alignedMonthIndex = alignCalendarWindowStartMonthIndex(
        store.perVe.getCalendarMonthIndex(focusPath),
        monthsPerPage,
      );
      store.perVe.setCalendarMonthIndex(focusPath, alignedMonthIndex);
    }
    store.overlay.toolbarPopupInfoMaybe.set(null);
    store.touchToolbar();
    arrangeNow(store, "toolbar-popup-calendar-display-mode");
    serverOrRemote.updateItem(targetPage, store.general.networkStatus);
  };
  const calendarDisplayModeChoiceClass = (displayMode: PageCalendarDisplayMode): string =>
    `text-sm hover:bg-slate-300 ml-[3px] mr-[5px] p-[3px] ${calendarDisplayMode() == displayMode ? "font-bold text-slate-900" : ""}`;
  const handleRatingTypeChange = (newRatingType: "Star" | "Number" | "HorizontalBar" | "VerticalBar") => {
    ratingItem().ratingType = newRatingType;
    store.touchToolbar();
    requestArrange(store, "toolbar-popup-rating-type");
    serverOrRemote.updateItem(ratingItem(), store.general.networkStatus);
    store.overlay.toolbarPopupInfoMaybe.set(null);
  }

  const handleMouseDown = (e: MouseEvent) => {
    e.stopPropagation();  // Prevent global handler from closing popup
    if (e.button == MOUSE_RIGHT) { store.overlay.toolbarPopupInfoMaybe.set(null); }
  }
  const handleMouseMove = (e: MouseEvent) => { e.stopPropagation(); }

  onMount(() => {
    if (overlayTypeConst != ToolbarPopupType.QrLink) { return; }
    const canvas = document.getElementById('qrcanvas');
    if (canvas == null) { return; }
    const url = window.location.origin + "/" + qrInfoItem().id;
    QRCode.toCanvas(canvas, url, { scale: 7 });
  });

  const handleSliderInput = (e: Event & { currentTarget: HTMLInputElement }) => {
    setSliderValue(e.currentTarget.value);
    let newValue = parseInt(e.currentTarget.value);
    const maxValue = overlayTypeConst == ToolbarPopupType.NoteIndent ? 4 : 20;
    if (newValue > maxValue) { newValue = maxValue; }
    if (newValue < 1) { newValue = 1; }
    if (overlayTypeConst == ToolbarPopupType.TableNumCols) {
      tableItem().numberOfVisibleColumns = newValue;
      while (tableItem().tableColumns.length < newValue) {
        tableItem().tableColumns.push({ name: `col ${tableItem().tableColumns.length}`, widthGr: 120 });
      }
    } else if (overlayTypeConst == ToolbarPopupType.PageNumCols) {
      pageItem().gridNumberOfColumns = newValue;
    } else if (overlayTypeConst == ToolbarPopupType.NoteIndent) {
      setNoteIndentLevel(noteItem(), newValue - 1);
    }
    store.touchToolbar();
    requestArrange(store, "toolbar-popup-slider");
  };

  return (
    <>
      <Switch>
        <Match when={overlayType() == ToolbarPopupType.PageColor}>
          <div class="absolute border rounded bg-white mb-1 shadow-md border-black"
            style={`left: ${boxBoundsPx().x}px; top: ${boxBoundsPx().y}px; width: ${boxBoundsPx().w}px; height: ${boxBoundsPx().h}px; z-index: ${Z_INDEX_GLOBAL_TOOLBAR_OVERLAY}; cursor: default;`}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}>
            <div class="pt-[6px] pl-[4px]">
              <div class="inline-block pl-[2px]"><InfuColorButton col={0} onClick={handleColorClick} /></div>
              <div class="inline-block pl-[2px]"><InfuColorButton col={1} onClick={handleColorClick} /></div>
              <div class="inline-block pl-[2px]"><InfuColorButton col={2} onClick={handleColorClick} /></div>
              <div class="inline-block pl-[2px]"><InfuColorButton col={3} onClick={handleColorClick} /></div>
            </div>
            <div class="pt-0 pl-[4px]">
              <div class="inline-block pl-[2px]"><InfuColorButton col={4} onClick={handleColorClick} /></div>
              <div class="inline-block pl-[2px]"><InfuColorButton col={5} onClick={handleColorClick} /></div>
              <div class="inline-block pl-[2px]"><InfuColorButton col={6} onClick={handleColorClick} /></div>
              <div class="inline-block pl-[2px]"><InfuColorButton col={7} onClick={handleColorClick} /></div>
            </div>
          </div>
        </Match>
        <Match when={overlayType() == ToolbarPopupType.NoteTextStyle}>
          <div class="absolute border rounded bg-slate-50 mb-1 shadow-lg"
            style={`left: ${boxBoundsPx().x}px; top: ${boxBoundsPx().y}px; width: ${boxBoundsPx().w}px; height: ${boxBoundsPx().h}px; z-index: ${Z_INDEX_GLOBAL_TOOLBAR_OVERLAY}; cursor: default;`}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}>
            <For each={visibleNoteTextStyleOptions(store)}>{(option, index) =>
              <div class={noteTextStyleChoiceClass(option) + (index() == 0 ? " mt-[3px]" : "")}
                onClick={() => { handleNoteTextStyleChange(option.textStyle); }}>
                <i class={`${option.icon} inline-block w-[20px] text-center mr-[7px]`} />
                {option.label}
              </div>
            }</For>
          </div>
        </Match>
        <Match when={overlayType() == ToolbarPopupType.PageArrangeAlgorithm}>
          <div class="absolute border rounded bg-slate-50 mb-1 shadow-lg"
            style={`left: ${boxBoundsPx().x}px; top: ${boxBoundsPx().y}px; width: ${boxBoundsPx().w}px; height: ${boxBoundsPx().h}px; z-index: ${Z_INDEX_GLOBAL_TOOLBAR_OVERLAY}; cursor: default;`}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}>
            <div class={pageArrangeAlgorithmChoiceClass(ArrangeAlgorithm.SpatialStretch) + " mt-[3px]"} onClick={aaSpatialClick}>
              Spatial
            </div>
            <div class={pageArrangeAlgorithmChoiceClass(ArrangeAlgorithm.Grid)} onClick={aaGridClick}>
              Grid
            </div>
            <div class={pageArrangeAlgorithmChoiceClass(ArrangeAlgorithm.Catalog)} onClick={aaCatalogClick}>
              Catalog
            </div>
            <div class={pageArrangeAlgorithmChoiceClass(ArrangeAlgorithm.Justified)} onClick={aaJustifiedClick}>
              Justified
            </div>
            <div class={pageArrangeAlgorithmChoiceClass(ArrangeAlgorithm.List)} onClick={aaListClick}>
              List
            </div>
            <div class={pageArrangeAlgorithmChoiceClass(ArrangeAlgorithm.Document)} onClick={aaDocumentClick}>
              Document
            </div>
            <div class={pageArrangeAlgorithmChoiceClass(ArrangeAlgorithm.Calendar)} onClick={aaCalendarClick}>
              Calendar
            </div>
          </div>
        </Match>
        <Match when={overlayType() == ToolbarPopupType.PageCalendarDisplayMode}>
          <div class="absolute border rounded bg-slate-50 mb-1 shadow-lg"
            style={`left: ${boxBoundsPx().x}px; top: ${boxBoundsPx().y}px; width: ${boxBoundsPx().w}px; height: ${boxBoundsPx().h}px; z-index: ${Z_INDEX_GLOBAL_TOOLBAR_OVERLAY}; cursor: default;`}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}>
            <div class={calendarDisplayModeChoiceClass(PageCalendarDisplayMode.Month) + " mt-[3px]"}
              onClick={() => { handleCalendarDisplayModeChange(PageCalendarDisplayMode.Month); }}>
              Month
            </div>
            <div class={calendarDisplayModeChoiceClass(PageCalendarDisplayMode.Quarter)}
              onClick={() => { handleCalendarDisplayModeChange(PageCalendarDisplayMode.Quarter); }}>
              Quarter
            </div>
            <div class={calendarDisplayModeChoiceClass(PageCalendarDisplayMode.HalfYear)}
              onClick={() => { handleCalendarDisplayModeChange(PageCalendarDisplayMode.HalfYear); }}>
              Half-Year
            </div>
            <div class={calendarDisplayModeChoiceClass(PageCalendarDisplayMode.Year)}
              onClick={() => { handleCalendarDisplayModeChange(PageCalendarDisplayMode.Year); }}>
              Year
            </div>
            <div class={calendarDisplayModeChoiceClass(PageCalendarDisplayMode.Auto)}
              onClick={() => { handleCalendarDisplayModeChange(PageCalendarDisplayMode.Auto); }}>
              Auto
            </div>
          </div>
        </Match>
        <Match when={overlayType() == ToolbarPopupType.RatingType}>
          <div class="absolute border rounded bg-slate-50 mb-1 shadow-lg"
            style={`left: ${boxBoundsPx().x}px; top: ${boxBoundsPx().y}px; width: ${boxBoundsPx().w}px; height: ${boxBoundsPx().h}px; z-index: ${Z_INDEX_GLOBAL_TOOLBAR_OVERLAY}; cursor: default;`}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}>
            <div class="text-sm hover:bg-slate-300 ml-[3px] mr-[5px] mt-[3px] p-[3px]" onClick={() => { handleRatingTypeChange("Star"); }}>
              Star
            </div>
            <div class="text-sm hover:bg-slate-300 ml-[3px] mr-[5px] p-[3px]" onClick={() => { handleRatingTypeChange("Number"); }}>
              Number
            </div>
            <div class="text-sm hover:bg-slate-300 ml-[3px] mr-[5px] p-[3px]" onClick={() => { handleRatingTypeChange("HorizontalBar"); }}>
              Horizontal Bar
            </div>
            <div class="text-sm hover:bg-slate-300 ml-[3px] mr-[5px] p-[3px]" onClick={() => { handleRatingTypeChange("VerticalBar"); }}>
              Vertical Bar
            </div>
          </div>
        </Match>
        <Match when={overlayType() == ToolbarPopupType.QrLink}>
          <div class="absolute border rounded bg-white mb-1 shadow-md border-black"
            style={`left: ${boxBoundsPx().x}px; top: ${boxBoundsPx().y}px; width: ${boxBoundsPx().w}px; height: ${boxBoundsPx().h}px; z-index: ${Z_INDEX_GLOBAL_TOOLBAR_OVERLAY}; cursor: default;`}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}>
            <canvas id="qrcanvas" style="margin: auto; width: 200px; height: 200px; margin-top: 12px;" width="200" height="200" />
            <Show when={showSeparateCompositeSection()}>
              <div style="width: 100%; margin-top: -20px; color: #00a; cursor: pointer;" class="text-center" onclick={linkCompositeIdClickHandler}>copy composite url</div>
            </Show>
            <Show when={!showSeparateCompositeSection()}>
              <div style="width: 100%; margin-top: -20px; color: #00a; cursor: pointer;" class="text-center" onclick={linkItemIdClickHandler}>copy url</div>
            </Show>
            <div class="inline-block text-slate-800 text-xs p-[6px] ml-[30px] mt-[6px]">
              <span class="font-mono text-slate-400">{qrInfoItem().itemType[0].toUpperCase() + qrInfoItem().itemType.substring(1)} Id:</span><br />
              <span class="font-mono text-slate-400">{`${qrInfoItem().id}`}</span>
              <i class={`fa fa-copy text-slate-400 cursor-pointer ml-2`} onclick={copyItemIdClickHandler} />
            </div>
            <Show when={showSeparateCompositeSection()}>
              <div class="inline-block text-slate-800 text-xs p-[6px] ml-[30px] mt-[6px]">
                <span class="font-mono text-slate-400">Composite Id:</span><br />
                <span class="font-mono text-slate-400">{`${compositeItemMaybe()!.id}`}</span>
                <i class={`fa fa-copy text-slate-400 cursor-pointer ml-2`} onclick={copyCompositeIdClickHandler} />
              </div>
            </Show>
            <Show when={isDebugSupportedItem()}>
              <div class="text-slate-800 text-xs p-[6px] ml-[30px]">
                <span class="font-mono text-slate-400">Debug:</span>
                {renderDebugLinks()}
              </div>
            </Show>
            <Show when={isDataItem(qrInfoItem())}>
              <div class="text-slate-800 text-xs p-[6px] ml-[30px]">
                <span class="font-mono text-slate-400">Size: {formatBytes(asDataItem(qrInfoItem()).fileSizeBytes || 0)}</span>
              </div>
            </Show>
            <Show when={isPage(qrInfoItem()) || isTable(qrInfoItem())}>
              <div class="text-slate-800 text-xs p-[6px] ml-[30px]">
                {(() => {
                  const currentItem = qrInfoItem();
                  const stats = calculateChildrenStats(asContainerItem(currentItem));
                  return (
                    <>
                      <span class="font-mono text-slate-400">Children: {stats.totalChildren}</span><br />
                      <span class="font-mono text-slate-400">Data Items: {stats.imageFileChildren}</span><br />
                      <span class="font-mono text-slate-400">Total Size: {formatBytes(stats.totalBytes)}</span>
                    </>
                  );
                })()}
              </div>
            </Show>
          </div>
        </Match>
        <Match when={overlayType() == ToolbarPopupType.ItemIcon}>
          <div class="absolute border rounded-md bg-slate-50 mb-1 shadow-lg border-slate-400 overflow-hidden"
            style={`left: ${boxBoundsPx().x}px; top: ${boxBoundsPx().y}px; width: ${boxBoundsPx().w}px; height: ${boxBoundsPx().h}px; z-index: ${Z_INDEX_GLOBAL_TOOLBAR_OVERLAY}; cursor: default;`}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}>
            <div class="flex items-center gap-[7px] p-[8px] border-b border-slate-200 bg-white">
              <button class={itemIconChoiceClass(itemIconIsAuto())}
                title="Auto icon"
                type="button"
                onClick={() => chooseAutoIcon(false)}>
                <span class="font-semibold text-[17px]">A</span>
              </button>
              <button class={itemIconChoiceClass(itemIconIsNone())}
                title="No icon"
                type="button"
                onClick={() => chooseItemIcon(null, false, false)}>
                <i class="fa fa-ban" />
              </button>
              <button class={itemIconChoiceClass(regularIconSelected())}
                title={`Default ${itemIconLabel()} icon`}
                type="button"
                onClick={() => chooseItemIcon(null, true, false)}>
                <i class={defaultItemIconClass()} />
              </button>
              <Show when={isNote(getToolbarFocusItem(store))}>
                <button class={noteFaviconButtonClass()}
                  title={noteFaviconButtonTitle()}
                  type="button"
                  disabled={!noteHasFaviconUrl()}
                  onClick={() => chooseFaviconIcon(false)}>
                  <i class={noteFaviconButtonIconClass()} />
                </button>
              </Show>
              <div class="grow"></div>
              <input ref={emojiInputElement}
                class="border border-slate-300 rounded-md h-[32px] px-[4px] text-center bg-white focus:outline-none focus:border-blue-500 placeholder:text-[10px] placeholder:font-sans"
                style={`width: 48px; font-size: ${emojiInputFontSize()}px; ${emojiInputFontStyle()}`}
                autocomplete="off"
                value={emojiInputValue()}
                type="text"
                placeholder="emoji"
                onFocus={handleCustomEmojiFocus}
                onInput={handleCustomEmojiInput}
                onBlur={handleCustomEmojiBlur}
                onKeyDown={handleCustomEmojiKeyDown}
                onKeyUp={handleCustomEmojiKeyUp}
                onKeyPress={handleCustomEmojiKeyPress} />
            </div>
            <div class="overflow-y-auto pb-[8px]"
              style={`height: ${boxBoundsPx().h - 49}px;`}>
              <For each={EMOJI_CATEGORIES}>{category =>
                <div class="pt-[8px]">
                  <div class="px-[12px] pb-[3px] text-[10px] uppercase tracking-wide text-slate-500">
                    {category.name}
                  </div>
                  <div class="grid gap-[3px] px-[8px] justify-center"
                    style="grid-template-columns: repeat(9, 32px); grid-auto-rows: 32px;">
                    <For each={category.emojis}>{emoji =>
                      <button class={emojiChoiceClass(itemIconVisible() && selectedEmoji() == emoji)}
                        title={emoji}
                        type="button"
                        style={emojiFontStyle()}
                        onClick={() => chooseItemIcon(emoji, true, false)}>
                        {emoji}
                      </button>
                    }</For>
                  </div>
                </div>
              }</For>
            </div>
          </div>
        </Match>
        <Match when={true}>
          <div class="absolute border rounded bg-white mb-1 shadow-md border-black"
            style={`left: ${boxBoundsPx().x}px; top: ${boxBoundsPx().y}px; width: ${boxBoundsPx().w}px; height: ${boxBoundsPx().h}px; z-index: ${Z_INDEX_GLOBAL_TOOLBAR_OVERLAY}; cursor: default;`}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}>
            <Show when={label() != null}>
              {overlayType() == ToolbarPopupType.TableNumCols || overlayType() == ToolbarPopupType.PageNumCols || overlayType() == ToolbarPopupType.NoteIndent
                ? <div class="flex items-center mt-[7px]">
                  <div class="text-sm ml-2 mr-2">{label()}</div>
                  <input ref={textElement}
                    class="p-[2px] focus:outline-none"
                    style={`width: ${inputWidthPx() - 50}px`}
                    type="range"
                    min="1"
                    max={overlayType() == ToolbarPopupType.NoteIndent ? "4" : "20"}
                    value={sliderValue()}
                    onInput={handleSliderInput}
                    onKeyDown={handleKeyDown}
                    onKeyUp={handleKeyUp}
                    onKeyPress={handleKeyPress} />
                  <span class="ml-1 text-sm font-mono w-6 text-center">{sliderValue()}</span>
                </div>
                : <div class="inline-block">
                  <div class="text-sm ml-1 mr-2 inline-block">{label()}</div>
                  <input ref={textElement}
                    class="border border-slate-300 rounded mt-[3px] p-[2px]"
                    style={`width: ${inputWidthPx()}px`}
                    autocomplete="on"
                    value={textEntryValue()!}
                    type="text"
                    onChange={handleTextChange}
                    onKeyDown={handleKeyDown}
                    onKeyUp={handleKeyUp}
                    onKeyPress={handleKeyPress} />
                </div>
              }
            </Show>
            <Show when={showAutoButton()}>
              <button class="border border-slate-300 rounded mt-[3px] p-[2px] ml-[4px] hover:bg-slate-300"
                type="button"
                onClick={handleAutoClick}>
                auto
              </button>
            </Show>
            <Show when={tooltip() != null}>
              <div class="text-xs p-[4px] pt-[5px]">
                {tooltip()}
              </div>
            </Show>
          </div>
        </Match>
      </Switch>
    </>
  );
}
