# MCP tools

Sidecar MCP servers spoken over Streamable HTTP.

Currently:

- `web-search` — DuckDuckGo search and page fetch, previously built into the Infumap binary

Start web search:

```bash
./tools/mcp/web-search/run.sh
```

It listens on `http://127.0.0.1:8791/mcp` by default. Point Infumap at it with:

```toml
[[chat_tool_server]]
id = "web_search"
url = "http://127.0.0.1:8791/mcp"
label = "Web search"
```

Infumap does not start this process. If the sidecar is down, the Web search
checkbox is greyed out. There is no in-process fallback.

A musl release binary can be built with `./tools/mcp/web-search/build-musl.sh`,
which `./build-musl.sh` also runs.
