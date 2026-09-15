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
id = "web_search_mcp"
url = "http://127.0.0.1:8791/mcp"
label = "Web search (MCP)"
```

Do not use `web_search` as the plugin id; that name is the built-in capability.
