## Configuration

You can specify configuration in a .toml file, or via environment variables or a combination of both.

Configuration values specified via environment variables should be prefixed with `INFUMAP_` and are case insensitive. Values specified in this way will override those in the settings file. You can specify that configuration should be exclusively taken from environment variables by setting the `INFUMAP_ENV_ONLY` environment variable to `true`. In this case, no `settings.toml` file will not be loaded or auto-created.

For documentation on each of the properties, refer to comments in the auto-generated `settings.toml` file, or [the template file](../infumap/default_settings.toml) in the source tree from which this is derived.

The GPU tool endpoint names shown in the settings template examples are `/image-extract`, `/text-embed`, and `/pdf-extract`. These optional service URLs are unset by default. The local GPU gateway also keeps `/embed` and `/convert` as legacy aliases. When `image_tagging_url` is configured, the PDF fragment pipeline can also use the sibling `/pdf-extract-caption-only` endpoint as a fallback for PDFs whose extracted text produces no fragments.

When configured, the web server uses these services to maintain derived artifacts in the background: PDFs are text-extracted, images are tagged, image/PDF fragments are generated from those artifacts, and fragment search indexes are reconciled after fragment or title changes.

`text_embedding_url` is used to embed fragment content for vector indexes and full-user search queries for semantic lookup. If it is unset, semantic fragment search is disabled, but exact title search and lexical title/document-fragment search can still work when their indexes exist.
