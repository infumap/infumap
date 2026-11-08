## Configuration

You can specify configuration in a .toml file, or via environment variables or a combination of both.

Configuration values specified via environment variables should be prefixed with `INFUMAP_` and are case insensitive. Values specified in this way will override those in the settings file. You can specify that configuration should be exclusively taken from environment variables by setting the `INFUMAP_ENV_ONLY` environment variable to `true`. In this case, no `settings.toml` file will not be loaded or auto-created.

For documentation on each of the properties, refer to comments in the auto-generated `settings.toml` file, or [the template file](../infumap/default_settings.toml) in the source tree from which this is derived.

### Startup maintenance

Server startup automatically migrates account logs and then compacts each `user.json` or `items.json` that
can save at least `startup_compact_min_savings_bytes` (default `1048576`, or 1 MiB). This setting must be a
positive integer; zero, negative, fractional, boolean, and out-of-range values are rejected. It can also be
supplied as `INFUMAP_STARTUP_COMPACT_MIN_SAVINGS_BYTES`. There are no
migration/compaction off switches or percentage threshold. With `enable_s3_backup = true`, account maintenance
requires a permanent snapshot of both logs before migration starts or compaction installs. Compaction
preparation/upload failure skips the optional operation; a required migration failure blocks startup. The
shared `pending_users.json` is migrated with a local previous copy and is excluded from these S3 snapshots
and automatic compaction. See [migration](cli.md#migrate), [compaction](cli.md#compact), and
[restoring maintenance archives](cli.md#restore) for recovery behavior.

Each log changed by startup maintenance keeps one local `<log-name>.previous` copy of its original input.
Migration followed by compaction preserves the pre-migration original. After a successful installation,
recognized older `.vN` migration copies for that log are removed; custom/manual copies and permanent S3
maintenance archives remain untouched. This local rotation also applies to `pending_users.json` migration.

Savings are measured from the actual candidate file after migration, independently for each account log.
Saving exactly the configured number of bytes qualifies. With the default, 100 MiB becoming 99 MiB qualifies,
while 500 KiB becoming 100 KiB does not. Candidate generation, validation, and any required upload can add startup
time proportional to the logs' size; compaction runs only on startup and does not bound growth between restarts.

With S3 backup enabled, maintenance uses the backup provider and `backup_encryption_key`, independently of
the object stores configured for file/image data. A migration chain creates one pre-chain archive; qualifying
compaction creates its own pre-compaction archive of the current pair. Neither updates regular backup tracking.
All binaries sharing the bucket must support these archive names before the first maintenance upload;
older binaries may reject them when listing backups. Existing regular backups remain readable.

Permanent archives are excluded from every Infumap automatic cleanup path, including regular backup retention.
Bucket lifecycle rules, manual deletion, and other clients remain outside that guarantee. Keep the original
archive filenames and the encryption keys used to create them. Archives consume storage until removed externally;
rotating the configured key does not re-encrypt existing archives. See [restore](cli.md#restore) for manual recovery.

Run only one Infumap binary against a data directory at a time, including offline writing commands. Logs are
replaced individually; an interruption can leave files at different schema versions. The next startup finishes
required migrations before serving. Unfinished maintenance scratch files are discarded rather than promoted.
A failure reported after the final rename may mean the new file is already installed; inspect the active log
and the reported `.previous` path before manually replacing anything.

At the default `info` log level, maintenance reports transformations and measured candidates with account/file,
schema versions, input/output bytes, bytes saved, elapsed time, archive key, and retained source where applicable.
Startup logs also show account discovery, migration requirements, each intermediate migration step, candidate
replay/validation, archive preparation/upload, per-account compaction completion/errors, and final loaded item
counts, epochs, and container sync versions. Already-current schemas, absent pending users, small-file skips,
and insufficient savings have explicit explanations at `info`, so a startup with nothing to change is visible.
Use `log_level = "debug"` or `INFUMAP_LOG_LEVEL=debug` for temporary-file paths and cleanup, per-root traversal
counts, candidate syncing, retained-source rotation/reuse, and atomic replacement details. Encryption keys and
log contents are not included in these diagnostic messages.

### GPU tools and chat

Configure `gpu_tools_url` to point at either the local GPU gateway or a single direct GPU tool service. Infumap calls `GET /gpu-tools` on that URL to discover supported endpoints such as `/image-extract`, `/pdf-extract`, and `/pdf-extract-caption-only`.

When configured and reported by `/gpu-tools`, the web server uses these services to maintain derived artifacts in the background: PDFs are text-extracted, images are tagged, fallback first-page PDF captions can be generated when extracted text produces no search fragments, image/PDF search fragments are generated from those artifacts, and lexical search indexes are updated after fragment or title changes.

Search is local and lexical. Full-user searches use BM25-backed title and search-fragment indexes; no embedding service is required.

Chat requires at least one provider speaking the OpenAI Chat Completions protocol. Configure providers
as an array of inline tables. Each has a stable `id`, which is also its display label,
an API base `url` including its version path, and an optional `api_key`:

```toml
chat_providers = [
  { id = "local", url = "http://127.0.0.1:8080/v1", discover_models = false },
  { id = "openrouter", url = "https://openrouter.ai/api/v1", adapter = "openrouter", api_key = "YOUR_KEY" },
]
```

This syntax keeps subsequent settings at the root of the TOML file. Provider IDs contain 1–64 ASCII
letters, digits, dots, underscores or hyphens. Profiles, favorites and chats store those IDs, so keep
them stable. `url` can also be the full chat completions URL. Infumap appends
`chat/completions` to the API base; it does not insert `/v1` automatically.

`discover_models` defaults to `true`: Infumap discovers models through `GET <url>/models`, using the
API key when needed, and users select an explicit model from the catalog. Generic discovery preserves
the returned order.

For a local server whose active model changes frequently, set `discover_models = false`. Infumap
never fetches its catalog and offers one **Server default** choice, sending `"model": "default"`.
The optional `model_name` changes that request ID and the displayed choice, for example:

```toml
chat_providers = [
  { id = "local", url = "http://127.0.0.1:8080/v1", discover_models = false, model_name = "my-alias" },
]
```

`model_name` must be nonblank and is only accepted when discovery is disabled. Configure the server
to accept the chosen ID or alias; Infumap sends it literally. With a stable alias, profiles continue
to work when you change the underlying model. Existing profiles with a different saved model ID
must select the new choice once. Configure only models that support tool calling: generic catalogs
may not report this capability.

The `openrouter` adapter requires discovery, rejects `discover_models = false` and `model_name`, and
never accepts `"default"` as a request model. The former `models` configuration field is rejected;
replace it with discovery or `discover_models = false` plus an optional `model_name` for a single ID.

`adapter` defaults to `openai`, using standard messages and the `reasoning_effort` parameter.
`openrouter` enables OpenRouter's catalog metadata, tool capability filtering and `reasoning`
parameter. `llama_cpp` opts into llama.cpp conversation formatting: replayed reasoning text and
conversion of later system messages to user messages. These adapters apply to entries in the same
provider list; they do not determine a provider's ID.

Optional `reasoning_efforts` declares the supported effort levels for every model on a provider,
for example `["none", "low", "medium", "high"]`. Otherwise discovered reasoning metadata supplies
the choices; a model without such metadata offers only Default. Disabling discovery also skips
capability metadata, so declare efforts if needed. Supported levels are `none`, `minimal`, `low`,
`medium`, `high`, `xhigh` and `max`; only declare values the endpoint accepts.

`chat_providers` can also be supplied as a JSON string through `INFUMAP_CHAT_PROVIDERS`. Likewise,
`chat_tool_servers` accepts a TOML array or a JSON string through `INFUMAP_CHAT_TOOL_SERVERS`.
For example:

```sh
export INFUMAP_CHAT_PROVIDERS='[{"id":"local","url":"http://127.0.0.1:8080/v1","api_key":"YOUR_KEY","discover_models":false}]'
export INFUMAP_CHAT_TOOL_SERVERS='[{"id":"web_search","url":"http://127.0.0.1:8791/mcp/search"},{"id":"web_fetch","url":"http://127.0.0.1:8791/mcp/fetch"}]'
```

The standalone IMWebSearch MCP server exposes `web_search` at `/mcp/search` and
`web_fetch` at `/mcp/fetch`. Configure them as separate entries so search
and fetch can each be selected or replaced independently. Each entry's stable `id` also serves as its
display label; omit either entry if it is not needed.

Infumap requests up to 5 web-search results in Chat and 10 in Deep research through the tool's
advertised `maxResults` argument. Infumap supplies this argument itself; the model does not choose
the result count. In Chat, Infumap adds a reminder after four web searches in a user turn, without
enforcing a search limit. Call counts, mode and model stay in Infumap; no Infumap-specific MCP metadata
is sent. With LLM logging enabled, tool-call context is recorded in `/tmp/llm.txt`.

IMWebSearch is a separate project, typically checked out alongside Infumap. Start it with
`./run.sh` from its own directory; Infumap does not start it. See its
[integration guide](../../imwebsearch/INFUMAP.md) for setup. Provider credentials, browser setup
and native PDF extraction are configured in `~/.imwebsearch/config.toml`. Set Infumap's fetch
`timeout_secs` above the whole IMWebSearch fetch budget, for example 330 seconds for a
300-second sidecar budget.

Deep research only receives MCP tools declaring `annotations.readOnlyHint: true`.

Tool execution follows the query profile's **Tool approvals** policy. `automatic` asks before
external requests when Infumap tools are enabled or the chat contains attachments;
`always_ask` asks before every tool call. This uses the current Infumap setting, without tracking
earlier Infumap retrieval after tools are disabled. Retained chat attachments still require approval.
Existing profiles migrate to Always ask; newly initialized profiles use Automatic.

Each `chat_tool_servers` entry also accepts:

- `require_approval` (default `false`): set `true` to require approval regardless of the profile.
  Previously omitted values required approval; they now follow the profile. Explicit `true` values
  remain mandatory. Explicit `false` does not bypass the profile's privacy rule or Always ask.
- `external_requests` (default `true`): the source may forward tool arguments to external services.
  Set `false` only for a trusted source that keeps arguments inside the trusted environment.
  The classification comes from server configuration, never from tool descriptions or read-only hints.

The web-search sidecar remains external even when its MCP endpoints listen on localhost, because it
sends queries and URLs to web services. Discovery includes both settings so the Tools picker can show
external disclosure and mandatory approval requirements.

API keys are instance wide: every user shares the configured credentials and any associated spending.
They are sent as Bearer tokens by the server and are never included in the browser's provider catalog.

Discovered catalogs are cached separately for each provider configuration: five minutes for generic
providers, six hours for OpenRouter. OpenRouter's public catalog is fetched anonymously and provides
model names, context sizes, prices and reasoning choices. If refreshing fails, the last successful
catalog remains available for browsing and is labelled unverified. A failed or stale discovery cannot
establish that a saved model disappeared; its explicit selection can still be tried at the provider.

An account's first saved **Default** query profile uses the first provider with an available model,
then that provider's first model, in configuration/catalog order. Discovery runs outside the database
lock. If no model can be found, the profile can still be used for Search; users choose a model before Chat.
Changing server configuration does not rewrite existing profiles.
The old `llama_server`, `llama_servers`, `llama_server_url`, `openrouter_api_key`, `chat_default_backend`
and `chat_default_openrouter_model` settings are ignored, like other unrecognized settings.

Users choose the default profile in **Profiles → Manage…**. New queries copy
it once. Picking a different profile or changing the model, reasoning effort, scope or tools affects
only that query; the last choice never automatically becomes the account default. Profiles and
model favorites are saved with the account and included in account backups. See
[Query profiles](chats.md#query-profiles) for the controls.

Chat requests use the explicit saved provider ID, model ID and effort. With discovery disabled, the
saved model ID is `model_name` (default `"default"`), and the provider resolves it to the actual model.
An unavailable selected provider, model, scope or tool source is reported rather than replaced with a server default or silently
disabled. Search needs no model and uses only its selected scope.
