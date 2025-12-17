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

const REMOTE_SESSIONS_STORAGE_KEY = "infumap_remote_sessions";

const remoteSessions = new Map<string, RemoteSession>();

const normalizeHost = (host: string): string => {
  try {
    return new URL(host).origin;
  } catch (_e) {
    return host;
  }
};

const loadFromLocalStorage = (): void => {
  try {
    const stored = window.localStorage.getItem(REMOTE_SESSIONS_STORAGE_KEY);
    if (stored) {
      const sessions: Record<string, RemoteSession> = JSON.parse(stored);
      for (const [host, session] of Object.entries(sessions)) {
        remoteSessions.set(host, session);
      }
    }
  } catch (e) {
    console.error("Failed to load remote sessions from localStorage:", e);
  }
};

const saveToLocalStorage = (): void => {
  try {
    const sessions: Record<string, RemoteSession> = {};
    for (const [host, session] of remoteSessions.entries()) {
      sessions[host] = session;
    }
    window.localStorage.setItem(REMOTE_SESSIONS_STORAGE_KEY, JSON.stringify(sessions));
  } catch (e) {
    console.error("Failed to save remote sessions to localStorage:", e);
  }
};

loadFromLocalStorage();

export const REMOTE_SESSION_HEADER = "x-infusession";

export const RemoteSessions = {
  get: (host: string): RemoteSession | null => {
    const normalizedHost = normalizeHost(host);
    return remoteSessions.get(normalizedHost) ?? null;
  },

  getAll: (): RemoteSession[] => {
    return Array.from(remoteSessions.values());
  },

  set: (session: RemoteSession): void => {
    const normalizedHost = normalizeHost(session.host);
    remoteSessions.set(normalizedHost, { ...session, host: normalizedHost });
    saveToLocalStorage();
  },

  clear: (host: string): void => {
    const normalizedHost = normalizeHost(host);
    remoteSessions.delete(normalizedHost);
    saveToLocalStorage();
  },
};
