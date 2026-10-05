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

import { Component, For, Match, Switch } from "solid-js";
import { PrintBand, PrintLayout } from "../../layout/print-bands";
import { VisualElementSignal } from "../../util/signals";
import { VisualElement_Desktop } from "../VisualElement";
import { DocumentPageTitle } from "./DocumentPageTitle";
import { PageVisualElementProps } from "./Page";


/**
 * Renders a page for printing as a sequence of normal-flow bands (see print-bands.ts), so the browser paginates
 * between them. The content is scaled down to the printable width in css (see index.css).
 */
export const Page_PrintBands: Component<PageVisualElementProps & { layout: PrintLayout }> = (props) => {

  const bandStyle = (band: PrintBand) =>
    `position: relative; ` +
    `height: ${band.hPx}px; margin-top: ${band.marginTopPx}px; ` +
    `break-inside: ${band.breakInside}; break-after: ${band.breakAfter}; ` +
    (band.clip ? `overflow: hidden; ` : ``);

  const bandVes = (band: PrintBand): Array<VisualElementSignal> =>
    band.content.kind == "items" ? band.content.ves : [];

  // Positions the page's child area so the band's strip of it lines up with the band. It is deliberately unsized:
  // overflow from a box the size of the whole child area could add blank sheets.
  const stripStyle = (band: PrintBand) =>
    `position: absolute; left: ${-props.layout.contentLeftPx}px; top: ${-band.yPx}px;`;

  return (
    <div class="print-doc-container">
      <div class="print-doc"
        style={`position: relative; width: ${props.layout.contentWidthPx}px; ` +
          `--print-doc-width: ${props.layout.contentWidthPx}px;`}>
        <For each={props.layout.bands}>{band =>
          <div style={bandStyle(band)}>
            <div style={stripStyle(band)}>
              <Switch>
                <Match when={band.content.kind == "title"}>
                  <DocumentPageTitle visualElement={props.visualElement} pageFns={props.pageFns} allowEditing={false} />
                </Match>
                <Match when={band.content.kind == "items"}>
                  <For each={bandVes(band)}>{ves =>
                    <VisualElement_Desktop visualElement={ves.get()} suppressLocalShadow={true} />
                  }</For>
                </Match>
              </Switch>
            </div>
          </div>
        }</For>
      </div>
    </div>
  );
}
