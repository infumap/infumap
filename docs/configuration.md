## Configuration

You can specify configuration in a .toml file, or via environment variables or a combination of both.

Configuration values specified via environment variables should be prefixed with `INFUMAP_` and are case insensitive. Values specified in this way will override those in the settings file. You can specify that configuration should be exclusively taken from environment variables by setting the `INFUMAP_ENV_ONLY` environment variable to `true`. In this case, no `settings.toml` file will not be loaded or auto-created.

For documentation on each of the properties, refer to comments in the auto-generated `settings.toml` file, or [the template file](../infumap/default_settings.toml) in the source tree from which this is derived.

The GPU tool endpoint names used by the default settings are `/image-extract`, `/text-embed`, and `/pdf-extract`. The local GPU gateway also keeps `/tag`, `/embed`, and `/convert` as legacy aliases.

`text_embedding_url` is used by `infumap embed`, semantic search in the web server, and web background vector index generation when configured. If it is unset, search still works, but only exact title search is used, and background lexical fragment indexing can still run without vector embeddings.
