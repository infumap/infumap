/*
  Copyright (C) 2022-2023 The Infumap Authors
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


export type InfuTextInputProps = {
  value?: string,
  type?: string,
  /// Triggered immediately as value changes.
  onIncrementalChange?: ((v: string) => void),
  /// Triggered after loosing focus.
  onChange?: ((v: string) => void),
  onEnter?: () => void,
  disabled?: boolean
};

export const InfuTextInput: Component<InfuTextInputProps> = (props: InfuTextInputProps) => {
  let textElement: HTMLInputElement | undefined;

  const keyDownHandler = (ev: Event) => {
    // The input element value does not change immediately on key down, so wait a bit.
    // This also gives desired behavior for ctrl-v. For paste otherwise, also just reuse this method.
    if (props.onIncrementalChange) {
      setTimeout(() => {
        props.onIncrementalChange!(textElement!.value)
      }, 1);
    }
    if ((ev as KeyboardEvent).code == "Enter" && props.onEnter) {
      setTimeout(() => { props.onEnter!(); }, 5)
    }
  }

  const changeHandler = (_ev: Event) => {
    if (props.onChange) {
      props.onChange(textElement!.value);
    }
  }

  return (
    <input ref={textElement}
           class="border border-slate-300 p-2 rounded"
           value={props.value ? props.value : ""}
           type={props.type ? props.type : "text"}
           onPaste={keyDownHandler}
           onKeyDown={keyDownHandler}
           onChange={changeHandler}
           disabled={props.disabled} />
  );
}
