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

import { Accessor, createContext, createSignal, useContext } from "solid-js";
import { JSX } from "solid-js/jsx-runtime";
import { post } from "../server";
import { panic } from "../util/lang";


const LOCALSTORAGE_KEY_NAME = "infudata";


interface InstallationState {
  hasRootUser: boolean
}

interface LocalStorageData {
  prefer2fa: boolean
}

export interface GeneralStoreContextModel {
  installationState: Accessor<InstallationState | null>,
  retrieveInstallationState: () => Promise<void>,
  clearInstallationState: () => void,
  assumeHaveRootUser: () => void,

  prefer2fa: () => boolean,
  setPrefer2fa: (prefer2fa: boolean) => void,
}

export interface GeneralStoreContextProps {
  children: JSX.Element
}

const GeneralStoreContext = createContext<GeneralStoreContextModel>();

export function GeneralStoreProvider(props: GeneralStoreContextProps) {
  const [localStorageDataString, setLacalStorageDataString] = createSignal<string | null>(window.localStorage.getItem(LOCALSTORAGE_KEY_NAME), { equals: false });

  const [installationState, setInstallationState] = createSignal<InstallationState | null>(null, {equals: false });

  const retrieveInstallationState = async () => {
    try {
      setInstallationState(await post(null, "/admin/installation-state", {}));
    } catch (e) {
      console.log("An error occurred retrieving installation state. " + e);
      setInstallationState(null);
    }
  }
  const clearInstallationState = () => { setInstallationState(null); }
  const assumeInstallationStateHaveRootUser = () => { setInstallationState({ hasRootUser: true }); }

  const prefer2fa = () => {
    const lcds = localStorageDataString();
    let lcd: LocalStorageData | null = lcds == null ? null : JSON.parse(lcds);
    if (lcd == null) { return false; }
    return lcd.prefer2fa;
  }
  const setPrefer2fa = (prefer2fa: boolean) => {
    let lcds = localStorageDataString();
    let r = { prefer2fa };
    if (lcds != null) {
      r = JSON.parse(lcds);
      r.prefer2fa = prefer2fa;
    }
    lcds = JSON.stringify(r);
    window.localStorage.setItem(LOCALSTORAGE_KEY_NAME, lcds);
    setLacalStorageDataString(lcds);
  }

  const value: GeneralStoreContextModel = {
    installationState, retrieveInstallationState, clearInstallationState, assumeHaveRootUser: assumeInstallationStateHaveRootUser,
    prefer2fa, setPrefer2fa,
  };

  return (
    <GeneralStoreContext.Provider value={value}>
      {props.children}
    </GeneralStoreContext.Provider>
  );
}

export function useGeneralStore() : GeneralStoreContextModel {
  return useContext(GeneralStoreContext) ?? panic("no general store context");
}
