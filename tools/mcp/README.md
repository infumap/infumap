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

`/mcp/search` exposes only `web_search`; `/mcp/fetch` exposes only
`web_fetch`. Each endpoint rejects calls to the other tool. Enable either
source independently in Infumap, omit an entry to use only the other, or replace
either entry with another MCP server. There is no combined `/mcp` endpoint.

Deep research only receives MCP tools whose tool definition declares
`annotations.readOnlyHint: true`. Mark discovery, lookup, and fetch tools with
that annotation so they are available to research; mutation tools remain
available to ordinary chat under the configured approval policy.

Profiles select **Automatic** or **Always ask** tool approvals for both Chat and Deep research.
Automatic asks before external calls when Infumap tools are enabled or the chat contains
attachments; otherwise calls run automatically. Approval uses the current Infumap setting without
tracking earlier retrieval after tools are disabled; retained attachments still require approval.
All MCP sources default to `external_requests = true`, including the localhost web sidecar.
Only trusted internal sources should set it to `false`. Tool annotations
cannot change this classification. Set `require_approval = true` on a source to always require
approval, regardless of the profile; omitted or false values follow the profile's rules.

Infumap does not start this process. If the sidecar is down, the `web_search` and
`web_fetch` sources are unavailable. There is no in-process fallback.

A musl release binary can be built with `./tools/mcp/web-search/build-musl.sh`,
which `./build-musl.sh` also runs.
