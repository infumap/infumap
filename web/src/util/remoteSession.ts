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

import { RemoteSessions, REMOTE_SESSION_HEADER } from "../store/RemoteSessions";

export function appendRemoteSessionHeader(host: string, headers: Record<string, string>): void {
  const session = RemoteSessions.get(host);
  if (session) {
    headers[REMOTE_SESSION_HEADER] = session.sessionDataString;
  }
}

export function applyRotatedRemoteSessionHeader(host: string, response: Response): void {
  const rotatedSessionHeader = response.headers.get(REMOTE_SESSION_HEADER);
  if (!rotatedSessionHeader) {
    return;
  }

  try {
    const rotatedSession = JSON.parse(rotatedSessionHeader);
    if (!rotatedSession.sessionId) {
      return;
    }

    const existing = RemoteSessions.get(host);
    if (!existing) {
      return;
    }

    const existingData = JSON.parse(existing.sessionDataString);
    const mergedSessionData = JSON.stringify({ ...existingData, ...rotatedSession });
    const nextUsername = typeof rotatedSession.username === "string" && rotatedSession.username.length > 0
      ? rotatedSession.username
      : existing.username;
    RemoteSessions.set({ host, sessionDataString: mergedSessionData, username: nextUsername });
  } catch (e) {
    console.warn("Could not process rotated remote session header:", e);
  }
}
