## Configuration

You can specify configuration in a .toml file, or via environment variables or a combination of both.

Configuration values specified via environment variables should be prefixed with `INFUMAP_` and are case insensitive. Values specified in this way will override those in the settings file. You can specify that configuration should be exclusively taken from environment variables by setting the `INFUMAP_ENV_ONLY` environment variable to `true`. In this case, no `settings.toml` file will not be loaded or auto-created.

For documentation on each of the properties, refer to comments in the auto-generated `settings.toml` file, or [the template file](../infumap/default_settings.toml) in the source tree from which this is derived.

Configure `gpu_tools_url` to point at either the local GPU gateway or a single direct GPU tool service. Infumap calls `GET /gpu-tools` on that URL to discover supported endpoints such as `/image-extract`, `/pdf-extract`, and `/pdf-extract-caption-only`.

When configured and reported by `/gpu-tools`, the web server uses these services to maintain derived artifacts in the background: PDFs are text-extracted, images are tagged, fallback first-page PDF captions can be generated when extracted text produces no search fragments, image/PDF search fragments are generated from those artifacts, and lexical search indexes are updated after fragment or title changes.

Search is local and lexical. Full-user searches use BM25-backed title and search-fragment indexes; no embedding service is required.

Chat requires at least one language model backend: one or more llama.cpp `llama-server` instances, `openrouter_api_key`, or both. Configure each `llama-server` as a `[[llama_server]]` table with a `name`, which is what users see and pick, and a `url`, either its base URL or its full chat completions endpoint URL (`llama_servers` takes the same list as JSON, for configuration by environment variable; `llama_server_url` is shorthand for a single server named `llama-server`). Each server decides which model is loaded, so Infumap offers no model choice for it, and no reasoning effort either (llama.cpp only honours one if the loaded model's chat template happens to use it). Configure `openrouter_api_key` to offer OpenRouter's models as well. That key is instance wide - every user of the instance shares the one OpenRouter account and spends from it - and it is never sent to the browser, since Infumap calls OpenRouter server side.

The OpenRouter model list is public, fetched anonymously, and cached. Only models that support tool
calling are offered. Each model's reasoning effort choices come from that same list. If refreshing
fails, a saved catalog remains available for browsing and is labelled unverified.

`chat_default_backend` and `chat_default_openrouter_model` seed an account's first saved **Default**
query profile. `chat_default_backend` accepts `llama` (the first configured llama server),
`llama:<name>` (a specific one), or `openrouter`. Initial seeding can use another configured backend
if the configured default is unavailable; it records a specific named llama route. After the account
has profiles, changing server defaults does not rewrite them.

Users select a default saved profile in **More → Manage profiles → Make default**. New queries copy
it once. Picking a different profile or changing the model, reasoning effort, scope or tools affects
only that query; the last choice never automatically becomes the account default. Profiles and
model favorites are saved with the account and included in account backups. See
[Query profiles](chats.md#query-profiles) for the controls and
[Query configuration and profiles](query-profiles.md) for the API.

Chat requests use the explicit saved provider route, model and effort. OpenRouter requires a model
ID; a null model is only for a provider serving its own model. An unavailable selected provider,
model, scope or tool source is reported rather than replaced with a server default or silently
disabled. Search needs no model and uses only its selected scope.
