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
import { ClientOnlyItemKind } from "./base/item";
import { asQueryItem, getQueryRuntime, isQueryItem, type QueryItem } from "./query-item";
import { PageItem } from "./page-item";
import { itemState } from "../store/ItemState";
import { StoreContextModel } from "../store/StoreProvider";
import type { QueryChatCompletedActivity } from "../store/StoreProvider_PerItem";
import { Uid } from "../util/uid";

export const QUERY_CHAT_ACTIVITY_HEADER_HEIGHT_PX = 36;
export const QUERY_CHAT_ACTIVITY_MIN_HEIGHT_PX = 140;
export const QUERY_CHAT_ACTIVITY_MAX_HEIGHT_PX = 300;

const [completedActivityUiRevision, setCompletedActivityUiRevision] =
  createSignal(0, { equals: false });
const expandedCompletedActivityIdsByQueryId = new Map<Uid, Set<string>>();
const completedActivityBodyHeightPxByQueryId = new Map<Uid, Map<string, number>>();

function bumpQueryChatCompletedActivityUi(): void {
  setCompletedActivityUiRevision(completedActivityUiRevision() + 1);
}

export function queryChatCompletedActivityUiRevision(): number {
  return completedActivityUiRevision();
}

export function completedQueryChatActivitiesForQuery(
  store: StoreContextModel,
  queryItem: QueryItem,
): Array<QueryChatCompletedActivity> {
  const chat = getQueryRuntime(store, queryItem).chat;
  const currentRootIds = new Set(chat.rootItemIds ?? []);
  return (chat.completedActivities ?? []).filter(activity =>
    activity.assistantRootIds.some(rootId => currentRootIds.has(rootId))
  );
}

export function queryChatCompletedActivityAnchorRootId(
  activity: QueryChatCompletedActivity,
  currentRootIds: Set<Uid>,
): Uid | null {
  return activity.assistantRootIds.find(rootId => currentRootIds.has(rootId)) ?? null;
}

export function queryChatCompletedActivityForChild(
  store: StoreContextModel,
  queryItemId: Uid,
  childItemId: Uid,
): QueryChatCompletedActivity | null {
  const chat = getQueryRuntime(store, queryItemId).chat;
  const currentRootIds = new Set(chat.rootItemIds ?? []);
  for (const activity of chat.completedActivities ?? []) {
    if (queryChatCompletedActivityAnchorRootId(activity, currentRootIds) == childItemId) {
      return activity;
    }
  }
  return null;
}

export function isQueryChatCompletedActivityExpanded(queryId: Uid, requestId: string): boolean {
  queryChatCompletedActivityUiRevision();
  return expandedCompletedActivityIdsByQueryId.get(queryId)?.has(requestId) ?? false;
}

export function toggleQueryChatCompletedActivityExpanded(queryId: Uid, requestId: string): void {
  const expanded = expandedCompletedActivityIdsByQueryId.get(queryId) ?? new Set<string>();
  if (expanded.has(requestId)) {
    expanded.delete(requestId);
  } else {
    expanded.add(requestId);
  }
  expandedCompletedActivityIdsByQueryId.set(queryId, expanded);
  bumpQueryChatCompletedActivityUi();
}

export function queryChatCompletedActivityReservePx(queryId: Uid, requestId: string): number {
  const expanded = expandedCompletedActivityIdsByQueryId.get(queryId)?.has(requestId) ?? false;
  if (!expanded) {
    return QUERY_CHAT_ACTIVITY_HEADER_HEIGHT_PX;
  }
  const bodyPx = completedActivityBodyHeightPxByQueryId.get(queryId)?.get(requestId) ??
    (QUERY_CHAT_ACTIVITY_MIN_HEIGHT_PX - QUERY_CHAT_ACTIVITY_HEADER_HEIGHT_PX);
  return Math.min(
    QUERY_CHAT_ACTIVITY_MAX_HEIGHT_PX,
    Math.max(QUERY_CHAT_ACTIVITY_HEADER_HEIGHT_PX, QUERY_CHAT_ACTIVITY_HEADER_HEIGHT_PX + bodyPx),
  );
}

export function setQueryChatCompletedActivityBodyHeightPx(
  queryId: Uid,
  requestId: string,
  bodyHeightPx: number,
): boolean {
  const nextPx = Math.max(0, Math.round(bodyHeightPx));
  const byRequestId = completedActivityBodyHeightPxByQueryId.get(queryId) ?? new Map<string, number>();
  if (byRequestId.get(requestId) == nextPx) {
    return false;
  }
  byRequestId.set(requestId, nextPx);
  completedActivityBodyHeightPxByQueryId.set(queryId, byRequestId);
  bumpQueryChatCompletedActivityUi();
  return true;
}

export function clearQueryChatCompletedActivityUi(queryId: Uid): void {
  const hadExpanded = expandedCompletedActivityIdsByQueryId.delete(queryId);
  const hadHeights = completedActivityBodyHeightPxByQueryId.delete(queryId);
  if (hadExpanded || hadHeights) {
    bumpQueryChatCompletedActivityUi();
  }
}

export function queryChatPageChildActivityReservePx(
  store: StoreContextModel,
  page: PageItem,
  childItemId: Uid,
): number {
  if (page.clientOnlyKind != ClientOnlyItemKind.QueryChatPage) {
    return 0;
  }
  const parent = itemState.get(page.parentId);
  if (parent == null || !isQueryItem(parent)) {
    return 0;
  }
  const queryItem = asQueryItem(parent);
  const activity = queryChatCompletedActivityForChild(store, queryItem.id, childItemId);
  if (activity == null) {
    return 0;
  }
  return queryChatCompletedActivityReservePx(queryItem.id, activity.requestId);
}
