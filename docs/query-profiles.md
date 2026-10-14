# Query configuration and profiles

Search, chat and deep research share a resource configuration. It lives in the query runtime,
in each query command's `configuration`, and in each transcript turn's `settings.configuration`.
The TypeScript definition is in `web/src/items/query-configuration.ts`; the shared Rust definition
is in `infumap/src/query_configuration.rs`. Chat turn settings use these shared types.

```json
{
  "scopeId": null,
  "model": {
    "backend": "llama:mbp",
    "model": null,
    "reasoningEffort": null
  },
  "capabilities": ["infumap_data", "web_search"]
}
```

All configuration fields are explicit, including nullable fields:

- `scopeId`: the ID of an Infumap scope, or `null` for everything. Search always uses this scope.
  Chat uses it when `infumap_data` is enabled. It does not constrain web tools, attachments or
  information already in the conversation. The scope is retained even when Infumap tools are off.
- `model`: an explicit provider route, model and reasoning effort. The backend is `openrouter`
  or `llama:<configured server name>`. A null model ID is for a provider that serves its own model;
  OpenRouter requires an explicit model ID. A null reasoning effort uses the model's default.
  A null selection object means no model has been chosen, such as before the default profile loads
  or in Search. Chat execution requires a selection;
  the composer copies the default profile before the first command and sends the selected resources exactly.
- `capabilities`: enabled capability IDs: `infumap_data` and configured MCP server IDs.
  Array order has no meaning. Search ignores model and capability settings.

Search / Chat / Deep research is an operation, stored separately from the resource configuration.
`QueryChatSettings` (Rust `TurnSettings`) is shared by chat requests and transcript settings.
It carries `mode` and `appliedProfile` alongside `configuration`. `appliedProfile` is the copied
profile as applied, or `null` for a query without a profile; execution uses `configuration`.

## Profiles and snapshots

A `QueryProfile` has `id`, `name`, and `configuration`. Pinning, ordering, model favorites and the
default profile are account preferences stored with the profiles. Profile selection and management
are available in the composer's **More** menu.

The query runtime has an editable `configuration` and a nullable `appliedProfile`. The latter holds
the profile snapshot as applied, including its name and configuration, for reset and modified
state handling. `snapshotQueryProfile` copies both the model object and capability array; editable
conversation configuration must also be copied with `cloneQueryConfiguration`. Saved profiles and
conversation settings must never share mutable objects.

Chat submission copies configuration into the request, and the server copies it into the turn's
settings. Reload restores the last recorded configuration and applied profile snapshot as value
copies, including the scope when Infumap tools were disabled. Changing a profile cannot alter settings
recorded in a transcript.

## Configuration state

`web/src/items/query-configuration-state.ts` owns profile application, temporary changes, reset,
modified-state detection, request snapshots and restoring recorded configuration:

- `applyQueryProfile` copies the whole configuration and reset baseline in one runtime update.
  Search / Chat / Deep research mode remains unchanged.
- `updateQueryConfiguration` and `setQueryConfigurationCapability` edit only the current query.
  Scope, model and tool selectors use this layer and never change the default profile.
- `resetQueryConfiguration` restores the snapshot as applied, including its name. Later edits or
  deletion of the saved profile have no effect on reset. A query without an applied profile has no
  reset baseline.
- `isQueryConfigurationModified` compares scope and model settings exactly, and capability IDs as
  sets. Capability ordering and duplicate entries do not count as modifications. Value copies
  deduplicate capability IDs so a source is offered only once.
- `snapshotQueryChatSettings` captures the selected configuration, applied profile and run mode.
  Sending does not substitute model selections, add tools or rewrite the applied baseline.
- `restoreQueryConfiguration` restores resources and profile provenance together. A subsequent
  catalog refresh cannot overwrite the restored settings.

The general store exposes one `defaultQueryProfile` source backed by the account's saved profiles.
Its explicit setter selects a saved profile ID and persists the preference. The profile store copies
inputs and returned values. Model/tool catalogs are fetched separately from account preferences;
search does not need to wait for availability checks.

A new query copies this complete profile once. `configurationInitialized` distinguishes a pending
query from an explicitly applied, edited or restored setup. Commands wait for initialization, and
scope selection is disabled while it is pending. Late catalog responses never add default tools to
a selected profile. Changing the default affects future queries; existing queries keep their copies.

Transcript format version 2 uses this configuration shape. There is no migration or legacy reader.

## Account storage and API

The user record's optional `queryProfiles` field holds one `QueryProfileCollection`: a revision,
the ordered profile array, and preferences (`defaultProfileId`, `pinnedProfileIds`, and
`modelFavorites`). There is one ordering: pinned profiles are a set, always stored in profile order.
A model favorite identifies a provider/model pair, independent of reasoning effort.
This data is written through the user database log and is included in existing account backups.
Profile changes mark the account dirty so they trigger the next scheduled backup even without item edits.

The field was added in user log version 7. Existing version 6 logs (`user.json` in each user directory
and `pending_users.json`) are migrated with `infumap migrate --log-path <log>`, which only changes the
descriptor. The collection's shape is part of the user log schema: changing it requires a new log
version and migration. Records are read strictly, with unknown fields rejected.

Every change appends the whole collection to the user log, so the server caps an account at 100
profiles, 200 model favorites and 64 capabilities per profile. Profile names are unique, ignoring case.

An account with no profile collection gets one persisted, pinned **Default** profile on its first
profile request. Its configuration comes from the server's configured default model, unrestricted
Infumap scope, and Infumap plus configured tools enabled by default. Initialization does not probe
models or tool servers. Unavailable references remain saved. A server with no model configured can
still initialize a profile for Search.

The authenticated `query-profiles` command supports:

| Operation | Fields |
| --- | --- |
| `list` | No operation-specific fields |
| `create` | `name`, `configuration` |
| `rename` | `id`, `name` |
| `setConfiguration` | `id`, `configuration` |
| `duplicate` | `id`; the server names the copy "Name copy", "Name copy 2", … |
| `delete` | `id` |
| `move` | `id`, `toIndex` |
| `setPinned` | `id`, `pinned` |
| `setDefault` | `id` |
| `setModelFavorite` | `backend`, `model`, `favorite` |

Every request includes `expectedUserId`, which must match the authenticated session. It is an
account-switch guard, not an ownership selector. Profiles are resolved only within that session's
account; no operation accepts an owner to act on.

Each mutation states one intent and applies to the collection as it is when the request arrives, under
the database lock. No mutation carries a whole list or a whole profile, so concurrent changes from other
tabs or devices cannot overwrite each other: a rename and a configuration save to the same profile both
take effect. There is no expected revision and no conflict response.

The response contains `userId`, `collection`, nullable `error`, and nullable `profileId`. Validation
failures return the unchanged collection and a specific error. Database failures use the ordinary
command failure response. Every successful mutation increments the revision and persists profiles and
preferences together. Deleting the default makes the first remaining profile the default; deleting the
last profile is rejected. Deletion removes its pin but leaves conversation snapshots intact.

`StoreProvider_QueryProfiles.ts` exposes loading/refresh and all mutation operations. It sends local
mutations one at a time and ignores a response whose revision is older than the collection it holds.
Returning to the app refreshes account preferences across tabs/devices while
existing queries retain their copied configuration. Clearing the store or switching accounts
invalidates pending responses and queued mutations.

## Scope, model and tools controls

New Query and existing chat composers share three independent controls. Search shows only Scope.

- **Scope** lists named Infumap scopes with coverage, exclusions and definition problems. It keeps
  the selected scope while showing **Not used** when chat's Infumap tools are disabled. Search always
  applies scope. Its description makes clear that web tools, attachments and existing context are unaffected.
- **Model** opens a single searchable list of model/provider combinations, with account favorites
  first. Star buttons add or remove favorites without changing conversation settings. Provider routes
  appear in the button and in every model row. Providers that do not expose model identity are labelled
  **Server-selected**. The selected model's supported reasoning efforts and a **Default** option live here.
  Saved selections and favorites that disappear from the catalog remain visible with availability information.
- **Tools** displays enabled capability names, such as **Infumap + Web**, rather than a function count.
  The popup has capability toggles with readable descriptions and availability. Expand **Functions**
  to inspect function descriptions, then **Raw schema** for their complete definitions. Selected missing
  or unavailable sources remain visible and can be explicitly disabled when tool choices are unlocked.

Chat / Deep research is a separate mode control in an existing conversation; New Query keeps its
Search / Chat / Deep research mode selector. Scope, model, reasoning effort and tools can change
between turns. Configuration changes are disabled while a response runs or the transcript is loading.

All popup controls share viewport sizing, outside-click dismissal, Escape dismissal, focus return,
Tab containment and arrow navigation between radio choices. New Query's control cycle includes Scope,
Model and Tools and skips disabled controls. Popup changes preserve a draft being edited in the query input.

## One-click profile selection

New Query, Search and existing chat composers show **Profile** shortcuts above the input. Pinned
profiles follow the account's profile order and apply in one click. Long names truncate with
the full name and configuration in a tooltip. The shortcuts scroll horizontally rather than increasing
the composer's height; **More** stays visible. It lists unpinned profiles in account order with Scope,
Model/provider/reasoning effort and Tools summaries. Pinned profiles also appear in a separate section
so they remain accessible on narrow screens. Selecting a menu profile applies it and closes the menu.

Selection copies the entire configuration and applied snapshot together. It preserves the draft,
attachments, mode and account default. Search uses only the selected scope; selecting a profile with
a different scope reruns an existing search. Model and tools remain available if the user later switches
to Chat. Scope, Model and Tools controls sit below the input for inspection and temporary overrides.

A shortcut is marked selected only when its ID and saved configuration match the current query.
**Modified** reports changes against the applied snapshot. An unpinned applied profile's name appears
in **More**. Refreshing saved profiles does not overwrite the query; the menu explains when an applied
profile was edited or deleted, and keeps the original snapshot name visible.

Profile application is blocked during a response and while a historical chat's settings are loading
or failed to load. Between turns, a profile can replace the entire tool set along with scope and model;
a profile is never partially applied. The disabled reason is visible in the menu and shortcut tooltip.
The menu remains available for inspection and includes loading, error and retry states.
Keyboard users can Tab through shortcuts and the menu
in the query's control cycle, use Left/Right between shortcuts, and use Up/Down in the profile menu.

Search results, transcripts and the activity panel reserve the profile row's height and spacing.

## Profile management and saving changes

The profile menu offers **Save as profile…** and **Manage profiles**. Saving captures the current
Scope, Model/provider/reasoning effort and Tools as a value copy when the editor opens. The editor
shows that setup and asks for a name. New profiles start unpinned and leave the account default alone.
After saving, this query adopts the saved profile as its applied baseline if the editor is still open
and the account, query, configuration and prior applied snapshot are unchanged. Otherwise the saved
profile remains available without overwriting the current setup. Draft text, attachments and mode stay
unchanged. This applies to saving changes to an existing profile as well.

**Manage profiles** provides rename, duplicate, delete, pin/unpin, and **Make default** actions. Duplicate
copies the saved profile, including its configuration, and starts unpinned. Up/Down buttons order the
saved profile list, which is also the order of the pinned shortcuts. Making a default affects future queries; management never rewrites existing query or
transcript snapshots. Renaming therefore preserves the original applied snapshot's name until a user
explicitly reapplies or saves the profile.

Delete opens an inline confirmation. The last profile cannot be deleted. When deleting the default, the
confirmation names the profile that will become the default. A deleted
profile's applied snapshot remains available for Reset and Save as profile.

When a query is **Modified**, its profile menu offers **Reset** and **Save changes…**. Reset restores
the snapshot as originally applied, even if the saved profile was renamed, edited or deleted. A changed
scope reruns an existing search. Save changes previews the current setup and replaces the saved
profile's configuration while preserving its current saved name. If the saved profile changed since
application, the editor explains that its current settings will be replaced. If the profile was deleted,
Save changes is disabled and Save as profile remains available. Reset respects the current response
and loading locks; saving the current setup waits for query initialization and loading/response locks.

Forms retain entered text on errors and expose busy, success and error states. A profile changed or
deleted while its form is open must be reviewed again before rename, save or deletion.
Account switches disable an open manager.
Keyboard focus moves into forms, returns to the management list after actions, and remains contained
within the shared profile dialog.

Profile names share the server's trim, control-character and 120-byte UTF-8 validation. Forms explain
an invalid name before submission; a name already in use is reported by the server.

## Changes between turns

Scope, Model/provider/reasoning effort, Tools, profile selection and Reset can all change an existing
chat's setup between turns. Infumap scope is retained when Infumap tools are switched off and becomes
active again if those tools are re-enabled. The picker descriptions explain that changes apply from
the next message: earlier answers, retrieved context and attachments remain part of the conversation.
Changing scope or disabling tools does not remove information the model has already received.

Submission reserves `chat.requestId` before waiting for transcript/profile loading. This shared runtime
state prevents overlapping local submissions and keeps every view of the query locked during preparation
and streaming, even after the composer is remounted. User configuration mutations share a loading/request
guard in `query-configuration-state.ts`. Initialization and transcript restoration are separate internal
updates, so a pending first request can still receive its complete default setup. The request lock is
released after success, cancellation or failure; a cleared or superseded preparation cannot submit later.

Each submission copies configuration, applied profile and mode into its request. The server persists
that copy in the user turn and builds the turn's model route, scope and tool definitions from that
request. Prior turn settings and history stay unchanged. Reload restores the last recorded turn's
configuration and applied snapshot; temporary changes that have not been submitted remain local.

If loading reports that a response is running elsewhere, `chat.runningElsewhere` keeps configuration
and submission controls locked. The visible query checks every two seconds and refreshes its transcript
when that response ends, then unlocks the controls. Checks ignore stale responses after a query is
cleared or the account changes. Tool and profile popups remain available for inspection while locked.

## Unavailable resources

`query-configuration-availability.ts` reports availability without changing configuration or saved
profiles. It distinguishes confirmed **Unavailable**, failed discovery (**Unverified**), initial
**Checking** and scope-definition warnings. Failed catalog requests retain the last good list and
cannot prove that a resource was removed. Scope discovery is cleared on account changes, and stale
responses from a prior account are ignored.

Profiles remain selectable when they contain unavailable resources, so their complete setup can be
applied and repaired. Pinned shortcuts warn about active unavailable resources; profile summaries
explain each problem,
and the current profile row reports active problems. **More** and each independent picker offer
availability refresh actions. Long problem lists scroll inside the dialog header so configuration
and management actions stay reachable. Saved references, profile snapshots and model favorites are
retained even after a provider, model, scope or tool source disappears.

Confirmed unavailable active resources disable Send and block keyboard and command submission with
an explanation. The draft, attachments and selected setup stay intact. Search validates only Scope;
it ignores missing models and tools. Chat validates model/provider/reasoning effort and enabled tool
sources, and validates Scope only when Infumap tools are enabled. An unused missing scope remains
saved and becomes blocking if Infumap tools are explicitly re-enabled. Scope-definition problems
retain their existing warning semantics rather than substituting unrestricted scope.

The model picker retains missing provider/model pairs and displays unsupported reasoning effort
alongside **Default** and the supported efforts. Re-selecting the same model preserves its saved
effort; only an explicit change repairs it. Selecting a different model retains a compatible effort
or uses its default. Missing scope rows are retained with their saved ID but cannot be selected as
a replacement. An enabled unavailable tool source can be explicitly disabled between turns.

Unverified selections may still be submitted exactly as configured. The server validates resources
before recording a chat turn: missing scopes, missing provider routes, known missing models,
unsupported reasoning and selected missing/down tool sources reject the request. Selected tool
sources are never silently skipped; a later failure preparing tools also stops the turn. OpenRouter
cannot replace a null model with the server default, and llama requests cannot silently ignore an
explicit model or reasoning effort. Requests name a specific configured llama server rather than
the first-server alias; server default initialization still resolves configuration into a named route.

A fresh OpenRouter catalog can establish model/effort availability. If refreshing that catalog fails,
the cached catalog is labelled stale and used for browsing, while the exact selected model and effort
may be tried at the provider. The server does not infer that a missing entry in a stale catalog was
removed. A rejected turn returns its draft to the client and triggers discovery refresh; no profile,
scope, model, tool set or default is automatically changed to make the request succeed.

## Review and build verification

The user-facing guide is [Query profiles](chats.md#query-profiles); server initialization is described
in [Configuration](configuration.md). The final integration review follows these code boundaries:

| Contract | Implementation |
| --- | --- |
| Copy a complete profile; keep overrides and saved defaults separate | `query-configuration.ts`, `query-configuration-state.ts`, per-item store |
| Account ownership, intent-based mutations, atomic persistence and backups | `query_profiles.rs`, `StoreProvider_QueryProfiles.ts`, user database |
| Select, inspect, save, reset, rename, duplicate, delete, pin and order | `QueryProfileBar.tsx`, `QueryProfileManager.tsx` |
| Favorite provider/model pairs without rewriting query settings | `QueryModelPicker.tsx`, profile store |
| Keep disabled controls out of the composer Tab cycle and contain dialog focus | `Query.tsx`, `QueryPickerPopover.tsx` |
| Reserve profile rows in results, transcript and activity geometry | `search-item.ts`, `query-item.ts`, `Query.tsx` |
| Lock preparation and streaming; preserve snapshots across turns and reload | `chat.ts`, query runtime, chat route and transcript |
| Preserve the draft's Deep research choice when a turn is rejected before recording | `Query.tsx` submission handlers |
| Retain unavailable references; validate only resources used by the operation | `query-configuration-availability.ts`, independent pickers, Search/chat commands |
| Refuse unavailable resources instead of substituting defaults or skipping tools | chat resource preflight, backend resolution, MCP tool mapping |

Non-test checks, run from the repository root:

```sh
npm --prefix web run typecheck
npm --prefix web run build
cargo check --manifest-path infumap/Cargo.toml --locked --offline
git diff --check
```

These checks establish compilation, production bundling and patch formatting. The integration review
is source inspection, not executed browser or provider verification. Tests were not added, updated or
run under the repository instructions; interactive behavior and live provider/MCP calls have not been
validated by this review. The production build currently reports its existing large-chunk warning.
