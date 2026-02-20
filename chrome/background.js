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

chrome.action.onClicked.addListener((tab) => {
  addCurrentTab(tab);
});

const DEFAULT_BASE_URL = "http://localhost:8000/";

const AUTH_STORAGE_KEYS = [
  "ingestSessionId",
  "deviceName",
  "accessToken",
  "accessExpires",
  "refreshToken",
  "refreshExpires"
];

const normalizeBaseUrl = (baseUrl) => {
  if (!baseUrl || typeof baseUrl !== "string") {
    return DEFAULT_BASE_URL;
  }
  const trimmed = baseUrl.trim();
  if (trimmed === "") {
    return DEFAULT_BASE_URL;
  }
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
};

const storageGet = async (defaults) => {
  return await chrome.storage.local.get(defaults);
};

const storageSet = async (values) => {
  await chrome.storage.local.set(values);
};

const storageRemove = async (keys) => {
  await chrome.storage.local.remove(keys);
};

const loadSettings = async () => {
  const settings = await storageGet({
    baseUrl: DEFAULT_BASE_URL,
    ingestSessionId: null,
    deviceName: null,
    accessToken: null,
    accessExpires: null,
    refreshToken: null,
    refreshExpires: null
  });

  settings.baseUrl = normalizeBaseUrl(settings.baseUrl);
  return settings;
};

const saveAuthTokens = async (baseUrl, response) => {
  await storageSet({
    baseUrl: normalizeBaseUrl(baseUrl),
    ingestSessionId: response.ingestSessionId ?? null,
    deviceName: response.deviceName ?? null,
    accessToken: response.accessToken ?? null,
    accessExpires: response.accessExpires ?? null,
    refreshToken: response.refreshToken ?? null,
    refreshExpires: response.refreshExpires ?? null
  });
};

const clearAuthTokens = async () => {
  await storageRemove(AUTH_STORAGE_KEYS);
};

const postJson = async (url, body, headers = {}) => {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      ...headers
    },
    body: JSON.stringify(body)
  });

  return await response.json();
};

const addItem = async (baseUrl, accessToken, tab) => {
  const jsonData = JSON.stringify({
    itemType: "note",
    title: tab.title ?? tab.url,
    url: tab.url,
    spatialWidthGr: 8 * 60
  });
  return await postJson(`${baseUrl}ingest/add-item`, {
    jsonData
  }, {
    "Authorization": `Bearer ${accessToken}`
  });
};

const refreshTokens = async (baseUrl, refreshToken) => {
  if (!refreshToken) {
    return null;
  }

  const refreshResponse = await postJson(`${baseUrl}ingest/token/refresh`, {
    refreshToken
  });

  if (!refreshResponse.success) {
    return null;
  }

  await saveAuthTokens(baseUrl, refreshResponse);
  return refreshResponse;
};

const addCurrentTab = async (tab) => {
  if (!tab || !tab.url) {
    return;
  }

  const settings = await loadSettings();
  if (!settings.accessToken || !settings.refreshToken) {
    await chrome.runtime.openOptionsPage();
    return;
  }

  let result;
  try {
    result = await addItem(settings.baseUrl, settings.accessToken, tab);
  } catch (_e) {
    result = null;
  }

  if (result?.success) {
    return;
  }

  const refreshed = await refreshTokens(settings.baseUrl, settings.refreshToken);
  if (refreshed?.accessToken) {
    try {
      const retryResult = await addItem(settings.baseUrl, refreshed.accessToken, tab);
      if (retryResult?.success) {
        return;
      }
    } catch (_e) {
    }
  }

  await clearAuthTokens();
  await chrome.runtime.openOptionsPage();
};
