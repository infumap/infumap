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

import type { StoreContextModel } from "../../store/StoreProvider";
import type { NetworkFailureReason } from "../../store/StoreProvider_General";


/** ok: nothing to report. busy: saving or loading. warn: data may be stale. danger: a change is at risk or lost. */
export type NetworkStatusLevel = "ok" | "busy" | "warn" | "danger";

export interface NetworkStatusSummary {
  level: NetworkStatusLevel,
  sentence: string,
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count == 1 ? "" : "s"}`;
}

export function formatAgo(ms: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (seconds < 60) { return `${seconds}s ago`; }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) { return `${minutes} min ago`; }
  return `${Math.round(minutes / 60)} h ago`;
}

export function failReasonText(reason: NetworkFailureReason | null): string {
  switch (reason) {
    case "unreachable": return "the server can't be reached";
    case "auth": return "your session has ended";
    case "not-found": return "the item no longer exists on the server";
    case "client": return "the server rejected the change";
    case "server": return "the server had an error";
    default: return "an unknown error";
  }
}

/** "Retrying in 8s." for the soonest automatic retry of a failed text save. */
export function textSaveRetryText(store: StoreContextModel, nowMs: number): string {
  const retryTimes = store.textEdit.failedSaves()
    .map(save => save.retryAtMs)
    .filter((ms): ms is number => ms != null);
  if (retryTimes.length == 0) { return "Not retrying automatically."; }
  return `Retrying in ${Math.max(0, Math.ceil((Math.min(...retryTimes) - nowMs) / 1000))}s.`;
}

/**
 * The state of saving and syncing as one level and sentence, shared by the toolbar indicator and the network
 * status dialog. nowMs is passed in so callers decide how often relative times are refreshed.
 */
export function networkStatusSummary(store: StoreContextModel, nowMs: number): NetworkStatusSummary {
  const general = store.general;
  const unsavedCount = store.textEdit.unsavedCount();
  const failedSaves = store.textEdit.failedSaves();
  const problems = general.networkProblems();
  const writeProblems = problems.filter(p => p.kind == "write");
  const otherProblems = problems.filter(p => p.kind != "write");
  const lastSyncOkMs = general.lastSyncOkMs();

  if (general.sessionExpired()) {
    return { level: "danger", sentence: `Session ended: ${plural(unsavedCount, "item")} not saved. Log in again to save.` };
  }
  if (failedSaves.length > 0) {
    return {
      level: "danger",
      sentence: `${plural(failedSaves.length, "item")} not saved: ${failReasonText(failedSaves[0].reason)}. ` +
        textSaveRetryText(store, nowMs),
    };
  }
  if (writeProblems.length > 0) {
    return {
      level: "danger",
      sentence: `${plural(writeProblems.length, "change")} could not be saved, and ` +
        `${writeProblems.length == 1 ? "was" : "were"} undone.`,
    };
  }

  if (!general.serverReachable()) {
    return {
      level: "warn",
      sentence: "Can't reach the server." + (lastSyncOkMs == null ? "" : ` Last synced ${formatAgo(lastSyncOkMs, nowMs)}.`),
    };
  }
  if (otherProblems.length > 0) {
    return {
      level: "warn",
      sentence: otherProblems.length == 1
        ? `${otherProblems[0].description} failed.`
        : `${plural(otherProblems.length, "request")} failed.`,
    };
  }

  if (unsavedCount > 0) {
    return { level: "busy", sentence: `Saving ${plural(unsavedCount, "item")}…` };
  }
  if (general.networkBusy()) {
    const inProgress = general.inProgressNetworkRequests();
    if (inProgress.length == 0) { return { level: "busy", sentence: "Working…" }; }
    const more = inProgress.length > 1 ? ` (+${inProgress.length - 1} more)` : "";
    return { level: "busy", sentence: `${inProgress[0].description}…${more}` };
  }

  if (general.syncPausedReason() == "text-edit") {
    return { level: "ok", sentence: "All changes saved · sync paused while editing" };
  }
  return {
    level: "ok",
    sentence: "All changes saved" + (lastSyncOkMs == null ? "" : ` · synced ${formatAgo(lastSyncOkMs, nowMs)}`),
  };
}
