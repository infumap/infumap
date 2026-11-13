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

import { Component, createMemo, For, Show } from "solid-js";

const STRENGTH_LABELS = ["Very weak", "Weak", "Fair", "Good", "Strong"];
const STRENGTH_COLORS = ["bg-red-600", "bg-orange-600", "bg-amber-500", "bg-lime-600", "bg-green-600"];

function estimateStrength(password: string, username: string): number {
  const characters = Array.from(password);
  const length = characters.length;
  const variety = [/\p{Ll}/u, /\p{Lu}/u, /\p{N}/u, /[^\p{L}\p{N}]/u]
    .filter(pattern => pattern.test(password)).length;

  // This is a rough hint, not a guessability model. Favor length so passphrases don't need symbols.
  let score = length < 8 ? 0 : length < 12 ? 1 : length < 16 ? 2 : length < 20 ? 3 : 4;
  if (length >= 12 && variety >= 3) { score = Math.min(4, score + 1); }

  // Length and variety alone would overrate repeated strings and a few obvious password choices.
  const predictable = new Set(characters).size < 5
    || /^(.+)\1+$/u.test(password)
    || /^(password|qwerty|letmein|welcome|admin|infumap)[\d\W_]*$/i.test(password)
    || (username.length > 0 && password.toLowerCase().startsWith(username.toLowerCase()));
  return predictable ? Math.min(1, score) : score;
}

export const PasswordStrength: Component<{ id: string, password: string, username: string }> = (props) => {
  // Bound work for oversized pasted input; the server limits accepted passwords to 256 bytes.
  const strength = createMemo(() => estimateStrength(props.password.slice(0, 256), props.username));

  return (
    <div id={props.id} aria-live="polite" aria-atomic="true">
      <Show when={props.password.length > 0}>
        <div class="mt-2 text-xs text-slate-600">
          <div class="flex gap-1 mb-1" aria-hidden="true">
            <For each={STRENGTH_LABELS}>{(_, index) =>
              <div class={`h-1 flex-1 rounded ${index() <= strength() ? STRENGTH_COLORS[strength()] : "bg-slate-200"}`} />
            }</For>
          </div>
          <span title="Rough estimate based on length, character variety, and obvious patterns.">
            Password strength: {STRENGTH_LABELS[strength()]}
          </span>
        </div>
      </Show>
    </div>
  );
};
