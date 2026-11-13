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

import { Component, createMemo, createResource, For, Show } from "solid-js";

const STRENGTH_LABELS = ["Very weak", "Weak", "Fair", "Good", "Strong"];
const STRENGTH_COLORS = ["bg-red-600", "bg-orange-600", "bg-amber-500", "bg-lime-600", "bg-green-600"];

export const PasswordStrength: Component<{ id: string, password: string, username: string }> = (props) => {
  // Load the estimator's dictionaries only when a password form is open. Passwords stay in the browser.
  const [estimator] = createResource(async () => {
    try {
      return (await import("zxcvbn")).default;
    } catch {
      // An unavailable advisory meter must not prevent choosing a password.
      return null;
    }
  });
  const strength = createMemo(() => {
    const estimate = estimator();
    if (!estimate || !props.password) { return null; }
    // Bound pattern matching work for long pasted passwords, conservatively scoring only the prefix.
    return estimate(props.password.slice(0, 100), [props.username, "infumap"]).score;
  });

  return (
    <div id={props.id} aria-live="polite" aria-atomic="true">
      <Show when={props.password.length > 0}>
        <div class="mt-2 text-xs text-slate-600">
          <Show when={strength() !== null} fallback={
            <span>{estimator.loading ? "Estimating password strength…" : "Password strength unavailable"}</span>
          }>
            <div class="flex gap-1 mb-1" aria-hidden="true">
              <For each={STRENGTH_LABELS}>{(_, index) =>
                <div class={`h-1 flex-1 rounded ${index() <= strength()! ? STRENGTH_COLORS[strength()!] : "bg-slate-200"}`} />
              }</For>
            </div>
            <span>Password strength: {STRENGTH_LABELS[strength()!]}</span>
          </Show>
        </div>
      </Show>
    </div>
  );
};
