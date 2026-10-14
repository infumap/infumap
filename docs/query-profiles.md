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
  or `llama:<configured server name>`. A null model ID leaves model selection to that provider;
  a null reasoning effort uses the model's default. A null selection object means no model has
  been chosen, such as before the default profile loads or in Search. Chat execution requires a selection;
  the composer copies the default profile before the first command and sends the selected resources exactly.
- `capabilities`: enabled capability IDs: `infumap_data` and configured MCP server IDs.
  Array order has no meaning. Search ignores model and capability settings.

Search / Chat / Deep research is an operation, stored separately from the resource configuration.
`QueryChatSettings` (Rust `TurnSettings`) is shared by chat requests and transcript settings.
It carries `mode` and `appliedProfile` alongside `configuration`. `appliedProfile` is the copied
profile as applied, or `null` for a query without a profile; execution uses `configuration`.

## Profiles and snapshots

A `QueryProfile` has `id`, `name`, and `configuration`. Pinning, ordering, model favorites and the
default profile are account preferences stored with the profiles. Profile selection and management UI is subsequent work.

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
the ordered profile array, and preferences (`defaultProfileId`, ordered `pinnedProfileIds`, and
`modelFavorites`). A model favorite identifies a provider/model pair, independent of reasoning effort.
This data is written through the user database log and is included in existing account backups.
Profile changes mark the account dirty so they trigger the next scheduled backup even without item edits.

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
| `update` | `id`, `name`, `configuration` |
| `duplicate` | `id`, `name` |
| `delete` | `id`, optional `replacementDefaultProfileId` |
| `reorder` | `profileIds`, an exact permutation of all profiles |
| `setPinned` | `profileIds`, an ordered, distinct subset |
| `setDefault` | `id` |
| `setModelFavorites` | `favorites`, distinct provider/model pairs in the desired order |

Every request includes `expectedUserId`, which must match the authenticated session. It is an
account-switch guard, not an ownership selector. Mutations also require `expectedRevision`.
Profiles are resolved only within that session's account; no operation accepts an owner to act on.

The response contains `userId`, `collection`, `conflict`, nullable `error`, and nullable `profileId`.
A revision conflict returns the current collection without applying the mutation. Validation failures
also return an unchanged collection and a specific error. Database failures use the ordinary command
failure response. Successful mutations increment the revision and persist profiles and preferences
together. Deleting the default requires a different saved replacement; deleting the last profile is
rejected. Deletion removes its pin but leaves conversation snapshots intact.

`StoreProvider_QueryProfiles.ts` exposes loading/refresh and all mutation operations. It serializes
local mutations, refreshes the saved state on conflicts, and reports the conflict without retrying
the rejected action. Returning to the app refreshes account preferences across tabs/devices while
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
Search / Chat / Deep research mode selector. Model changes are disabled while a response runs. Tool
choices remain fixed after a chat has content until the later work to enable changes between turns.

All three popup controls share viewport sizing, outside-click dismissal, Escape dismissal, focus return,
Tab containment and arrow navigation between radio choices. New Query's control cycle includes Scope,
Model and Tools and skips disabled controls. Popup changes preserve a draft being edited in the query input.
