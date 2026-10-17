# MCP tools

Sidecar MCP servers spoken over Streamable HTTP.

Currently:

- `web-search` — web search and page fetch through separate endpoints in one process

Start web search:

```bash
./tools/mcp/web-search/run.sh
```

Search supports DuckDuckGo, Exa, Tavily and Diffbot. Metered providers require
their API key and an explicit monthly free allowance. Diffbot uses
`DIFFBOT_API_KEY`, `WEB_SEARCH_DIFFBOT_MONTHLY_FREE_CREDITS_CENTS` (10,000 searches
= 1,000 accounting cents), and optional reset-day and pacing settings. Its local
rate defaults to five attempts per minute with one request in flight. Confirm
your token's limits; see [provider configuration](web-search/README.md#diffbot-configured).

`run.sh` resolves Chrome/Chromium or installs official Chrome for Testing in the
user cache, once per wrapper invocation. Set `WEB_FETCH_BROWSER_PATH` for an
explicit executable; use `./tools/mcp/web-search/run.sh --update-browser` for a
deliberate managed-browser update. It never installs global packages or weakens
Chrome's sandbox. Linux additionally requires OS network confinement; native
macOS uses proxy and URL checks without an outer OS network sandbox.
Setup failures leave search usable.

Browser fetches reuse one owned browser with a fresh isolated context per request.
PDFs require `WEB_FETCH_GPU_TOOLS_URL` pointing to an updated GPU service/gateway
advertising native-only extraction and absolute request deadlines. No PDF fetch
performs OCR. Full results are cached privately outside the checkout before
`maxChars` is applied. See [fetch operations](web-search/FETCHING.md).

It listens on `127.0.0.1:8791` by default. Point Infumap at its two endpoints with:

```toml
chat_tool_servers = [
  { id = "web_search", url = "http://127.0.0.1:8791/mcp/search" },
  { id = "web_fetch", url = "http://127.0.0.1:8791/mcp/fetch", timeout_secs = 330 },
]
```

The example gives fetch 330 seconds at the MCP layer; configure
`WEB_FETCH_TIMEOUT_SECS=300` when allowing native PDF conversion that budget.
The fetch default remains 30 seconds.

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
