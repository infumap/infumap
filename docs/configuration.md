## Configuration

The first time you run Infumap, a default settings file and data folder will be created in `~/.infumap/`.

You can instruct Infumap to read the settings file from a custom location (and you can specify a custom data directory in that if you want) like so:

```
infumap -s path/to/settings.toml
```

You can also specify configuration via environment variables (prefixed with `INFUMAP_`, case insensitive). These will overwrite any values specified in the settings file. You can specify that configuration should be exclusively taken from environment variables by setting the `INFUMAP_env_only` environment variable to `true`. In this case, no `settings.toml` file will not be loaded or created.


### Image Caching

Use the `max_image_size_deviation_smaller_percent` and `max_image_size_deviation_larger_percent` config properties to define the circumstances under which an scaled image will be created and cached on the server.

`cache_max_mb` is not yet enforced - currently the cache will grow unbounded.


## Metrics

A prometheus metrics endpoint `/metrics` can be enabled by setting the `enable_prometheus_metrics` config property to `true`.

If you have deployed Infumap to a server, you should be careful not to expose this endpoint on the internet.
