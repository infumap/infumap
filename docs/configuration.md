## Configuration

You can specify configuration in a .toml file, or via environment variables or a combination of both.

Configuration values specified via environment variables should be prefixed with `INFUMAP_` and are case insensitive. Values specified in this way will override those in the settings file. You can specify that configuration should be exclusively taken from environment variables by setting the `INFUMAP_ENV_ONLY` environment variable to `true`. In this case, no `settings.toml` file will not be loaded or auto-created.

For documentation on each of the properties, refer to comments in the auto-generated `settings.toml` file, or [the template file](../infumap/default_settings.toml) in the source tree from which this is derived.

Configure `gpu_tools_url` to point at either the local GPU gateway or a single direct GPU tool service. Infumap calls `GET /gpu-tools` on that URL to discover supported endpoints such as `/image-extract`, `/text-embed`, `/pdf-extract`, and `/pdf-extract-caption-only`. The local GPU gateway also keeps `/embed` and `/convert` as legacy aliases.

Configure `text_embed_url` to point at a standalone text embedding service when it should be used instead of any `text_embed` endpoint discovered from `gpu_tools_url`.

When configured and reported by `/gpu-tools`, the web server uses these services to maintain derived artifacts in the background: PDFs are text-extracted, images are tagged, fallback first-page PDF captions can be generated when extracted text produces no fragments, image/PDF fragments are generated from those artifacts, and fragment search indexes are reconciled after fragment or title changes.

The configured `text_embed_url`, or otherwise the discovered `text_embed` endpoint, is used to embed fragment content for vector indexes and full-user search queries for semantic lookup. If no text embedding endpoint is configured or reported, semantic fragment search is disabled, but exact title search and lexical title/document-fragment search can still work when their indexes exist.

Chat requires at least one language model backend: `llama_server_url`, `openrouter_api_key`, or both. Configure `llama_server_url` to point at a llama.cpp `llama-server`, either its base URL or its full chat completions endpoint URL; that server decides which model is loaded, so Infumap offers no model choice for it, and no reasoning effort either (llama.cpp only honours one if the loaded model's chat template happens to use it). Configure `openrouter_api_key` to offer OpenRouter's models as well. That key is instance wide - every user of the instance shares the one OpenRouter account and spends from it - and it is never sent to the browser, since Infumap calls OpenRouter server side.

The OpenRouter model list is fetched anonymously, as it is public, and cached, and only models that support tool calling are offered, because Chat cannot search your workspace or the web without them. Each model's reasoning effort levels come from that same list, so the effort a user can pick depends on the model they picked. `chat_default_backend` and `chat_default_openrouter_model` set what a new chat starts with; users can choose a different backend, model and effort per chat, and their last choice becomes their own default. If the chosen default backend is not configured the other one is used instead.
