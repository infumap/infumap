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

import { Component, JSX } from "solid-js";
import logoUrl from "../assets/circle.png";


/**
 * Layout shared by the login and sign up pages: the logo, then a card in a single column that fits a phone.
 * The page scrolls, because #rootDiv is fixed to the viewport.
 */
export const AuthPage: Component<{ title: string, children: JSX.Element, below?: JSX.Element }> = (props) =>
  <div class="absolute inset-0 overflow-y-auto">
    <div class="w-full max-w-sm mx-auto px-4 pt-10">
      <img src={logoUrl} alt="Infumap" class="block w-10 h-10 mx-auto mb-4" />
      <div class="border border-slate-300 rounded-md shadow-sm p-5">
        <h1 class="text-xl font-bold mb-4">{props.title}</h1>
        {props.children}
      </div>
    </div>
    {props.below}
  </div>;

export const AuthField: Component<{ label: string, for: string, children: JSX.Element }> = (props) =>
  <div class="mb-4">
    <label for={props.for} class="block text-sm text-slate-700 mb-1">{props.label}</label>
    {props.children}
  </div>;

export const AuthCheckbox: Component<{ id: string, label: string, checked: boolean, onClick: () => void }> = (props) =>
  <label for={props.id} class="flex items-center gap-2 mb-4 text-sm text-slate-700 cursor-pointer select-none">
    <input type="checkbox" id={props.id} class="rounded-xs" checked={props.checked} onClick={props.onClick} />
    {props.label}
  </label>;

export const AuthError: Component<{ children: JSX.Element }> = (props) =>
  <div class="mt-3 text-sm text-red-700">{props.children}</div>;
