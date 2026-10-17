# Network status

Status: planned 2026-10-17. Steps 1–4 done 2026-10-17.

This plan covers the toolbar network indicator and the dialog it opens
([Toolbar_NetworkStatus.tsx](../web/src/components/toolbar/Toolbar_NetworkStatus.tsx)). It follows a design review
from the same date.

## Goal

The indicator answers one question: **is my work safe, and am I looking at current data?** In priority order:

1. Are all my changes saved? If not: which items, why, and what can I do about it?
2. Is the server reachable, and is sync working? When did the last sync succeed?
3. For debugging only: which requests are running or queued?

Today the dialog is mostly the third thing, a request log, with the first added on top and the second missing.

## Problems being fixed

- Container sync runs every 2s ([server.ts](../web/src/server.ts) `startContainerSyncLoop`). Finished requests stay
  listed for 9s. So the activity list is always 4–5 "Syncing containers" rows, the empty state almost never shows,
  and the toolbar square turns yellow during every sync.
- The "In Progress" heading also counts requests that have already finished.
- Error rows show a cut-off uid and a raw message. They have no time and no consequence, and a failed read looks the
  same as a lost write. Errors only clear when acknowledged, even after the same operation later succeeds.
- A failed text save appears twice: in the unsaved box and in the error list. After Retry succeeds, the square stays
  red until the error is acknowledged. After acknowledging, it stays red while the save is still failing.
- A failed text save stops container sync (`textEditInProgressForContainerSync`). Only the `online` event, hiding the
  tab, or a manual Retry starts another save attempt. If the server is down while the browser is online, sync stays
  stopped indefinitely, and the dialog doesn't say so.
- Session expiry with unsaved text: logout can't flush, so it opens the dialog and returns. The dialog tells the user
  to retry, but a retry can't succeed.
- Remote write failures (`serveWaiting_remote`) are not passed to `handleFailedMutation`, so they show no toast.
- The indicator uses colour alone, with no tooltip or label. The red and green have similar luminance.
- `hasUnacknowledgedNetworkErrors` duplicates `erroredNetworkRequests.length > 0`. `NETWORK_STATUS_ERROR` is never
  set. The `networkStatus` signal is passed through about 150 call sites, but its value comes from module-global
  queue state.

## Design

### Request kinds

Each tracked request gets a kind, assigned in `toNetworkRequestInfo` from the command:

| kind    | commands |
|---------|----------|
| `write` | `MUTATION_COMMANDS`, plus `query-profiles` when the operation is not `list` |
| `read`  | `get-items`, `search`, `list-scopes`, `query-profiles` list, `load-chat`, `load-chat-attachment`, `get-backlinks` |
| `sync`  | `sync-containers` |
| `chat`  | `chat` (streamed) |

`sync` requests never go into the activity lists. They update a sync summary instead:

- `lastSyncOkMs`
- `consecutiveSyncFailures`
- `syncPausedReason: "text-edit" | null`. Text is being edited, or is unsaved. A hidden tab is not reported,
  because the dialog can't be seen then.

Every request also gets `startedMs`, and `endedMs` once it finishes. An aborted chat is recorded as `cancelled`,
not as a success.

### Problems replace errors

`erroredNetworkRequests` and `hasUnacknowledgedNetworkErrors` are replaced by one list:

```ts
interface NetworkProblem {
  key: string,               // host + command + itemId
  kind: "write" | "read" | "sync" | "chat",
  description: string,
  itemId?: Uid,
  host?: string | null,
  reason: "unreachable" | "auth" | "not-found" | "server" | "client" | "unknown",
  message: string,
  firstMs: number,
  lastMs: number,
  count: number,
}
```

- **read, sync and chat** problems clear automatically when a later request with the same key succeeds.
- **write** problems mean a change was reverted to the server's version by `reconcileFailedItems`. They stay until
  the user dismisses them, because the lost change does not come back.
- An `update-item` failure on an item that has a pending text save is **not** recorded as a problem. The pending save holds
  the item, and so the change; it retries with the whole current item; and reconciling is blocked until it
  succeeds. Nothing is lost, so the "Not saved" row for that item is enough. This applies only to `update-item`: a
  failed `add-item` means the item doesn't exist on the server, which a retried update can't fix.
- `reason`: a `CommandFailedError` gives its `failReason`. A fetch `TypeError`, or a `SyntaxError` from a non-JSON
  proxy error page in `post`, counts as `unreachable`. Anything else, such as a chat stream's HTTP status or a model
  error, is `unknown`.
- Key: `host|command|itemId` (`networkProblemKey`). A failed search and a later successful search for different text
  share a key, which is accepted.

### Connection state

- `serverReachable` becomes false when a local request fails as `unreachable`. Any local success sets it to true.
- `sessionExpired` is set when `logoutIfSessionEnded` finds the session has ended but cannot log out because
  unsaved text remains.

### One status, two views

`networkStatusSummary(store)` returns `{ level, sentence }`. Both the toolbar square (its glyph and tooltip) and the
dialog header use it. The first matching row wins:

| level    | when | sentence (example) |
|----------|------|--------------------|
| `danger` | session expired with unsaved text | "Session expired: 1 unsaved note. Log in again to save it." |
| `danger` | failed text saves, or write problems | "1 change not saved: server unreachable. Retrying in 8s." |
| `warn`   | server unreachable, or read/sync problems | "Can't reach the server. Last synced 2 min ago." |
| `busy`   | a non-sync request has been running for more than 300ms, or text saves are pending | "Saving 2 changes…" |
| `ok`     | otherwise | "All changes saved · synced 2s ago" |

The 300ms delay stops background sync and fast requests from making the square flicker.

## Steps

Each step builds with `npm run typecheck` and can be committed on its own. For end-to-end checks, use a throwaway
server with Playwright. Simulate failures with `page.route` aborting `/command`, and call `page.unrouteAll()`
afterwards.

### 1. Classify requests and remove sync from the lists

- [server.ts](../web/src/server.ts): add `kind`, `startedMs` and `endedMs` to `NetworkRequestInfo`. Leave
  `sync-containers` out of what `syncGlobalRequestTracker` reports. Report sync results through a new tracker
  callback, `recordSyncResult(ok)`.
- Record `syncPausedReason` at each text-edit guard on sync (`containerSyncPausedForTextEdit`). A successful sync
  clears it.
- Leave sync out of the 300ms busy rule from the start, so the square stops turning yellow every 2s.
- Record an aborted chat stream as `cancelled`.
- Fix the dialog heading: show "In progress" and "Recent" as two headings. The old dialog stays until step 6, and
  this makes it honest in the meantime. Also add a "Background sync: OK, 2s ago / failed N times in a row /
  paused while editing text" line, so sync is still visible.
- Done: recent requests are reported when they finish, with `endedMs` and `outcome`, instead of being found by
  comparing in-progress lists.
- **Check:** with a page open and idle for 10s, the dialog shows no sync rows and the square stays green.

### 2. Problems model and connection state

- [StoreProvider_General.tsx](../web/src/store/StoreProvider_General.tsx): replace `erroredNetworkRequests` and
  `hasUnacknowledgedNetworkErrors` with `networkProblems`, `recordNetworkProblem`, `resolveNetworkProblems(key)`,
  `dismissNetworkProblem(key)`, `dismissAllNetworkProblems()` and `serverReachable`. `clearNetworkHistory` resets
  them all. (`lastSyncOkMs`, `consecutiveSyncFailures` and `syncPausedReason` were added in step 1.)
- server.ts: `trackNetworkCommandError` classifies the reason and records a problem. `trackNetworkCommandFinished`
  (from step 1) clears matching auto-clearing problems and sets `serverReachable`. A cancelled chat does neither.
  Both are already called from the local queue, the remote queue and `streamChatCommand`.
- For the text-save exception, expose `store.textEdit.hasPending(id)` and check it when a write fails.
- The old dialog reads `problems` until step 6: a "Problems" list with ×count, time, a "Not saved" tag on write
  rows, a per-row dismiss and "Dismiss all", plus a "Can't reach the server." line. The "Errors stay red" banner is
  gone. The toolbar square is red while any problem or failed text save remains, until step 5.
- Seen in passing: the toolbar's transient error message ("Couldn't save change…") covers the dialog's header.
  Step 6 should handle this.
- **Check:** abort `/command` for 5s and then restore it. The read/sync problem appears, then clears on its own after
  the next successful sync. A failed move of an item stays as a write problem until dismissed.

### 3. Text-save retry and failure reasons

- [text_edit_session.ts](../web/src/input/text_edit_session.ts): store `failReason` on `PendingSave`.
- After an `unreachable`, `server` or `unknown` failure, schedule `savePending(id)` with backoff: 2s, 4s, 8s, …,
  capped at 30s. `auth`, `not-found` and `client` failures are not retried, because trying again can't help (step 4
  handles `auth`). A success, `markDirty`, or `flush()` resets the backoff.
- `failed` now stays set while a retry is in flight, so the indicator doesn't flicker between red and yellow on
  each attempt.
- Expose `failedSaves()`, a list of `{ itemId, reason, retryAtMs }`, in place of the planned `nextRetryMs()` and
  `failedItemIds()`. The dialog shows the reason and "Retrying in Ns", and the button is now "Retry now".
- `handleFailedMutation` shows the "Couldn't save change" toast only for a text save's first failure, not on every
  retry.
- Keep the guard that stops sync while text is unsaved, since it protects the unsaved text from being overwritten.
  It is already visible, as `syncPausedReason = "text-edit"` (step 1).
- **Check:** abort `/command`, type into a note, wait 10s, then restore `/command`. The save succeeds on the next
  backoff tick without any user action, and sync resumes. Done: one toast, "Retrying in 5s" at 10s, saved on the
  server about 4s after restoring, and no problem row (which also confirms step 2's text-save exception).

### 4. Session expiry with unsaved text

- First, confirm the failure path on a throwaway server. Type with `/command` aborted. Then log the session out
  through the API in a second context, and restore `/command`. Note exactly what `logoutIfSessionEnded` and `logout`
  do.
- Then: when the session has ended and `flush()` fails, set `sessionExpired` instead of reopening the dialog on
  every failure. Text saves with `failReason == "auth"` stop retrying.
- The dialog shows:
  - **Open login in new tab**: a new tab shares the session cookie. Once the same user has logged in, "Retry now"
    succeeds and `sessionExpired` clears.
  - **Copy unsaved text**: puts the pending items' text on the clipboard.
  - **Discard and log out**: asks for confirmation, then calls a new `textEdit.discardPending()` and the normal
    logout.
- If a different user logs in in the other tab, the existing different-user check still logs out, through the
  discard path.
- **Check:** each of the three exits on a throwaway server.

What was found and done (2026-10-17):

- **What actually happened.** With the session ended, every text save failed with "Session is required to update an
  item.". The server classified that as `server`, not `auth`, so step 3 kept retrying. Each failure also ran
  `logoutIfSessionEnded`, which called `logout`, whose `flush()` reset the backoff and saved again. The result was
  a loop every 2s: two `update-item` requests and one `validate-session`, with the dialog forced open, saying "the
  server had an error".
- **Server:** `classify_command_error` treats "Session is required" / "session is required" as `auth`.
  `cargo test` doesn't compile at present, because of unrelated stale chat-backend tests, so the new unit test
  `missing_session_errors_are_classified_as_auth` hasn't been run. The end-to-end check covers the behaviour.
- **Client:**
  - `logout` now returns false when unsaved text kept the user logged in. When it does, `logoutIfSessionEnded` sets
    `store.general.sessionExpired` and doesn't check again.
  - A retry timer that fires while the session is expired does nothing.
  - `recheckExpiredSession` validates the session when the tab becomes visible again, or on "Retry now". If the same
    user is logged in again, it clears `sessionExpired` and saves the text.
- **Not built:** `textEdit.discardPending()`. The existing `textEdit.clear()` does the job, after
  `commitActiveTextEdit`, so the logout doesn't capture the editor's text again. Also added:
  `textEdit.unsavedText()`.
- **Checked:**
  - With the session ended, typing caused 2 `update-item` and 1 `validate-session` request in 15s, and nothing
    after that.
  - After logging in again and returning to the tab, the text was saved.
  - "Copy unsaved text" put the note's text on the clipboard.
  - "Discard and log out" asked for confirmation, went to /login, and the server kept the earlier text.
- **Not checked:** the different-user case. The session stays expired, and the dialog's text ("Your session has
  ended") doesn't mention that another account is now logged in.

### 5. Toolbar indicator

- New `networkStatusSummary(store)`. Put it in `components/toolbar/networkStatusSummary.ts` so the dialog can use it
  too.
- The square gets a glyph for each level (check, dots, `!`, ×), a `title` and an `aria-label` from the sentence, and
  colours with a clear difference in luminance between `ok` and `danger`. Keep the 19px size.
- The 300ms busy delay is a timer started when a non-sync request begins, and cancelled when no such request
  remains.
- **Check:** look at the four levels in screenshots. Typing turns the square busy, then ok about 1s after typing
  stops.

### 6. Dialog rewrite

Rewrite `Toolbar_NetworkStatus_Overlay`, top to bottom:

1. **Header:** the summary sentence and the close button.
2. **Not saved** (only when there is something): failed or pending text saves and write problems, one row per item.
   Each row shows the item title (from `itemState`, or the description when the item is gone) and what is at risk:
   "text not saved yet" or "change reverted to the server version". The reason is in plain words, and the time is
   relative. Clicking the title calls `switchToItem`. Buttons: **Retry now**, **Dismiss** (write problems only), and
   the session-expiry actions from step 4.
3. **Problems:** read, sync and chat problems, with the time and "×N" when repeated. Rows clear on their own, and
   **Dismiss all** clears them by hand.
4. **Activity** (collapsed by default): one line "Background sync: OK, last 2s ago" (or paused and why, or failing
   ×N). Then in-progress requests with elapsed time, queued requests, and the last few finished requests with
   their duration. No fixed `min-h`; scroll only beyond a `max-h`.

Also:

- Escape closes the dialog. Add this in [key.ts](../web/src/input/key.ts) before the other handling. The overlay
  stays out of `anOverlayIsVisible`, so other keyboard navigation keeps working while it is open.
- Clicking outside does not close it, so it can stay open as a monitor while you work.
- Remove the inner `<Show>`; the one in [Main.tsx](../web/src/components/Main.tsx) is enough.
- **Check:** screenshots of the idle, saving, offline, lost-write and session-expired states, at the dialog's minimum
  and maximum widths.

### 7. Remote write failures

- In `serveWaiting_remote`, when a mutation fails, call `showFailedMutationMessage` and record a write problem.
- Don't reconcile: `reconcileFailedItems` re-fetches from the local server only. Instead, the problem's text says
  the change may not have been saved on the remote host.
- **Check:** with a remote container open, abort the remote host's `/command`, move an item, and check that a toast
  and a write problem appear.

### 8. Cleanup and docs

- Delete `NETWORK_STATUS_ERROR`. Make `networkStatus` a derived accessor for the summary.
- Optional, in its own commit: remove the `networkStatus` parameter from the `server` and `remote` functions and
  their about 150 call sites. It's a large mechanical diff with no behaviour change, so do it only if wanted.
- Rewrite the top of this document as a description of how the feature works, and mark the steps done.

## Open questions

These have a default; change them before the step that depends on them.

- **Session expiry (step 4):** guide the user to log in in another tab (the default), or add an in-place login
  overlay like the one remote hosts use (`remoteLoginInfo`)? The overlay is a better experience, but a larger
  change.
- **Write problems:** keep them until dismissed (the default), or let them expire after a while, e.g. 1 hour?
- **Click outside (step 6):** the default is that it doesn't close the dialog. Every other toolbar popup does close
  on a click outside, so this is inconsistent.
