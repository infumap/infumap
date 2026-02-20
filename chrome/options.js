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

const postJson = async (url, body) => {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  return await response.json();
};

const humanReadableTime = (unixSecs) => {
  if (!unixSecs) {
    return "N/A";
  }
  return new Date(unixSecs * 1000).toLocaleString();
};

const setStatus = (text, isError = false) => {
  const status = document.getElementById("status");
  status.textContent = text;
  status.style.color = isError ? "#b00020" : "#1f2937";
};

const renderSessionStatus = async () => {
  const settings = await storageGet({
    ingestSessionId: null,
    deviceName: null,
    accessExpires: null,
    refreshExpires: null
  });

  const summary = document.getElementById("sessionSummary");
  if (!settings.ingestSessionId) {
    summary.textContent = "No ingest session paired.";
    return;
  }

  const lines = [
    `Session: ${settings.ingestSessionId}`,
    `Device: ${settings.deviceName ?? "Chrome extension"}`,
    `Access expires: ${humanReadableTime(settings.accessExpires)}`,
    `Refresh expires: ${humanReadableTime(settings.refreshExpires)}`
  ];
  summary.textContent = lines.join("\n");
};

const saveBaseUrl = async () => {
  const baseUrlInput = document.getElementById("baseUrl");
  const baseUrl = normalizeBaseUrl(baseUrlInput.value);
  await storageSet({ baseUrl });
  baseUrlInput.value = baseUrl;
  setStatus("Base URL saved.");
};

const pairExtension = async () => {
  const baseUrl = normalizeBaseUrl(document.getElementById("baseUrl").value);
  const pairingCode = document.getElementById("pairingCode").value.trim();
  const deviceName = document.getElementById("deviceName").value.trim();

  if (pairingCode === "") {
    setStatus("Enter a pairing code from Infumap User Settings.", true);
    return;
  }

  setStatus("Pairing...");
  try {
    const response = await postJson(`${baseUrl}ingest/pairing/redeem`, {
      pairingCode,
      deviceName: deviceName === "" ? null : deviceName
    });

    if (!response.success) {
      setStatus(`Pairing failed (${response.err ?? "unknown"}).`, true);
      return;
    }

    await storageSet({
      baseUrl,
      ingestSessionId: response.ingestSessionId ?? null,
      deviceName: response.deviceName ?? null,
      accessToken: response.accessToken ?? null,
      accessExpires: response.accessExpires ?? null,
      refreshToken: response.refreshToken ?? null,
      refreshExpires: response.refreshExpires ?? null
    });

    document.getElementById("pairingCode").value = "";
    setStatus("Paired successfully.");
    await renderSessionStatus();
  } catch (_e) {
    setStatus("Pairing request failed.", true);
  }
};

const disconnectExtension = async () => {
  const settings = await storageGet({
    baseUrl: DEFAULT_BASE_URL,
    refreshToken: null
  });

  const baseUrl = normalizeBaseUrl(settings.baseUrl);
  if (settings.refreshToken) {
    try {
      await postJson(`${baseUrl}ingest/token/revoke`, {
        refreshToken: settings.refreshToken
      });
    } catch (_e) {
    }
  }

  await storageRemove(AUTH_STORAGE_KEYS);
  setStatus("Ingest session removed.");
  await renderSessionStatus();
};

const restoreOptions = async () => {
  const settings = await storageGet({
    baseUrl: DEFAULT_BASE_URL
  });
  document.getElementById("baseUrl").value = normalizeBaseUrl(settings.baseUrl);
  await renderSessionStatus();
  setStatus("");
};

document.addEventListener("DOMContentLoaded", restoreOptions);
document.getElementById("save").addEventListener("click", saveBaseUrl);
document.getElementById("pair").addEventListener("click", pairExtension);
document.getElementById("disconnect").addEventListener("click", disconnectExtension);
