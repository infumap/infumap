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

import { Accessor, createSignal } from "solid-js";
import { post } from "../server";
import { NumberSignal, createNumberSignal } from "../util/signals";


const LOCALSTORAGE_KEY_NAME = "infudata";

export const NETWORK_STATUS_OK = 0;
export const NETWORK_STATUS_IN_PROGRESS = 1;
export const NETWORK_STATUS_ERROR = 2;

interface InstallationState {
  hasRootUser: boolean,
  devFeatureFlag: boolean,
}

interface LocalStorageData {
  prefer2fa: boolean
}

export interface GeneralStoreContextModel {
  installationState: Accessor<InstallationState | null>,
  retrieveInstallationState: () => Promise<void>,
  clearInstallationState: () => void,

  prefer2fa: () => boolean,
  setPrefer2fa: (prefer2fa: boolean) => void,

  networkStatus: NumberSignal,
}


export function makeGeneralStore(): GeneralStoreContextModel {
  const [localStorageDataString, setLocalStorageDataString] = createSignal<string | null>(window.localStorage.getItem(LOCALSTORAGE_KEY_NAME), { equals: false });

  const [installationState, setInstallationState] = createSignal<InstallationState | null>(null, {equals: false });

  const networkStatus = createNumberSignal(NETWORK_STATUS_OK);

  const retrieveInstallationState = async () => {
    try {
      setInstallationState(await post(null, "/admin/installation-state", {}));
    } catch (e) {
      console.error("An error occurred retrieving installation state. " + e);
      setInstallationState(null);
    }
  }
  const clearInstallationState = () => { setInstallationState(null); }

  const prefer2fa = () => {
    const lcDs = localStorageDataString();
    let lcd: LocalStorageData | null = lcDs == null ? null : JSON.parse(lcDs);
    if (lcd == null) { return false; }
    return lcd.prefer2fa;
  }
  const setPrefer2fa = (prefer2fa: boolean) => {
    let lcDs = localStorageDataString();
    let r = { prefer2fa };
    if (lcDs != null) {
      r = JSON.parse(lcDs);
      r.prefer2fa = prefer2fa;
    }
    lcDs = JSON.stringify(r);
    window.localStorage.setItem(LOCALSTORAGE_KEY_NAME, lcDs);
    setLocalStorageDataString(lcDs);
  }

  return {
    installationState, retrieveInstallationState, clearInstallationState,
    prefer2fa, setPrefer2fa,
    networkStatus,
  };
}
