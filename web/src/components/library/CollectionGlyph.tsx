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

import { Component } from "solid-js";

/** The icon that marks a collection page. The flag is otherwise invisible. */
export const COLLECTION_ICON_CLASS = "bi-collection";

// Below about 11px the icon's stacked lines merge and it reads as a plain box.
const CORNER_GLYPH_MIN_SIZE_PX = 12;
const CORNER_GLYPH_MAX_SIZE_PX = 16;
const CORNER_GLYPH_SIZE_FRAC = 0.15;

/**
 * Bottom-left of a page box: the other corners hold the link triangle, the attachments and the resize triangle.
 * It is purely visual, so it takes no clicks from what lies under it.
 */
export const CollectionCornerGlyph: Component<{ widthPx: number, heightPx: number, color: string, textShadow?: string }> = (props) => {
  const sizePx = () => Math.max(CORNER_GLYPH_MIN_SIZE_PX,
    Math.min(CORNER_GLYPH_MAX_SIZE_PX, Math.min(props.widthPx, props.heightPx) * CORNER_GLYPH_SIZE_FRAC));
  return (
    <i class={`${COLLECTION_ICON_CLASS} absolute pointer-events-none`} aria-label="Collection"
      style={`left: ${sizePx() * 0.35}px; bottom: ${sizePx() * 0.3}px; font-size: ${sizePx()}px; line-height: 1; ` +
        `color: ${props.color}; ${props.textShadow ? `text-shadow: ${props.textShadow}; ` : ""}z-index: 5;`} />
  );
};

/** After a title in a title bar. Kept out of the title element, which is contentEditable while the title is edited. */
export const CollectionTitleGlyph: Component<{ color: string }> = (props) =>
  <i class={`${COLLECTION_ICON_CLASS} pointer-events-none`} aria-label="Collection"
    style={`margin-left: 0.3em; font-size: 0.7em; font-weight: normal; color: ${props.color};`} />;
