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

import { Component, Match, Switch, createEffect, createSignal, onCleanup } from "solid-js";
import { getImage, releaseImage } from "../../imageManager";
import { NoteFaviconLoadStatus, noteFaviconStatus, setNoteFaviconStatus } from "../../items/note-favicon-state";
import { NoteFns, type NoteItem } from "../../items/note-item";


export const NoteIconGlyph: Component<{ note: () => NoteItem, highPriority?: () => boolean }> = (props) => {
  const [faviconObjectUrl, setFaviconObjectUrl] = createSignal<string | null>(null);
  let currentFaviconPath = "";
  let currentFaviconOrigin: string | null = null;

  const emoji = () => NoteFns.emoji(props.note());
  const faviconPath = () => NoteFns.faviconPath(props.note());

  const markCurrentFaviconFailed = (): void => {
    if (currentFaviconPath == "") { return; }
    const path = currentFaviconPath;
    const origin = currentFaviconOrigin;
    setFaviconObjectUrl(null);
    releaseCurrentFavicon();
    setNoteFaviconStatus(path, origin, NoteFaviconLoadStatus.Failed);
  };

  const releaseCurrentFavicon = (): void => {
    if (currentFaviconPath == "") { return; }
    releaseImage(currentFaviconPath, currentFaviconOrigin);
    currentFaviconPath = "";
    currentFaviconOrigin = null;
  };

  createEffect(() => {
    const path = faviconPath();
    const origin = props.note().origin;
    if (path == null) {
      setFaviconObjectUrl(null);
      releaseCurrentFavicon();
      return;
    }

    const status = noteFaviconStatus(path, origin);
    if (status == NoteFaviconLoadStatus.Failed) {
      setFaviconObjectUrl(null);
      releaseCurrentFavicon();
      return;
    }
    if (currentFaviconPath == path && currentFaviconOrigin == origin) {
      return;
    }

    releaseCurrentFavicon();
    currentFaviconPath = path;
    currentFaviconOrigin = origin;
    setFaviconObjectUrl(null);
    setNoteFaviconStatus(path, origin, NoteFaviconLoadStatus.Loading);

    getImage(path, origin, props.highPriority?.() ?? false)
      .then((objectUrl) => {
        if (currentFaviconPath != path || currentFaviconOrigin != origin) { return; }
        setFaviconObjectUrl(objectUrl);
        setNoteFaviconStatus(path, origin, NoteFaviconLoadStatus.Loaded);
      })
      .catch(() => {
        if (currentFaviconPath != path || currentFaviconOrigin != origin) { return; }
        markCurrentFaviconFailed();
      });
  });

  onCleanup(() => {
    releaseCurrentFavicon();
  });

  return (
    <Switch>
      <Match when={emoji()}>
        <span class="inline-block leading-none"
          style={`font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif; transform: translateY(1px);`}>
          {emoji()}
        </span>
      </Match>
      <Match when={faviconObjectUrl()}>
        <img class="inline-block leading-none align-baseline"
          alt=""
          draggable={false}
          onError={markCurrentFaviconFailed}
          src={faviconObjectUrl()!}
          style="width: 1em; height: 1em; object-fit: contain; transform: translateY(1px);" />
      </Match>
      <Match when={true}>
        <i class="fas fa-sticky-note" />
      </Match>
    </Switch>
  );
};
