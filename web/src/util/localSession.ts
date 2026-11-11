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

/**
 * All tabs share the session cookie, so another tab can log in as a different user (or log out) without this tab
 * knowing. Requests to the local server name the user this tab expects, and the server refuses them, rather than
 * run them as whoever the cookie now names. Requests that can't carry a header (`<img src>`, downloads) aren't
 * covered, and are read-only.
 */
const EXPECTED_USER_HEADER_NAME = "x-infumap-user-id";
const SESSION_USER_MISMATCH_HEADER_NAME = "x-infumap-session-user-mismatch";

let expectedUserId: string | null = null;
let mismatchHandler: (() => void) | null = null;

export function setExpectedLocalUserId(userId: string | null): void {
  expectedUserId = userId;
}

/** Called after any local request was refused because the session is no longer this tab's user's. */
export function setLocalSessionMismatchHandler(handler: () => void): void {
  mismatchHandler = handler;
}

export function appendExpectedUserHeader(headers: Record<string, string>): void {
  if (expectedUserId != null) {
    headers[EXPECTED_USER_HEADER_NAME] = expectedUserId;
  }
}

export function noteLocalResponse(response: Response): void {
  if (response.headers.get(SESSION_USER_MISMATCH_HEADER_NAME) != null) {
    mismatchHandler?.();
  }
}

/** fetch for the local server. `init.headers`, if given, must be a plain object. */
export async function localFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
  appendExpectedUserHeader(headers);
  const response = await fetch(url, { ...init, headers });
  noteLocalResponse(response);
  return response;
}
