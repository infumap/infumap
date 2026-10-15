# Query configuration and profiles

Search, chat and deep research share a resource configuration. It lives in the query runtime,
in each chat request's `configuration`, and in each transcript turn's `settings.configuration`.
The search command takes only `scopeId`, the one part of the configuration search uses.
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
default profile are account preferences stored with the profiles. Pinned profiles are one-click
shortcuts above the composer; every profile is in its **Profiles** menu.

The query runtime has an editable `configuration` and a nullable `appliedProfile`. The latter holds
the profile snapshot as applied, which chat requests record as provenance. Modified state and Reset use
the saved profile with the same ID, as it is saved now, not the snapshot. `snapshotQueryProfile` copies both the model object and capability array; editable
conversation configuration must also be copied with `cloneQueryConfiguration`. Saved profiles and
conversation settings must never share mutable objects.

Chat submission copies configuration into the request, and the server copies it into the turn's
settings. Reload restores the last recorded configuration and applied profile snapshot as value
copies, including the scope when Infumap tools were disabled. Changing a profile cannot alter settings
recorded in a transcript.

## Configuration state

`web/src/items/query-configuration-state.ts` owns profile application, temporary changes, reset,
modified-state detection, request snapshots and restoring recorded configuration:

- `applyQueryProfile` copies the whole configuration and records the applied profile in one runtime update.
  Search / Chat / Deep research mode remains unchanged.
- `updateQueryConfiguration` and `setQueryConfigurationCapability` edit only the current query.
  Scope, model and tool selectors use this layer and never change the default profile.
- `appliedSavedProfile` finds the applied profile as it is saved now, or null once it is deleted.
- `resetQueryConfiguration` re-applies that saved profile. A query whose profile was deleted, or that
  has none, cannot be reset.
- `isQueryConfigurationModified` compares the query's setup with that saved profile: scope and model
  exactly, and capability IDs as sets. Capability ordering and duplicate entries do not count as modifications. Value copies
  deduplicate capability IDs so a source is offered only once.
- `snapshotQueryChatSettings` captures the selected configuration, applied profile and run mode.
  Sending does not substitute model selections, add tools or change the applied profile.
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
profile request. Its configuration uses the first configured llama server, falling back to OpenRouter
when configured, unrestricted Infumap scope, and Infumap plus configured tools enabled by default.
For OpenRouter, `chat_default_openrouter_model` supplies the initial model if set; otherwise users
choose one before chatting. Initialization does not probe models or tool servers. Unavailable
references remain saved. A server with no model configured can
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

New Query and existing chat composers share three independent controls below the input. Search shows
only Scope. Each control is a pill with an icon, sized to its content; the full setup is in its tooltip.

- **Scope** lists named Infumap scopes with coverage, exclusions and definition problems. It keeps
  the selected scope while showing **Not used** when chat's Infumap tools are disabled. **Edit scopes**
  opens the scopes page.
- **Model** opens a searchable list of model routes, with account favorites first. A provider that
  serves its own model, a llama server, is listed and labelled by its name; other routes by model, with
  the provider in the list and tooltip. Star buttons add or remove favorites without changing the query.
  The selected model's supported reasoning efforts and a **Default** option are at the bottom. Saved
  selections and favorites that disappear from the catalog remain visible with availability information.
- **Tools** shows the enabled source names, such as **Infumap + Web search**. The popup has a toggle per
  source with its description and availability. **Functions** lists function descriptions, and **Raw
  schema** their definitions. Selected missing or unavailable sources stay visible and can be disabled.

`query-configuration-labels.ts` names scopes, models and tools the same way in pills, profile summaries
and availability messages. Popups refresh their catalogs when opened; there are no refresh buttons.

An existing chat has Chat / Deep research icon buttons beside the pills; New Query keeps its Search /
Chat / Deep research selector, and its controls row starts at the input, clear of the selector's caption.
Configuration changes are disabled while a response runs or the transcript is loading.

All popups share viewport sizing, opening towards the middle of the window, outside-click and Escape
dismissal, focus return, Tab containment and arrow navigation between radio choices. The composer's
Tab cycle includes the profile shortcuts and the three controls, and skips disabled ones. Popup changes
preserve a draft being edited in the query input.

## One-click profiles

New Query and existing chat composers show pinned profiles as shortcuts above the input, in profile
order. One click applies a profile's complete setup and records it as the applied profile; the draft,
attachments, mode and account default are unchanged. Search uses only the scope, so search results have
no profile row, and New Query hides it while Search is selected but keeps its height so switching modes
does not move the input.

The applied profile's shortcut is highlighted. When the query's setup differs from that profile as saved
now, the shortcut shows a dot and inline **Reset** and **Save** actions follow it. Reset re-applies the
saved profile; clicking the highlighted shortcut does the same. Save replaces the saved profile's
configuration with the query's setup and keeps its name. An applied profile that is not pinned is shown
as an extra shortcut while it is applied. Once the applied profile is deleted, no shortcut is highlighted.

Shortcuts that do not fit move into the **Profiles** menu, whose button then reads **+N more**; widths
come from an invisible copy of the row. The applied profile always stays visible. Long names truncate,
with the full name and setup in a tooltip.

The **Profiles** menu lists every profile with a one-line summary such as "Everything · mbp · Infumap",
a check on the applied one, a short list of unavailable resources, and a pin button. Selecting a profile
applies it and closes the menu. **Save as new…** asks for a name inline and saves the query's setup as
a new pinned profile, which the query then uses. **Manage…** opens the management dialog.

Applying, Reset and Save are blocked during a response and while a historical chat's settings are
loading or failed to load; the reason is in the shortcut tooltip and the menu. Keyboard users can Tab
through the shortcuts and menu button in the composer's cycle and use Left/Right between them.

## Managing profiles

**Manage…** opens a modal dialog listing every profile in order with its summary. Each row has Up/Down
buttons, which also order the shortcuts, the name, which is renamed in place by clicking it, and buttons
to pin or unpin, make it the default, duplicate and delete. Duplicates are named by the server and start
unpinned. Delete asks for inline confirmation, naming the profile that becomes the default when the
default is deleted; the last profile cannot be deleted.

Management never changes a query's current setup or a transcript's recorded settings. Errors are shown
at the top of the dialog. Escape cancels a rename or confirmation, then closes the dialog; an account
switch closes it. Profile names share the server's trim, control-character and 120-byte UTF-8 rules,
which forms check before submitting; a name already in use is reported by the server.

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
applied and repaired. Shortcuts show a warning icon, the menu names the unavailable resources, and the
pills mark the current setup's problems with the full explanation in their tooltips. Saved references,
profile snapshots and model favorites are retained even after a provider, model, scope or tool source
disappears.

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
the first-server alias; initial profile creation resolves the first configured server into a named route.

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
| Reserve the profile row in New Query, transcript and activity geometry; none in search results | `search-item.ts`, `query-item.ts`, `Query.tsx` |
| Lock preparation and streaming; preserve snapshots across turns and reload | `chat.ts`, query runtime, chat route and transcript |
| Preserve the draft's Deep research choice when a turn is rejected before recording | `Query.tsx` submission handlers |
| Retain unavailable references; validate only resources used by the operation | `query-configuration-availability.ts`, independent pickers, Search/chat commands |
| Refuse unavailable resources instead of substituting defaults or skipping tools | chat resource preflight, backend resolution, MCP tool mapping |

Checks, run from the repository root:

```sh
npm --prefix web run typecheck
npm --prefix web run build
cargo test --manifest-path infumap/Cargo.toml
git diff --check
```

The Rust tests cover the profile operations and invariants, the user log record and migration, request
normalization, chat resource preparation and the search request. The composer UI has no automated tests.
