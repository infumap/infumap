# Web search MCP server

Streamable HTTP MCP server exposing Infumap's web-search and page-fetch tools.
Bind is `127.0.0.1` by default. Search providers require configuration;
DuckDuckGo currently serves searches, while Exa configuration prepares for its
upcoming adapter.

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

## Search provider configuration

Configuration is read from the process environment once at startup. Restart the
server after changing it. The server does not load `.env` files automatically.
Malformed settings stop startup; errors do not include their values or API keys.
Unset or whitespace-only values use the defaults below.

| Variable | Default | Meaning |
| --- | --- | --- |
| `WEB_SEARCH_DUCKDUCKGO_ENABLED` | `false` | Explicitly enable the undocumented DuckDuckGo HTML endpoint. Accepts `true` or `false`. |
| `EXA_API_KEY` | Unset | A nonempty API key configures Exa. No separate enable flag is needed. |
| `WEB_SEARCH_EXA_MONTHLY_FREE_CREDITS_CENTS` | `0` | Monthly free allowance in integer US cents, not request counts. Zero means no assumed free capacity. |
| `WEB_SEARCH_EXA_MONTHLY_PAID_LIMIT_CENTS` | `0` | Maximum additional paid usage per monthly period, in integer US cents. Zero specifies free-only usage. |
| `WEB_SEARCH_EXA_MONTHLY_RESET_DAY` | `1` | Day of month, from 1 through 31, when the configured budget resets at 00:00 UTC. Days beyond the end of a month mean that month's last day. |

Set the allowance and reset day to match the user's actual account. Advertised
free-tier amounts are deliberately not built into the configuration. One-time
trial or onboarding credits are not recurring monthly allowances.

**Implementation status:** provider configuration, preference and the common
provider interface with a DuckDuckGo adapter are implemented.
The Exa adapter, usage reporting, persistent accounting, budget enforcement and
automatic fallback are subsequent steps. An Exa key does not currently cause
Exa requests. Startup logs warn about this when Exa is configured. The budget
settings define the policy for that implementation; they do not yet enforce
provider-side billing limits.

To use the currently available search provider:

```bash
export WEB_SEARCH_DUCKDUCKGO_ENABLED=true
./tools/mcp/web-search/run.sh
```

To prepare Exa configuration, export `EXA_API_KEY` through your environment or
secret manager and set the monthly allowance. For example, **if your account
provides $10 in recurring monthly credits**:

```bash
export WEB_SEARCH_EXA_MONTHLY_FREE_CREDITS_CENTS=1000
export WEB_SEARCH_EXA_MONTHLY_PAID_LIMIT_CENTS=0
export WEB_SEARCH_EXA_MONTHLY_RESET_DAY=1
```

With no providers configured, `web_search` returns a configuration error and
`fetch_page` remains available. With only Exa configured, `web_search` explains
that its adapter is not implemented yet. Existing installations must explicitly
set `WEB_SEARCH_DUCKDUCKGO_ENABLED=true` to continue using DuckDuckGo.

### Selection policy for the upcoming router

Only configured providers participate. Exa is the preferred metered provider;
DuckDuckGo, when explicitly enabled, is the fallback. DuckDuckGo has unknown
capacity and is excluded from monthly allowance comparisons.

As more metered providers are added, the router will first exclude providers
that cannot satisfy the request, are unhealthy, are cooling down or lack budget
for the estimated request cost. It will then prefer the highest remaining free
allowance percentage. Unknown allowance is not treated as full capacity. Paid
capacity is used only when no eligible free capacity or enabled DuckDuckGo
fallback remains, and only within an explicitly configured paid limit.

Provider usage reporting will reconcile local estimates. Reservations for
concurrent requests and persistent consumption tracking are required before
automatic metered requests are enabled. A successful empty search is a result,
not an automatic trigger to spend credits on every provider. Fallback attempts
and total request time will be bounded.

### Provider adapters

`src/providers/mod.rs` defines the `SearchProvider` interface. Adapters provide
normalized title, URL and snippet results, a local request-cost estimate, and
optional asynchronous usage reporting. The interface supports different
adapters behind a shared trait object. Configuration and provider selection
remain outside the adapters, in the search layer.

Monetary estimates and usage snapshots use integer millionths of a US dollar
so individual requests do not round to whole cents. Configuration allowances
remain expressed in cents. DuckDuckGo reports an unmetered cost and unsupported
usage reporting (`None`); neither implies unlimited request capacity.

Provider errors distinguish rate limits, exhausted quota, invalid credentials,
transient failures, invalid requests, bot blocking, unexpected responses and
internal errors. DuckDuckGo classifies HTTP failures and bot challenges, and
retains delta-seconds `Retry-After` values when supplied. Error classification
and usage metadata are internal; the MCP tool continues to return the existing
compact results and text errors. Retries, cooldowns and budget enforcement will
be implemented by the router.

## Infumap configuration

Point Infumap at it:

```toml
[[chat_tool_server]]
id = "web_search"
url = "http://127.0.0.1:8791/mcp"
label = "Web search"
```

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
