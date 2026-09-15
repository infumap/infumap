# MCP tools

Sidecar MCP servers spoken over Streamable HTTP.

Currently:

- `web-search` — DuckDuckGo search and page fetch, previously built into the Infumap binary

Start web search:

```bash
./tools/mcp/web-search/run.sh
```

It listens on `http://127.0.0.1:8791/mcp` by default. Infumap does not call this
server yet; that wiring is a later change.
