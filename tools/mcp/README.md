# MCP tools

Sidecar MCP servers spoken over Streamable HTTP.

Currently:

- `web-search` — web search and page fetch through separate endpoints in one process

Start web search:

```bash
./tools/mcp/web-search/run.sh
```

It listens on `127.0.0.1:8791` by default. Point Infumap at its two endpoints with:

```toml
chat_tool_servers = [
  { id = "web_search", url = "http://127.0.0.1:8791/mcp/search" },
  { id = "web_fetch", url = "http://127.0.0.1:8791/mcp/fetch" },
]
```

`/mcp/search` exposes only `infumap_web_search`; `/mcp/fetch` exposes only
`infumap_web_fetch`. Each endpoint rejects calls to the other tool. Enable either
source independently in Infumap, omit an entry to use only the other, or replace
either entry with another MCP server. There is no combined `/mcp` endpoint.

Deep research only receives MCP tools whose tool definition declares
`annotations.readOnlyHint: true`. Mark discovery, lookup, and fetch tools with
that annotation so they are available to research; mutation tools remain
available to ordinary chat under the configured approval policy.

Infumap does not start this process. If the sidecar is down, the `web_search` and
`web_fetch` sources are unavailable. There is no in-process fallback.

A musl release binary can be built with `./tools/mcp/web-search/build-musl.sh`,
which `./build-musl.sh` also runs.
