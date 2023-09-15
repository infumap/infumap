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


import { Component, onCleanup, onMount } from "solid-js";


export type InfuTextAreaProps = {
  value?: string,
  /// Triggered immediately as value changes.
  onInput?: ((v: string) => void),
  /// Triggered after loosing focus, or cleanup.
  onChangeOrCleanup?: ((v: string) => void),
  disabled?: boolean,
  focus?: boolean,
};

export const InfuTextArea: Component<InfuTextAreaProps> = (props: InfuTextAreaProps) => {
  let textElement: HTMLTextAreaElement | undefined;

  const inputHandler = () => {
    if (props.onInput) {
      props.onInput!(textElement!.value);
    }
  }

  const changeHandler = () => {
    if (props.onChangeOrCleanup) {
      props.onChangeOrCleanup(textElement!.value);
    }
  }

  onCleanup(() => {
    changeHandler();
  })

  const mouseDownHandler = (ev: MouseEvent) => {
    ev.stopPropagation();
  }

  onMount(() => {
    if (props.focus) {
      textElement?.focus();
    }
  });

  return (
    <textarea ref={textElement}
              class="rounded"
              style={"width: 100%; height: 100%; padding: 0px; border: 0px; outline: none; resize: none;"}
              value={props.value ? props.value : ""}
              onMouseDown={mouseDownHandler}
              onInput={inputHandler}
              onChange={changeHandler}
              disabled={props.disabled} />
  );
}
