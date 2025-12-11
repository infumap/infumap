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

export interface RemoteSession {
  host: string,
  sessionDataString: string,
  username: string,
}

const remoteSessions = new Map<string, RemoteSession>();

const normalizeHost = (host: string): string => {
  try {
    return new URL(host).origin;
  } catch (_e) {
    return host;
  }
};

export const REMOTE_SESSION_HEADER = "x-infusession";

export const RemoteSessions = {
  get: (host: string): RemoteSession | null => {
    const normalizedHost = normalizeHost(host);
    return remoteSessions.get(normalizedHost) ?? null;
  },

  set: (session: RemoteSession): void => {
    const normalizedHost = normalizeHost(session.host);
    remoteSessions.set(normalizedHost, { ...session, host: normalizedHost });
  },

  clear: (host: string): void => {
    const normalizedHost = normalizeHost(host);
    remoteSessions.delete(normalizedHost);
  },
};
