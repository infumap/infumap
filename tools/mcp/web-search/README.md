# Web search MCP server

Streamable HTTP MCP server exposing Infumap's DuckDuckGo search and page-fetch
tools. Bind is `127.0.0.1` by default.

## Run

From the repo root:

```bash
./tools/mcp/web-search/run.sh
```

Or, after `cargo build --release` in this directory:

```bash
./target/release/infumap-web-search
```

Environment:

- `WEB_SEARCH_HOST` (default `127.0.0.1`)
- `WEB_SEARCH_PORT` (default `8791`)
- `WEB_SEARCH_BIN` — path to a prebuilt binary; skips `cargo build`
- `WEB_SEARCH_RESTART_DELAY_SECS` (default `5`) — used by `run.sh` only

The MCP endpoint is `http://$WEB_SEARCH_HOST:$WEB_SEARCH_PORT/mcp`.

## Inspector

With the server running:

```bash
npx @modelcontextprotocol/inspector http://127.0.0.1:8791/mcp
```

Methods implemented: `initialize`, `notifications/initialized`, `tools/list`,
`tools/call`, `ping`. Responses are JSON only (no SSE). Auth is not implemented;
this is a localhost sidecar.

## Tools

- `web_search` — `{ query, numResults? }`
- `fetch_page` — `{ url, maxChars? }`

`fetch_page` refuses loopback, link-local, and metadata addresses.
