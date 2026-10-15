# Web search MCP server

Streamable HTTP MCP server exposing Infumap's web-search and page-fetch tools.
Bind is `127.0.0.1` by default. DuckDuckGo is enabled by default with no API key
required. Configured Exa and DuckDuckGo providers serve searches through
budget-aware routing and bounded fallback.

## Run

Requires Rust 1.89 or newer (standard-library file locking).

From the repo root:

```bash
./tools/mcp/web-search/run.sh
```

Or, after `cargo build --release` in this directory:

```bash
./target/release/infumap-web-search
```

`run.sh` runs `cargo build --release` on each launch and stops if the build fails.
Cargo reuses unchanged build artifacts. The wrapper restarts an exited server
after the configured delay without rebuilding; startup configuration errors will
repeat until corrected. Run the binary directly when diagnosing a single startup
attempt.

Environment:

- `WEB_SEARCH_HOST` (default `127.0.0.1`)
- `WEB_SEARCH_PORT` (default `8791`)
- `WEB_SEARCH_RESTART_DELAY_SECS` (default `5`) — used by `run.sh` only

The MCP endpoints share one process and port:

- `http://$WEB_SEARCH_HOST:$WEB_SEARCH_PORT/mcp/search` exposes only `web_search`.
- `http://$WEB_SEARCH_HOST:$WEB_SEARCH_PORT/mcp/fetch` exposes only `web_fetch`.

Each endpoint advertises and accepts only its own tool. There is no combined
`/mcp` endpoint or alias for the previous tool names.

## Search provider configuration

Configuration is read from the process environment once at startup. Restart the
server after changing it. The server does not load `.env` files automatically.
Malformed settings stop startup; errors do not include their values or API keys.
Unset or whitespace-only values use the defaults below.

| Variable | Default | Meaning |
| --- | --- | --- |
| `WEB_SEARCH_DUCKDUCKGO_ENABLED` | `true` | Enable the undocumented DuckDuckGo HTML endpoint. Set `false` to disable it. Accepts `true` or `false`. |
| `EXA_API_KEY` | Unset | A nonempty API key configures Exa. No separate enable flag is needed. |
| `WEB_SEARCH_STATE_DIR` | See below | Absolute directory for persistent budget state. |
| `WEB_SEARCH_EXA_ACCOUNT_ID` | `default` | Stable local account label, shared across API keys belonging to the same Exa account. |
| `WEB_SEARCH_EXA_MONTHLY_FREE_CREDITS_CENTS` | `0` | Monthly free allowance in integer US cents, not request counts. Zero means no assumed free capacity. |
| `WEB_SEARCH_EXA_MONTHLY_PAID_LIMIT_CENTS` | `0` | Maximum additional paid usage per monthly period, in integer US cents. Zero specifies free-only usage. |
| `WEB_SEARCH_EXA_MONTHLY_RESET_DAY` | `1` | Day of month, from 1 through 31, when the configured budget resets at 00:00 UTC. Days beyond the end of a month mean that month's last day. |
| `WEB_SEARCH_EXA_INITIAL_USED_CENTS` | `0` | Usage already incurred in the current period, in integer US cents. Applied only when this account is first added to the ledger. |

Set the allowance and reset day to match the user's actual account. Advertised
free-tier amounts are deliberately not built into the configuration. One-time
trial or onboarding credits are not recurring monthly allowances.

Provider configuration, persistent accounting, routing and the common provider
interface with DuckDuckGo and Exa adapters are implemented. Startup
prepares configured clients and validates credential header syntax locally,
without contacting providers. The Exa adapter is wrapped in persistent budget
accounting that reserves capacity before any metered request can be dispatched.
The router selects eligible providers automatically and falls back after
failures. Startup logs report configured preferences and the local budget
balance. These are local estimates, not provider-side billing controls.

### No API keys

With no API keys or provider settings, starting the server enables DuckDuckGo:

```bash
./tools/mcp/web-search/run.sh
```

From this directory, use `./run.sh`. DuckDuckGo uses its undocumented HTML
endpoint and can be throttled or blocked. It has unknown capacity; unmetered
accounting does not guarantee availability.

To turn DuckDuckGo off and run without a search provider, even if the shell
already has an Exa key:

```bash
env -u EXA_API_KEY WEB_SEARCH_DUCKDUCKGO_ENABLED=false ./tools/mcp/web-search/run.sh
```

The server starts and `web_fetch` remains available. `web_search` returns a
short MCP tool error saying search is unavailable. `/status` shows
`search_available: false`, both providers disabled, and a configuration error.
No metered budget directory is created. Other malformed environment settings
still prevent startup, even when their provider is disabled.

### Exa configured

Export `EXA_API_KEY` through your environment or secret manager and set the
monthly allowance. For example, **if your account provides $10 in recurring
monthly credits**, for Exa alone:

```bash
export WEB_SEARCH_DUCKDUCKGO_ENABLED=false
export WEB_SEARCH_EXA_MONTHLY_FREE_CREDITS_CENTS=1000
export WEB_SEARCH_EXA_MONTHLY_PAID_LIMIT_CENTS=0
export WEB_SEARCH_EXA_MONTHLY_RESET_DAY=1
# Set this to the current period's usage before this tool starts tracking it:
export WEB_SEARCH_EXA_INITIAL_USED_CENTS=0
./tools/mcp/web-search/run.sh
```

Set the actual reset day and prior usage for your account before launching.
Keep `WEB_SEARCH_EXA_ACCOUNT_ID` stable across key rotation and preserve the
state directory. In a container, set `WEB_SEARCH_STATE_DIR` to an absolute path
on persistent storage. Startup prepares the client and ledger without verifying
the key with Exa. `/status` reports local eligibility, not confirmation that a
provider will accept a request; the actual Exa balance remains unknown.

A key without a configured free or paid allowance cannot spend credits.
DuckDuckGo fallback is enabled by default. To restore it after the Exa-only
example above, unset `WEB_SEARCH_DUCKDUCKGO_ENABLED` or set it to `true` before launch.
Free Exa capacity is preferred, then enabled DuckDuckGo, then any explicitly
configured paid Exa capacity. Configuration changes require a server restart.

### Exhausted credits and invalid credentials

Inspect `/status` and server diagnostics to distinguish local budget limits from
provider failures. Availability there refers to the five-result reference request;
a request for more results may need a larger budget.

| Condition | Behavior and recovery |
| --- | --- |
| Exa key set, allowances left at zero | Exa is enabled but has insufficient local budget. Configure the account's actual allowance and reset schedule, then restart. |
| Local remaining capacity is below the estimated request cost | Exa is skipped without sending a request. DuckDuckGo can serve the call unless disabled. Smaller requests may still fit; otherwise the configured monthly reset restores the local allowance. |
| Exa returns HTTP 402 | The router records remote quota exhaustion. A zero-capacity cap is persisted until the configured monthly reset, and enabled DuckDuckGo can serve as fallback. Restarting or increasing the local allowance does not clear this cap. |
| Exa returns HTTP 401 | The provider is disabled until restart. Correct `EXA_API_KEY` in the launch environment and restart using the same account label and ledger. Enabled DuckDuckGo can serve as fallback. |
| Exa returns HTTP 403 or 429 | These are classified as blocking or rate limiting, respectively. Status shows a cooldown; routing can use enabled DuckDuckGo while Exa is unavailable. |
| API key contains invalid HTTP header characters | Initialization fails before binding the server, including when DuckDuckGo is enabled. Correct the key; inspect stderr because `/status` cannot be served. |
| Ledger is unreadable, invalid or already locked by another process | Initialization fails. Repair the storage or stop the other ledger owner, then restart while preserving accounting history. |
| A ledger write fails during operation | Further metered dispatch is blocked. Status shows the persistence error; repair storage and restart. An enabled DuckDuckGo remains eligible. |

There is no command to refresh an Exa balance or clear a remote exhaustion cap
after topping up credits mid-period. This implementation continues honoring the
cap until its configured reset. DuckDuckGo can serve as fallback in the meantime
unless disabled. Changing the reset day of an existing account is rejected.

Attempts with uncertain billing, including HTTP 401 and 402, conservatively commit
their reserved cost. Correcting a key and restarting preserves that consumption.
When fallback succeeds, the MCP result contains that provider's normal results;
logs and `/status` expose failures of the earlier provider. If no provider can
serve the call, `web_search` returns `isError: true` with a short unavailability
message. Provider failure and skip reasons remain in server logs and local status.
A successful empty result does not trigger fallback.

### Provider selection and fallback

Only configured providers participate. Exa is the preferred metered provider;
DuckDuckGo, enabled by default, is the fallback. DuckDuckGo has unknown
capacity and is excluded from monthly allowance comparisons.

The router excludes providers that have already been attempted for this call,
cannot satisfy the request, are disabled or cooling down, or lack enough budget
for the estimated cost. It prefers eligible metered providers with the highest
remaining free allowance percentage, then enabled unmetered providers, then
explicitly configured paid capacity. Unknown allowance is not treated as full
capacity. Equal percentages and paid/unmetered providers use registration order.
The same rule applies as more adapters are registered; the router does not
contain provider-specific selection branches.

Provider usage reporting can conservatively reconcile local estimates. Durable
reservations and consumption tracking are implemented. A successful empty search
is a result, not a trigger to spend credits on another provider. Each provider
is attempted at most once per call, with at most three attempts in total
(currently at most two because only two providers are supported). Provider
attempts have a 20-second timeout within a shared 30-second request deadline.
The shared deadline covers selection, health-lock waits, budget-worker waits,
reservations, provider HTTP and settlement. Runtime ledger operations run in
blocking workers, and health locks are asynchronous, so slow storage cannot hold
the search response past its deadline. A timed-out request stops waiting;
an already-started storage operation can finish in the background. No provider
request is dispatched for a reservation that completes after its deadline.
Fallback happens immediately without sleeping through cooldowns, and an already
attempted Exa provider is not tried again with paid capacity after a free attempt
fails. Budget reservations are checked again at dispatch to handle concurrent
requests consuming capacity after selection.

Invalid credentials disable a provider until restart after correcting its
configuration. Internal adapter/accounting failures also disable it until repair
and restart. Provider-reported quota exhaustion suspends a metered account until
its configured monthly reset; the zero-capacity cap is persisted with settlement
and survives restarts. A local request whose cost does not fit is distinguished
from remote exhaustion, so a smaller later request can still use the remainder.
Providers without a known quota reset are disabled until restart after replenishment.

Rate limits use the provider's delta-seconds `Retry-After`, or 60 seconds when it
is absent. Bot blocking defaults to 15 minutes. Transient failures back off from
2 seconds up to 5 minutes; unexpected responses use at least 15 seconds. A
supplied `Retry-After` overrides these defaults, with a minimum of one second.
Overlapping cooldowns retain the later deadline. Only one recovery probe can run
after a cooldown or quota suspension, and a late success from an older request
cannot clear a newer failure. Invalid requests do not disable a provider for
other queries. Client cancellation conservatively charges metered reservations
whose dispatch began and records a transient health failure. Reservations known
not to have dispatched are released asynchronously.

Cooldowns and credential/internal-error suspensions are kept in memory. Monthly
metered quota caps and consumption are persistent. Failed calls report a short
unavailability message in the existing MCP text-error format. Routing choices
are available in debug logs (`RUST_LOG=debug`); queries and API keys are not
included in routing log messages.

### Local provider status

Inspect the running server without spending search credits:

```bash
curl http://127.0.0.1:8791/status
```

`GET /status` returns JSON showing both supported providers, whether each is
enabled, reasons it is unavailable, local budget balances, monthly boundaries,
cooldowns, suspensions, requests in flight and usage-reporting state. Availability
and `funding` are evaluated for a reference search requesting five results;
`funding` identifies the budget class that fits even if health currently prevents
dispatch. Actual eligibility can change with result count and concurrent requests.
`search_available` reports whether at least one provider can currently serve that
reference request. An unavailable search service still returns HTTP 200 so its
diagnostics can be inspected; failure to obtain status returns HTTP 503.

All monetary values are integer USD micros (1,000,000 = $1). `budget` contains
configured allowances, effective free/total remaining capacity, consumed estimates
and outstanding reservations. `period_start`, `period_end`, `quota_resets_at`,
`generated_at` and usage observation/reset times are Unix seconds in UTC.
`cooldown_remaining_ms` is the remaining delay in milliseconds.

`usage.state` is `not_checked`, `unsupported`, `reported` or `error`.
`usage.last_report`, when present, is the last provider observation, timestamped
separately from the latest refresh attempt; it can be stale after a failure or
monthly reset. Exa and DuckDuckGo currently report `unsupported`, so their actual
remaining account capacity is unknown. Local estimates are not reported balances.
`budget.adjusted_remaining_cap_usd_micros` is a conservative cap reduced by local
charges (or set to zero on remote exhaustion), before outstanding reservations
are subtracted; it is not a raw provider balance. Null caps mean no known cap.
Provider reports can only constrain the locally configured budget.

Status inspection makes no provider requests and does not write the ledger or
change routing health. Monthly rollover is projected on a copy. After a budget
write failure, the last in-memory balance remains inspectable with a persistence
error and the provider marked unavailable; that balance may differ from disk.
The response omits API keys, account labels, state paths and search queries and
uses `Cache-Control: no-store`. Access requires a loopback TCP peer even when
`WEB_SEARCH_HOST` binds to a broader interface; nonlocal browser origins are
rejected. This operator endpoint is separate from the MCP tools.

Unconfigured providers include the setting needed to enable them. No enabled
providers is also reported under `configuration_errors`. Malformed environment
settings, invalid credential header syntax and unreadable ledgers still stop
startup, so their diagnostics appear on stderr before an endpoint can be served.
Usage refresh errors and disabled providers appear in their individual status.

Use `RUST_LOG=infumap_web_search=debug` to log routing choices, budget reservations,
settlements (including cancellation) and provider usage adjustments. These messages
include provider names and numeric accounting details without API keys or queries.

### Provider adapters

`src/providers/mod.rs` defines the `SearchProvider` interface. Adapters provide
normalized title, URL and snippet results, a local request-cost estimate,
an optional response-reported request-cost estimate, and
optional asynchronous usage reporting. The interface supports different
adapters behind a shared trait object. Configuration remains in the search
layer; provider selection and health tracking are in `src/router.rs`.

Monetary estimates and usage snapshots use integer millionths of a US dollar
so individual requests do not round to whole cents. Configuration allowances
remain expressed in cents. DuckDuckGo reports an unmetered cost and unsupported
usage reporting (`None`); neither implies unlimited request capacity.

Provider errors distinguish rate limits, exhausted quota, invalid credentials,
transient failures, invalid requests, bot blocking, unexpected responses and
internal errors. DuckDuckGo classifies HTTP failures and bot challenges, and
retains delta-seconds `Retry-After` values when supplied. Error classification
and usage metadata are internal; the MCP tool continues to return the existing
compact results and text errors. Cooldowns and fallback are coordinated by
the router; durable budget enforcement is provided by the accounting wrapper.

### Persistent budget accounting

State is stored in `WEB_SEARCH_STATE_DIR`, or by default in
`$XDG_STATE_HOME/infumap-web-search` when `XDG_STATE_HOME` is set, otherwise
`$HOME/.local/state/infumap-web-search`. The directory must be absolute. It is
created only when a metered provider is configured. Preserve it across restarts
and container deployments; changing or deleting it discards accounting history.

`budget.json` records provider/account labels, configured allowances, monthly
UTC boundaries, consumption estimates and outstanding reservations. API keys
and search queries are never written to it. Use the same account label when
rotating keys, and different labels for different accounts. Do not use a key
as the account label. Usage from other applications is not automatically known:
seed existing usage with `WEB_SEARCH_EXA_INITIAL_USED_CENTS` when first adding an
account, rounding up to whole cents, and use provider-side spending limits where
available. The initial-use setting is ignored for existing ledger accounts and
is not reapplied next month.

Allowances can change on restart without clearing consumption. The reset day
must match the stored schedule; changing it is rejected instead of silently
starting a new allowance period. Days 29–31 clamp to the final day of shorter
months. Consumption resets at the configured boundary. Requests still in flight
also reserve capacity in the new period because their billing time is uncertain.

Each estimated request cost is reserved and durably saved before dispatch. The
accounting wrapper defaults to free capacity only; the router explicitly permits
paid capacity only after free and unmetered candidates are unavailable.
Concurrent reservations share a mutex and
cannot independently consume the same remaining allowance. Successful requests,
including empty results, commit the provider's response-reported cost estimate
when available, otherwise the reserved estimate. A reported cost can be lower
or higher than the reservation; it is not capped to the reserved amount.
Timeouts, cancellation and
uncertain failures after dispatch also commit the estimates. A reservation whose
request never dispatched is released. Errors explicitly guaranteed not
to be billed release their reservation; currently Exa HTTP 503 is the documented
case. Reservations left by a crash are charged on reopening the ledger, including
against the current period if a reset occurred while the server was down.

Settlement is queued before awaiting its durable write. Cancellation during
settlement retains the known charge/refund decision and any remote exhaustion
cap; it does not queue a second settlement. While background cleanup is pending,
the durable reservation continues to constrain capacity. If cleanup cannot
complete before a crash or shutdown, restart recovery charges the outstanding
reservation conservatively. Status snapshots and usage polling also run ledger
operations in blocking workers so they cannot block search timeout processing.

Ledger writes use a synced temporary file followed by atomic rename, with a
directory sync on Unix. A process lock on `budget.lock` prevents another server
from opening the same ledger concurrently, and releases automatically when the
owner exits. New directories/files use owner-only permissions on Unix. Invalid,
unsupported or unreadable ledgers stop initialization; they are never silently
replaced with zero consumption. Write failures block further metered requests
until the persistence problem is repaired and the server restarts.

Optional provider usage reporting is polled every five minutes with a 20-second
timeout. Supported reports can lower available capacity within the matching
period; they never replenish uncertain charges or enlarge configured allowances.
Pending requests remain reserved independently. Missing reporting leaves local
estimates in place. Exa currently returns `None`, so its poll performs no HTTP
request and cannot discover its actual account balance. Price changes, provider
billing timing and usage outside this ledger can make local estimates differ
from actual provider usage.

### Exa adapter

The adapter uses authenticated `POST https://api.exa.ai/search` with an explicit
`type: instant`. It requests cached highlights of up to 1,000 characters per
result (`contents.maxAgeHours: -1`), disables full text, requests no summary or
extras, and sets subpage crawling to zero. Uncached pages can have empty
snippets; callers can fetch the result URL when they need page contents.

Exa requests are capped at 25 results in one request. Its documentation currently
lists a public schema maximum of 100 while the pricing page describes requests
above 25 as an enterprise feature, so the adapter uses the lower limit. It
does not paginate or retry automatically.

The local cost estimate uses the [published Instant search pricing](https://exa.ai/docs/admin/pricing),
verified October 14, 2026: $0.004 for up to ten results, plus $0.001 per additional
requested result. Highlights are bundled in this search price. Estimates use
the same capped result count as requests. Rates are adapter constants and must
be updated when provider pricing changes.

After a successful response, accounting uses `costDollars.total` instead of the
reserved estimate. Dollar values are rounded to the nearest integer millionth
of a dollar; zero is a valid reported cost. Missing, null, nonnumeric, negative
or out-of-range values fall back to the local estimate without discarding search
results. This is still estimated spending, not authoritative billed usage.

Highlights populate the common snippet. Optional original excerpts, author and
publication date are retained internally; the MCP JSON shape remains unchanged.
An explicit output field list restricts search responses to the query and each
result's title, URL and snippet. Costs, balances, provider metadata and routing
diagnostics are not included in those responses.
Result URLs are restricted to HTTP(S), duplicates are removed, and missing titles
fall back to the URL. Malformed or oversized responses produce typed errors.
API keys are marked sensitive, redirects are disabled, and errors never include
raw provider response bodies or credentials.

Account usage reporting returns `None` for this adapter. Exa's documented
[usage analytics API](https://exa.ai/docs/reference/team-management/get-api-key-usage)
requires separately enabled Team Management access, a service account key and
the target API key ID. It reports historical costs, not the remaining recurring
free balance. The regular `EXA_API_KEY` is not sufficient for that integration.
The optional `costDollars` search response is a request-cost estimate, not an
account balance or invoice, and is not used as quota reporting.

References: [Search API](https://exa.ai/docs/reference/search),
[OpenAPI schema](https://exa.ai/docs/exa-spec.json), and
[error codes](https://exa.ai/docs/admin/error-codes).

## Compilation and static validation

From the repo root:

```bash
cargo build --manifest-path tools/mcp/web-search/Cargo.toml --locked
cargo fmt --manifest-path tools/mcp/web-search/Cargo.toml --check
cargo clippy --manifest-path tools/mcp/web-search/Cargo.toml --locked -- -D warnings
bash -n tools/mcp/web-search/run.sh
git diff --check
```

Append `--offline` before any `--` separator in the Cargo build and Clippy
commands when dependencies are cached and network access is unavailable.
These commands compile the server, check formatting, lint production code and
check launcher syntax and diff whitespace. They do not run tests or start the
server. Tests require separate authorization under the repository instructions.
Live provider validation also requires explicit authorization for the API requests
and credits they may consume; compilation and static checks do not verify live
credentials, billing, fallback behavior or the continued availability of the
undocumented DuckDuckGo endpoint.

## Infumap configuration

Configure the endpoints as separate tool sources:

```toml
chat_tool_servers = [
  { id = "web_search", url = "http://127.0.0.1:8791/mcp/search" },
  { id = "web_fetch", url = "http://127.0.0.1:8791/mcp/fetch" },
]
```

Enable either source independently in Infumap. Omit either entry to use only
search or fetch, or point either entry at another MCP server to use a different
provider for that operation.

Both sources use the profile's **Tool approvals** policy. Automatic runs web requests without
prompting when Infumap tools are off and the chat has no attachments; otherwise it asks
before each request. Always ask requires approval for every call. The current Infumap setting
controls retrieval-related approvals; retained attachments still require approval.
These endpoints remain external sources despite running on localhost: the sidecar forwards queries
and URLs to outside services. Leave `external_requests` at its default `true` for both entries.
Set `require_approval = true` on either entry to always require approval regardless of the profile.

## Inspector

With the server running:

```bash
npx @modelcontextprotocol/inspector http://127.0.0.1:8791/mcp/search
# To inspect fetch instead:
npx @modelcontextprotocol/inspector http://127.0.0.1:8791/mcp/fetch
```

Methods implemented: `initialize`, `notifications/initialized`, `tools/list`,
`tools/call`, `ping`. Responses are JSON only (no SSE). Auth is not implemented;
this is a localhost sidecar.

## Tools

- `web_search` at `/mcp/search` — `{ query, numResults? }`
- `web_fetch` at `/mcp/fetch` — `{ url, maxChars? }`

The model-facing descriptions explain that searches may consume limited provider
credits. They encourage focused queries and reuse of existing results. Further searches remain
appropriate when existing results do not answer the question. `web_fetch` reads
pages directly without consuming search-provider credits.

`numResults` defaults to five. Its description advises requesting only as many
results as needed, explains that larger requests may use more credits, and notes
that providers may return fewer results. This guidance is advisory; the server
enforces budgets and fallback independently.

`web_fetch` refuses loopback, link-local, and metadata addresses. It also refuses
common search engine hosts, including Google (and country domains), Bing,
DuckDuckGo (including HTML/lite endpoints), Yahoo Search, Brave Search, Startpage,
Ecosia, Baidu, Yandex, AOL Search and Ask. These checks run before DNS resolution
for each destination, including redirects. Rejections direct callers to
`web_search`; search-provider configuration determines which provider is used.
Product hosts such as `docs.google.com` remain fetchable.
