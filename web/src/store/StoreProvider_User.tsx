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
import { eraseCookie, getCookie, setCookie } from "../util/cookies";
import { post } from "../server";
import { panic } from "../util/lang";
import { LoginResult, LogoutResult, User } from "../util/accountTypes";


const SESSION_COOKIE_NAME = "infusession";
const EXPIRE_DAYS = 30;

export interface UserStoreContextModel {
  login: (username: string, password: string, totpToken: string | null) => Promise<LoginResult>,
  logout: () => Promise<LogoutResult>,
  getUserMaybe: () => User | null,
  getUser: () => User,
  clear: () => void,
  updateHasTotp: (hasTotp: boolean) => void
}


export function makeUserStore(): UserStoreContextModel {
  const [sessionDataString, setSessionDataString] = createSignal<string | null>(getCookie(SESSION_COOKIE_NAME), { equals: false });

  const value: UserStoreContextModel = {
    login: async (username: string, password: string, totpToken: string | null): Promise<LoginResult> => {
      let r: any = await post(
        null,
        '/account/login',
        totpToken == null ? { username, password } : { username, password, totpToken });
      if (!r.success) {
        eraseCookie(SESSION_COOKIE_NAME);
        setSessionDataString(null);
        return { success: false, err: r.err };
      }
      const cookiePayload = JSON.stringify({
        username,
        userId: r.userId,
        homePageId: r.homePageId,
        trashPageId: r.trashPageId,
        dockPageId: r.dockPageId,
        sessionId: r.sessionId,
        hasTotp: r.hasTotp,
      });
      setCookie(SESSION_COOKIE_NAME, cookiePayload, EXPIRE_DAYS);
      setSessionDataString(cookiePayload);
      return { success: true, err: null };
    },

    logout: async (): Promise<LogoutResult> => {
      const data = sessionDataString();
      if (data == null) {
        return { success: false, err: "not logged in" };
      };
      const user: User = JSON.parse(data);
      let r: any = await post(null, '/account/logout', { "userId": user.userId, "sessionId": user.sessionId });
      eraseCookie(SESSION_COOKIE_NAME);
      setSessionDataString(null);
      if (!r.success) {
        return { success: false, err: r.err };
      }
      return { success: true, err: null };
    },

    getUserMaybe: (): (User | null) => {
      const data = sessionDataString();
      if (data == null) { return null };
      if (getCookie(SESSION_COOKIE_NAME) == null) {
        // Session cookie has expired. Update SolidJS state to reflect this.
        console.error("Session cookie has expired.");
        setSessionDataString(null);
        return null;
      }
      return JSON.parse(data!);
    },

    getUser: (): User => {
      const data = sessionDataString();
      if (data == null) { panic("no session data string."); };
      if (getCookie(SESSION_COOKIE_NAME) == null) {
        // Session cookie has expired. Update SolidJS state to reflect this.
        console.error("Session cookie has expired.");
        setSessionDataString(null);
        panic("session cookie has expired");
      }
      return JSON.parse(data!);
    },

    updateHasTotp: (hasTotp: boolean) => {
      const user = JSON.parse(sessionDataString()!);
      user.hasTotp = hasTotp;
      const cookiePayload = JSON.stringify(user);
      setSessionDataString(cookiePayload);
      setCookie(SESSION_COOKIE_NAME, cookiePayload, EXPIRE_DAYS);
    },

    clear: (): void => {
      eraseCookie(SESSION_COOKIE_NAME);
      setSessionDataString(null);
    }
  };

  return value;
}