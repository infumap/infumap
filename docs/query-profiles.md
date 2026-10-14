# Query configuration and profiles

Search, chat and deep research share a resource configuration. It lives in the query runtime,
in each query command's `configuration`, and in each transcript turn's `settings.configuration`.
The TypeScript definition is in `web/src/items/query-configuration.ts`; the Rust definition is in
`infumap/src/web/routes/command/chat/configuration.rs`.

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
default profile are separate user preferences. Profile persistence and UI are subsequent work.

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

The general store exposes one `defaultQueryProfile` source and an explicit setter. It copies profiles
on both reads and writes. Until account persistence is implemented, the source lives in memory and is
initialized once per browser session from the server's default model, unrestricted Infumap scope,
and Infumap plus configured tools enabled by default. Unavailable configured tools are retained in
the profile. Refreshing the catalog updates availability, not the default configuration.

A new query copies this complete profile once. `configurationInitialized` distinguishes a pending
query from an explicitly applied, edited or restored setup. Commands wait for initialization, and
scope selection is disabled while it is pending. Late catalog responses never add default tools to
a selected profile. Changing the default affects future queries; existing queries keep their copies.

Transcript format version 2 uses this configuration shape. There is no migration or legacy reader.
