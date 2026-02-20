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

import { createSignal } from "solid-js";
import { post } from "../server";
import { panic } from "../util/lang";
import { LoginResult, LogoutResult, User } from "../util/accountTypes";


interface ValidateSessionResponse {
  success: boolean,
  username?: string | null,
  userId?: string | null,
  homePageId?: string | null,
  trashPageId?: string | null,
  dockPageId?: string | null,
  hasTotp?: boolean | null,
}

export interface UserStoreContextModel {
  login: (username: string, password: string, totpToken: string | null) => Promise<LoginResult>,
  logout: () => Promise<LogoutResult>,
  hydrateFromServer: () => Promise<void>,
  getUserMaybe: () => User | null,
  getUser: () => User,
  clear: () => void,
  updateHasTotp: (hasTotp: boolean) => void
}


export function makeUserStore(): UserStoreContextModel {
  const [sessionDataString, setSessionDataString] = createSignal<string | null>(null, { equals: false });

  const userFromResponse = (response: any, usernameMaybe: string | null): User | null => {
    const responseObj = response as ValidateSessionResponse;
    if (
      responseObj.userId == null ||
      responseObj.homePageId == null ||
      responseObj.trashPageId == null ||
      responseObj.dockPageId == null ||
      responseObj.hasTotp == null
    ) {
      return null;
    }

    const username = responseObj.username ?? usernameMaybe;
    if (username == null || username.trim() === "") {
      return null;
    }

    return {
      username,
      userId: responseObj.userId,
      homePageId: responseObj.homePageId,
      trashPageId: responseObj.trashPageId,
      dockPageId: responseObj.dockPageId,
      hasTotp: responseObj.hasTotp,
    };
  };

  const value: UserStoreContextModel = {
    login: async (username: string, password: string, totpToken: string | null): Promise<LoginResult> => {
      let r: any = await post(
        null,
        '/account/login',
        totpToken == null ? { username, password } : { username, password, totpToken });
      if (!r.success) {
        setSessionDataString(null);
        return { success: false, err: r.err };
      }

      const user = userFromResponse(r, username);
      if (user == null) {
        setSessionDataString(null);
        return { success: false, err: "server error" };
      }

      setSessionDataString(JSON.stringify(user));
      return { success: true, err: null };
    },

    logout: async (): Promise<LogoutResult> => {
      let r: any = await post(null, '/account/logout', {});
      setSessionDataString(null);
      if (!r.success) {
        return { success: false, err: r.err };
      }
      return { success: true, err: null };
    },

    hydrateFromServer: async (): Promise<void> => {
      try {
        const response: ValidateSessionResponse = await post(null, '/account/validate-session', {});
        if (!response.success) {
          setSessionDataString(null);
          return;
        }
        const user = userFromResponse(response, null);
        if (user == null) {
          setSessionDataString(null);
          return;
        }
        setSessionDataString(JSON.stringify(user));
      } catch (_e) {
        setSessionDataString(null);
      }
    },

    getUserMaybe: (): (User | null) => {
      const data = sessionDataString();
      if (data == null) { return null };
      return JSON.parse(data!);
    },

    getUser: (): User => {
      const data = sessionDataString();
      if (data == null) { panic("no session data string."); };
      return JSON.parse(data!);
    },

    updateHasTotp: (hasTotp: boolean) => {
      const current = sessionDataString();
      if (current == null) { return; }
      const user = JSON.parse(current);
      user.hasTotp = hasTotp;
      setSessionDataString(JSON.stringify(user));
    },

    clear: (): void => {
      setSessionDataString(null);
    }
  };

  return value;
}
