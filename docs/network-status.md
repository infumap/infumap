# Network status

Status: done 2026-10-17 (steps 1–8). Planned the same day, after a design review of the old dialog.

The toolbar has a small icon that shows the network status, and clicking it opens a dialog
([Toolbar_NetworkStatus.tsx](../web/src/components/toolbar/Toolbar_NetworkStatus.tsx)). Both answer one question:
**is my work safe, and am I looking at current data?** In priority order:

1. Are all my changes saved? If not: which items, why, and what can I do about it?
2. Is the server reachable, and is sync working? When did the last sync succeed?
3. For debugging only: which requests are running or queued?

## How it works

### Requests

All commands go through the request queues in [server.ts](../web/src/server.ts): one for the local server, and one
for remote hosts. Each tracked request has a kind, which `commandKind` derives from the command:

| kind    | commands |
|---------|----------|
| `write` | `MUTATION_COMMANDS`, plus `query-profiles` when the operation is not `list` |
| `read`  | `get-items`, `search`, `list-scopes`, `query-profiles` list, `load-chat`, `load-chat-attachment`, `get-backlinks` |
| `sync`  | `sync-containers` |
| `chat`  | `chat` (streamed) |

- **Background sync** runs every 2s, so it is never listed as a request and never makes the indicator busy. It is
  summarized in `store.general` instead, as `lastSyncOkMs`, `consecutiveSyncFailures` and `syncPausedReason`.
  Sync pauses (`"text-edit"`) while text is being edited or is unsaved, so that it can't overwrite that text.
- **Other requests** are reported to `store.general` through the tracker that `setGlobalRequestTracker` installs:
  - in progress and queued, each with `startedMs`;
  - finished, kept for 9s as "recent", with `endedMs` and `outcome` (`done`, or `cancelled` for an aborted chat).
- **Busy:** the queues call `setNetworkActive(active)` whenever the set of listed requests changes.
  `store.general.networkBusy` turns true only after a request has run for 300ms, so short requests don't flicker.
  This status is global: no `server.*` function takes a status parameter.

### Problems

A failed request becomes a `NetworkProblem` in `store.general.networkProblems`. Repeated failures of the same request
merge into one problem, with a count and first and last times. The key is `host|command|itemId`
(`networkProblemKey`), so failed searches for different text share one problem.

- **Read, sync and chat problems** clear automatically when the same request later succeeds.
- **Write problems** stay until dismissed, because the change is lost:
  - On the local server, `reconcileFailedItems` re-fetches the item, so the local copy goes back to the server's
    version.
  - On a remote host, which is not synced, the local copy keeps the change until the item is loaded again.
- **Text-save exception:** an `update-item` failure on an item with a pending text save is not recorded. The pending
  save holds the whole item and retries it, and reconciling waits for it, so nothing is lost. This doesn't apply to
  `add-item`.
- **`reason`** (`networkFailureReason`):
  - A `CommandFailedError` gives the server's `failReason`: `auth`, `not-found`, `server` or `client`.
  - A fetch `TypeError`, or a `SyntaxError` from a proxy's non-JSON error page, counts as `unreachable`.
  - Anything else is `unknown`.
- The server reports a command sent without a valid session ("Session is required…") as `auth`.

### Text saves

[text_edit_session.ts](../web/src/input/text_edit_session.ts) saves edited text 500ms after typing stops.

- **Retries:** a save that fails as `unreachable`, `server` or `unknown` retries itself after 2s, 4s, 8s and so on,
  up to 30s. Typing again, or `flush()` ("Retry now"), starts the delays over.
- **No retry:** `auth`, `not-found` and `client` failures are not retried, because trying again can't help.
- **State:** `pendingSaves()` lists every unsaved item, with its failure reason and next retry time.
  `failedSaves()` is the failed subset.
- **Toast:** the "Couldn't save change" toast is shown only for a save's first failure, not on every retry
  (`isTextSaveRetry`).

### Loading a page's children

[load.ts](../web/src/layout/load.ts) records a failed load of a container's children (`childLoadFailure`).

- **Retries:** an `unreachable`, `server` or `unknown` failure is retried after 2s, 4s, 8s and so on, up to 30s. The
  retry is a re-arrange, so only containers that are still visible are loaded again. Other reasons are not retried.
- **Sync:** container sync can deliver the children while the load is failing. That clears the failure
  (`childrenLoadedBySync`).
- **In the page:** a top-level page whose load failed shows "Couldn't load this page: <reason>." in place of the
  empty-page hint. The hint is shown only when the children are known (`childrenAreKnown`), so not while they are
  loading, or after a failure.

### Connection and session

- `serverReachable` turns false when a request to the local server fails as `unreachable`, and true on any local
  success.
- **Session expiry:** a failed mutation checks the session (`logoutIfSessionEnded`).
  - If the session has ended and there is no unsaved text, the user is logged out as before.
  - If unsaved text keeps the user logged in, `sessionExpired` is set and the session isn't checked again on each
    failure.
  - `recheckExpiredSession` runs when the tab becomes visible, or on "Retry now". If the same user has logged in
    again, for example in another tab (which shares the cookie), it clears `sessionExpired` and saves the text.

### One status, two views

`networkStatusSummary(store, nowMs)` in
[networkStatusSummary.ts](../web/src/components/toolbar/networkStatusSummary.ts) returns `{ level, sentence }`. Both
the toolbar indicator and the dialog header use it. The first matching row wins:

| level    | when | example sentence |
|----------|------|------------------|
| `danger` | session expired | "Session ended: 1 item not saved. Log in again to save." |
| `danger` | failed text saves | "1 item not saved: the server can't be reached. Retrying in 8s." |
| `danger` | write problems | "1 change could not be saved, and was undone." (only "could not be saved." if a remote write is among them) |
| `warn`   | server unreachable | "Can't reach the server. Last synced 3s ago." |
| `warn`   | read, sync or chat problems | "Loading content failed." or "2 requests failed." |
| `busy`   | unsaved text | "Saving 1 item…" |
| `busy`   | `networkBusy` | "Loading item…" or "Loading item… (+2 more)" |
| `ok`     | sync paused for editing | "All changes saved · sync paused while editing" |
| `ok`     | otherwise | "All changes saved · synced 2s ago" |

### Toolbar indicator

- **Look:** a cloud, the usual sign for "saved and synced", drawn as an SVG (`NetworkStatusIcon`). It is quiet while
  all is well and loud only when work is at risk:

  | level | icon |
  |---|---|
  | ok | an outline cloud, in the dark grey of the other toolbar icons: the lightest icon in the toolbar |
  | busy | a filled cloud, with three dots cut out |
  | warn | an amber cloud with a slash |
  | danger | a filled red badge with "!", the only filled shape |

  The shape alone tells the levels apart, for colour-blind users. Cut-outs use an SVG mask, so they show the toolbar
  behind them. The cloud is a union of circles, so the outline is the filled cloud with the same shapes, shrunk by
  the line width, cut out of it.
- **Sizing:** it is sized and styled like `InfuIconButton`, including the hover background.
- **Tooltip:** the sentence is the tooltip and the `aria-label`. Relative times in it are refreshed when the pointer
  enters the icon.
- **Not a `<button>`:** the indicator is a `div` with `role="button"`. A real button would keep focus after a click,
  so a later Space would toggle the dialog.

### Dialog

- **Header:** the same icon, and the sentence.
- **Not saved:**
  - One row per pending text save ("saving…", or the failure reason).
  - One row per write problem, which says the change was reverted (local) or is not saved on the host (remote).
  - Then the retry countdown with "Retry now", or, when the session has expired: **Open login in new tab**,
    **Retry now**, **Copy unsaved text** and **Discard and log out** (which asks for confirmation).
  - Clicking an item's title calls `navigateToContainingPageOfItemAndFocus`.
- **Problems:** read, sync and chat problems, with the reason in plain words, ×N and the time. The raw error message
  is in the tooltip. Each row has a dismiss button, and there is "Dismiss all".
- **Activity:**
  - Collapsed by default. The expanded state is kept for the session.
  - The background sync line is always shown.
  - Expanded, it lists running requests with elapsed time, queued requests, and recent requests with their duration.
- **Closing:**
  - Escape closes the dialog ([key.ts](../web/src/input/key.ts)). If text is being edited, the first Escape leaves
    the editor.
  - A mouse down outside closes it, like the other toolbar popups, and is then handled as usual
    ([mouse_down.ts](../web/src/input/mouse_down.ts)). The indicator is the exception, because its click
    toggles the dialog.
- **Toast:** while the dialog is open, `showFailedMutationMessage` shows no toast, because the dialog already shows
  the failure. Opening the dialog also clears an error toast that is already showing, because it would cover the
  header.

### Testing

Use a throwaway server with Playwright. `page.route` aborting `/command` simulates an unreachable server. Remove the
route with `page.unrouteAll()` afterwards. Calls to `server.*` made in the page through a dynamic import go through
the app's own queues, so they update the indicator and the dialog like real requests do.

## Known gaps

- `cargo test` doesn't compile at present, because of unrelated stale chat-backend tests. So
  `missing_session_errors_are_classified_as_auth` hasn't run. The behaviour was checked end to end.
- **Unretried text saves:** a text save that fails as `not-found` or `client` stays unsaved, and sync stays paused,
  until "Retry now". The dialog offers no way to discard it outside the session-expired case.
- **Different user:** if another account logs in in another tab, the session stays expired, and the dialog doesn't
  say that a different account is now logged in. This case hasn't been tested.
- **Remote writes:** these were checked with a host that can't be reached, not by moving an item in a real remote
  container.

## Problems found in the review (2026-10-17)

These are the problems the steps below fixed.

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

## Steps

The plan as it was carried out, with what was found and done in each step. "How it works" above describes the
result.

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
  Step 6 handles this.
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

Done (2026-10-17):

- `networkStatusSummary(store, nowMs)`. `nowMs` is passed in: the toolbar refreshes it when the pointer enters the
  square, and the dialog uses its 1s timer. The module also exports `formatAgo`, `failReasonText`,
  `textSaveRetryText` and `plural`, which the dialog now uses instead of its own copies.
- Sentences, for reference:
  - "Session ended: 1 item not saved. Log in again to save."
  - "1 item not saved: the server can't be reached. Retrying in 8s."
  - "1 change could not be saved, and was undone."
  - "Can't reach the server. Last synced 3s ago."
  - "Loading content failed." or "2 requests failed."
  - "Saving 1 item…"
  - "Loading item…" or "Loading item… (+2 more)"
  - "All changes saved · sync paused while editing"
  - "All changes saved · synced 2s ago"
- `store.general.networkBusy`: `networkStatus.set` starts a 300ms timer when the status becomes in-progress, and
  clears it when the status leaves that state. Background sync was already left out of the status in step 1.
- Colours: ok `#7bbb73`, busy `#babb73`, warn `#e0a040`, danger `#a12b2b`. Glyphs are dark on the first three
  and white on danger. Warn and ok have about the same luminance, so the glyph is what tells them apart.
- The square stays a `div`, now with `role="button"`. A real `<button>` would be focused by a click, and a later
  Space would toggle the dialog.
- **Checked:**
  - Screenshots of all four levels.
  - A fast reload never showed busy. A `get-items` delayed by 1.5s showed busy about 0.3s after it was sent.
  - Typing showed "Saving 1 item…" and was back to ok 0.66s after typing started.
  - Blocking `/command` gave warn. A failed write gave danger, which stayed after `/command` was restored.
- Testing note: `server.*` calls made in the page with a dummy `networkStatus` don't update the real indicator,
  because the queue sets the signal that the call passes in. Test busy with real app requests. Step 8's removal of
  the parameter would fix this.

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
- Clicking outside does not close it, so it can stay open as a monitor while you work. (Reversed afterwards: see
  "Decisions".)
- Remove the inner `<Show>`; the one in [Main.tsx](../web/src/components/Main.tsx) is enough.
- **Check:** screenshots of the idle, saving, offline, lost-write and session-expired states, at the dialog's minimum
  and maximum widths.

Done (2026-10-17):

- **Header:** a small copy of the toolbar square, then the summary sentence. The "Network Status" title is gone; the
  panel has `role="dialog"` and `aria-label="Network status"`.
- **Not saved:**
  - One row per pending text save (new `textEdit.pendingSaves()`; `failedSaves()` is now derived from it). The row
    says "saving…" or gives the failure reason.
  - One row per write problem: "Updating note failed because the server can't be reached. Reverted to the server
    version."
  - Below the rows: the retry countdown with "Retry now", or the session-expiry actions.
  - Clicking a title calls `navigateToContainingPageOfItemAndFocus`, not `switchToItem`. `switchToItem` asserts that
    the item is not a page and opens it on its own, while this shows the item where it is, focused.
- **Problems:** amber rows with the item's title where known, "Failed because …", ×N and the time. The raw error
  message is in the row's tooltip. "Dismiss all" clears only this section; write problems are dismissed one by one.
- **Activity:** collapsed by default, and the expanded state is kept for the session. The heading shows counts ("2
  running · 1 recent"). The background sync line is always shown. When expanded: running requests with elapsed time,
  queued requests, and recent requests with their duration or "cancelled". Rows name the item's title instead of a
  uid; the uid is in the tooltip. Scrolls beyond 180px.
- **Width:** a fixed 360px (at most the viewport less 10px), instead of 300–400px, so the layout doesn't jump as rows
  come and go.
- **Escape:** [key.ts](../web/src/input/key.ts) closes the dialog after the text-edit and native-input handling, so
  Escape while editing first leaves the editor and a second one closes the dialog.
- **Toast:** `showFailedMutationMessage` shows nothing while the dialog is open, because the dialog already shows
  the failure.
- **Checked:**
  - Screenshots of idle (collapsed and expanded), saving, offline, lost write, session expired, and lost write at a
    380px viewport.
  - Escape order, as above.
  - No toast while the dialog is open.
  - Clicking a title navigates without errors.

### 7. Remote write failures

- In `serveWaiting_remote`, when a mutation fails, call `showFailedMutationMessage` and record a write problem.
- Don't reconcile: `reconcileFailedItems` re-fetches from the local server only. Instead, the problem's text says
  the change may not have been saved on the remote host.
- **Check:** with a remote container open, abort the remote host's `/command`, move an item, and check that a toast
  and a write problem appear.

Done (2026-10-17):

- Recording the write problem was already done in step 2, because `trackNetworkCommandError` runs for the remote
  queue too. Added: `handleFailedRemoteMutation`, which shows the toast unless it is a text-save retry (the check is
  shared with `handleFailedMutation` as `isTextSaveRetry`). The toast names the host: "Couldn't save change:
  127.0.0.1:8024 could not be reached."
- Dialog row for a remote write problem: "Failed because 127.0.0.1:8024 can't be reached, so it is not saved there.
  Reload to see what it has." For the local server it still says "Reverted to the server version."
  `failReasonText` takes an optional server name, which remote read problems use too.
- Summary: "…, and was undone." only when every write problem is local; otherwise "1 change could not be saved."
- **Checked:** a write sent through `serverOrRemote.updateItem` for a note whose origin is `http://127.0.0.1:8024`,
  where nothing listens. This gave the toast, the danger level, and the row, which stayed after local sync
  succeeded. This exercises the remote queue's failure path. It was not the planned gesture of moving an item in a
  real remote container, which would need a second server and a remote login.

### 8. Cleanup and docs

- Delete `NETWORK_STATUS_ERROR`. Make `networkStatus` a derived accessor for the summary.
- Optional, in its own commit: remove the `networkStatus` parameter from the `server` and `remote` functions and
  their about 150 call sites. It's a large mechanical diff with no behaviour change, so do it only if wanted.
- Rewrite the top of this document as a description of how the feature works, and mark the steps done.

Done (2026-10-17):

- `NETWORK_STATUS_OK`, `NETWORK_STATUS_IN_PROGRESS` and `NETWORK_STATUS_ERROR` are gone, along with the
  `networkStatus` signal. The queues call `store.general.setNetworkActive(active)` through the request tracker, and
  `networkBusy` is derived from that.
- The optional part was done too: the `networkStatus` parameter was removed from every `server` and `remote` function
  and from the about 150 call sites (41 files), and from the helpers that passed it on: `fetchTextItemContent`,
  `chatAttachmentCopyData`, `itemAttachment`, and `makeQueryProfilesStore`. Calls made from test code now update the
  indicator, which fixes the testing problem noted in step 5.
- **Checked:**
  - A slow request still shows busy after about 0.3s.
  - A slow `listScopes()` called from test code now shows "Loading scopes…" too.
  - A text save retried while `/command` was blocked was saved after it was restored.

## Decisions

These were open questions in the plan. The defaults were kept:

- **Session expiry:** the user logs in again in another tab. An in-place login overlay, like the one remote hosts
  use (`remoteLoginInfo`), would be a better experience, but is a larger change.
- **Write problems** stay until dismissed. They don't expire.
- **Click outside:** the plan kept the old behaviour, in which a click outside didn't close the dialog, so that it
  could stay open as a monitor. This was reversed on 2026-10-17. In practice the dialog should behave like the other
  toolbar popups, and the indicator's icon and tooltip now cover watching the status.
  - Checked: a click inside keeps the dialog open, and a click on the page closes it. The indicator still toggles it.
    A click on a note closes the dialog and still starts editing the note.
- **Indicator look:** step 5 made the indicator a coloured, bordered square with a glyph. In use it felt too
  conspicuous: it was as loud when all was well as when work was lost, and it looked like the page-colour swatch
  next to it. On 2026-10-17 it became the cloud icon described under "Toolbar indicator", with an outline cloud for
  ok, so that the normal state is the lightest icon in the toolbar.
  - Checked: screenshots of the four levels in the toolbar, and of the dialog header in the danger state.
