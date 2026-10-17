# Web search MCP server

Streamable HTTP MCP server exposing Infumap's web-search and page-fetch tools.
Bind is `127.0.0.1` by default. Exa and Tavily use configured free monthly
allowances. DuckDuckGo needs no API key and is disabled until a positive request
rate is configured. Search uses paced routing and bounded fallback.

Browser-backed HTML, native-only PDF extraction and local browser setup are
implemented. See [fetch operations](FETCHING.md) for browser installation and
updates, GPU service configuration, cache controls and validation limits, and
[implementation status](IMPLEMENTATION_PLAN.md) for the original plan.

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
Cargo reuses unchanged build artifacts. The wrapper resolves or installs a
browser once per invocation, then restarts an exited server
after the configured delay without rebuilding; startup configuration errors will
repeat until corrected. Run the binary directly when diagnosing a single startup
attempt.

Environment:

- `WEB_SEARCH_HOST` (default `127.0.0.1`)
- `WEB_SEARCH_PORT` (default `8791`)
- `WEB_SEARCH_RESTART_DELAY_SECS` (default `5`) — used by `run.sh` only

## Fetch configuration and behavior

Fetch configuration is read once at startup, independently of search-provider
configuration. The wrapper prepares the browser once; the binary resolves it locally and launches
it on demand. A missing browser
does not prevent the server or search providers from starting. Malformed fetch
settings stop startup.

| Variable | Default | Meaning |
| --- | --- | --- |
| `WEB_FETCH_BROWSER_PATH` | Automatic discovery | Absolute path to Chrome/Chromium. If set, this exact executable is used; launch failure is reported without HTTP fallback. |
| `WEB_FETCH_TIMEOUT_SECS` | `30` | Overall request deadline, including destination checks, queueing, browser startup, downloads and extraction. Integer from 1 to 3600. |
| `WEB_FETCH_MAX_DOCUMENT_BYTES` | `2097152` (2 MiB) | Maximum downloaded HTML/text size. Integer from 1 to 16777216 (16 MiB). |
| `WEB_FETCH_MAX_PDF_BYTES` | `134217728` (128 MiB) | Maximum downloaded PDF size. Integer from 1 to 134217728. |
| `WEB_FETCH_MAX_RENDERED_BYTES` | `4194304` (4 MiB) | Rendered HTML byte limit; at most 16 MiB. Separate DOM/node/depth and Markdown expansion limits also apply. |
| `WEB_FETCH_GPU_TOOLS_URL` | Unset | Operator-configured GPU service/gateway base or `/gpu-tools` URL. PDF extraction requires the native-only capability and deadline protocol. |
| `WEB_FETCH_MAX_PDF_RESPONSE_BYTES` | `16777216` (16 MiB) | Full PDF service JSON response limit; at most 32 MiB. |
| `WEB_FETCH_PDF_CACHE_ENABLED` | `true` | Enable private PDF artifact caching. |
| `WEB_FETCH_PDF_CACHE_DIR` | User cache `infumap-web-search/pdf-native-v1` | Absolute directory for PDFs, full Markdown and provenance. |
| `WEB_FETCH_PDF_CACHE_MAX_BYTES` | `2147483648` (2 GiB) | PDF artifact budget; at most 16 GiB. Small indexes and fixed lock files have separate count limits. |
| `WEB_FETCH_PDF_CACHE_TTL_SECS` | `86400` | Source freshness/unused artifact expiration; at most 30 days. |
| `WEB_FETCH_PDF_REFRESH` | `false` | Bypass source and extraction hits and publish freshly converted results. |
| `WEB_FETCH_HTML_DUMP_DIR` | Unset | Opt-in raw rendered HTML dumps before cleanup; unique private files, bounded concurrent writes. |


Ordinary URLs are loaded by Chrome through `chromiumoxide`. The main response
is intercepted and read in bounded chunks before dispatch. HTML is supplied
back to the same navigation for rendering, preserving its URL and response
headers; the page is not fetched a second time. The rendered DOM then goes
through the existing main-content and Markdown extraction. Browser sandboxing
and certificate validation remain enabled.

URLs ending in `.txt`, `.json`, `.md`, `.markdown`, `.csv` or `.xml` use a bounded
direct HTTP download first. The suffix is only a routing hint: actual MIME and
bytes determine the document type, and HTML responses are sent to the browser.
Extensionless text/JSON responses are also handled by browser response dispatch.
Binary formats other than PDFs return an unsupported-document error. Byte-limit
failures are explicit errors; `maxChars` still truncates successfully extracted
text using the existing compact MCP result shape.

PDF detection checks a `%PDF-` signature in the first kilobyte as well as the
response MIME type. It covers extensionless resources and redirects and stops
the browser before rendering its PDF viewer. Browser-fetched PDF bytes come
from that same Chrome response, using its existing cookies and request context:
there is no second download or cookie transfer to another HTTP client. The PDF
handler discovers and calls only the native-only PDF capability. It validates
policy/provenance before returning or caching Markdown and never falls back to
OCR, caption extraction or the ordinary PDF upload endpoint. Cached PDFs can be
served without a browser/service call while fresh; expired sources use validators
when available and otherwise download again before content-hash reuse.

The renderer starts one owned browser lazily and serializes browser fetches.
It reuses a unique temporary profile for that browser, creating and disposing
a fresh incognito context for each fetch. Cookies, storage and page targets
belong to that request; the user's normal browser profile is never opened.
Modern headless mode, Chrome's sandbox and certificate checks are required.
Unsafe sandbox/TLS launch flags are rejected by the internal helper.

The overall request deadline includes queueing, startup, navigation, rendering
and extraction. Caller cancellation or a timeout stops the worker and recycles
the browser, including any context whose creation was interrupted. HTTP 4xx/5xx
responses retain a healthy browser only after context disposal succeeds and
network forwarding has drained; other browser errors recycle it. Chrome stderr
diagnostics remain in server logs and are not appended to model-facing errors.
Cleanup can continue after the caller's deadline, while
the worker retains its concurrency slot. A subsequent fetch cannot start until
network forwarding and required browser cleanup have finished.

Browser connections use an owned loopback proxy that resolves and validates
public destinations before connecting to those exact addresses. Direct downloads
likewise pin validated addresses. A fresh proxy session bounds each fetch's
connections and tunnels; revocation closes and drains them before releasing the
slot. The proxy rejects new traffic while idle. Linux OS confinement also
prevents browser traffic from bypassing the proxy. Native macOS uses the proxy
and request checks without an additional OS outbound boundary, as described below.

SIGINT/SIGTERM stop HTTP acceptance, cancel pending handlers and await owned
browser cleanup. The wrapper allows five seconds before forcing server shutdown.
An independent process guardian watches a private ownership socket and a helper
lifeline, so it also cleans up if the server/helper is killed. It signals only
its own Chrome process group and reaps Chrome; on Linux, a subreaper additionally
adopts, terminates and reaps daemonized descendants. On macOS, Crashpad is allowed
to start and its detached handlers use their own Mach client-port lifetime;
the guardian does not wait for or reap those detached handlers. The guardian
also removes its exact temporary profile
after cleanup. There is no scan for unrelated Chrome processes.

Readiness waits at least 750 ms and up to a three-second opportunity for content
to settle, within the overall deadline. DOM evaluation uses the current page
context and tolerates navigation replacing it during readiness or capture,
without extending the request deadline. Consent UI removal preserves main
content and policy pages. Specific short challenge/refusal pages return errors;
links resolve against `document.baseURI`. Table conversion avoids column padding
that could multiply extraction memory. These remain heuristics, not a guarantee
that every application has finished rendering.

Validation is production compilation/linting, formatting and shell syntax only.
No browser launch, live fetch, installation/shutdown or PDF extraction exercise
has been performed in this development environment. Operator-provided macOS logs
revealed the former outer Seatbelt wrapper prevented Chrome sandbox initialization;
the revised native macOS path has not been compiled or exercised here.

On Linux, browser network confinement is mandatory and cannot be disabled in
fetch configuration. The server's internal browser helper creates user and
network namespaces with only loopback enabled. Filesystem Unix sockets bridge
the filtering proxy and DevTools to the parent process. The host must permit
unprivileged user/network namespaces for this executable, and the server must
run as a non-root user. Kernel, container or AppArmor restrictions that prevent
setup cause browser fetches to fail; the launcher does not change those policies.
The guardian also requires `/proc/self/task/<pid>/children` for cleanup of adopted
children and checks availability before starting Chrome. No external namespace/
relay packages or global network changes are required.

On macOS, the helper launches native Chrome with its own sandbox enabled.
There is no outer `sandbox-exec` wrapper: it conflicts with Chrome's sandbox
initialization. The filtering proxy, connection-time public-address validation,
request interception and proxy-bypass controls remain enabled. These do not
guarantee that every browser network channel uses the proxy. Use the Linux
server, optionally in a VM, when an OS-enforced outbound boundary is required.
Loopback `/status` reports `network_policy: "proxy_only"` and
`network_confinement_required: false` on macOS; `browser_sandbox_required`
remains true. Unsupported platforms and Linux confinement failures return fetch
errors. Search and direct text downloads can still operate.

Linux OS confinement covers network channels outside page request interception,
including workers, additional targets and WebRTC. The proxy supports HTTP, HTTPS CONNECT
and WebSocket upgrades, bounds active connections and closes forwarding on
request completion/deadline. It has no direct fallback or implicit loopback
bypass. Direct HTTP downloads use an exclusive pinned resolver, with automatic
redirects and environment proxies disabled. DNS answers containing any rejected
address fail before connection; special IPv4/IPv6 translation and reserved
ranges are excluded too. See [network policy](NETWORK_POLICY.md) for the trust
boundaries and remaining validation limits.

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
| `WEB_SEARCH_DUCKDUCKGO_REQUESTS_PER_MINUTE` | `0` | Local DuckDuckGo attempt rate, a non-negative integer. Zero disables it. Positive values enforce at least 60/rate seconds between attempt starts, with at most one request in flight. |
| `EXA_API_KEY` | Unset | A nonempty API key configures Exa. No separate enable flag is needed. |
| `TAVILY_API_KEY` | Unset | A nonempty API key configures Tavily. No separate enable flag is needed. |
| `WEB_SEARCH_STATE_DIR` | See below | Absolute directory for persistent budget state. |
| `WEB_SEARCH_EXA_MONTHLY_FREE_CREDITS_CENTS` | `0` | Monthly free allowance in integer US cents, not request counts. Zero means no assumed free capacity. |
| `WEB_SEARCH_EXA_MONTHLY_RESET_DAY` | `1` | Day of month, from 1 through 31, when the configured budget resets at 00:00 UTC. Days beyond the end of a month mean that month's last day. |
| `WEB_SEARCH_TAVILY_MONTHLY_FREE_CREDITS_CENTS` | `0` | Free credit allowance normalized to integer US cents at $0.008 per Tavily credit: 1,000 credits = 800 cents. No free capacity is assumed. |
| `WEB_SEARCH_TAVILY_MONTHLY_RESET_DAY` | `1` | Monthly reset at 00:00 UTC, day 1–31; days beyond month-end use its last day. |

Set the allowance and reset day to match the user's actual account. Advertised
free-tier amounts are deliberately not built into the configuration. One-time
trial or onboarding credits are not recurring monthly allowances.

The service prefers ready DuckDuckGo capacity, then configured free monthly
allowances. DuckDuckGo must be explicitly enabled with a positive request rate.
New accounts start tracking local usage at zero. If usage elsewhere exhausts the
provider first, its quota error blocks further requests until the configured
reset. Provider accounts must enforce their own free-only limit; the adapter
cannot identify paid credits in an accepted request.

Provider configuration, persistent accounting, routing and the common provider
interface with DuckDuckGo, Exa and Tavily adapters are implemented. Startup
prepares configured clients and validates credential header syntax locally,
without contacting providers. The Exa and Tavily adapters use persistent budget
accounting that reserves capacity before any metered request can be dispatched.
The router selects eligible providers automatically and falls back after
failures. Startup logs report configured preferences and the local budget
balance. These are local estimates, not provider-side billing controls.

### DuckDuckGo without API keys

With no provider settings, search is disabled; the server still starts and
`web_fetch` remains available. To enable DuckDuckGo, set an explicit request rate,
for example:

```bash
export WEB_SEARCH_DUCKDUCKGO_REQUESTS_PER_MINUTE=6
./tools/mcp/web-search/run.sh
```

This example allows at most one attempt every ten seconds, not six simultaneous
requests each minute. It is an example of the local control, not a published safe
rate. DuckDuckGo uses an undocumented HTML endpoint and can still throttle or
block requests. Idle time does not accumulate burst capacity. Failed/empty
attempts consume a pacing slot too. Provider failures put DuckDuckGo into a
one-hour cooldown; a longer `Retry-After` is honored. This overrides local pacing
readiness. Invalid queries and ordinary local rate skips do not start a cooldown.
The setting applies across all requests to this server process; other processes
and applications are outside its accounting. Pacing state resets on restart.

The boolean enable setting has been removed. Set the request rate to zero to
turn DuckDuckGo off. To run without any search provider even if the shell has API
keys:

```bash
env -u EXA_API_KEY -u TAVILY_API_KEY WEB_SEARCH_DUCKDUCKGO_REQUESTS_PER_MINUTE=0 ./tools/mcp/web-search/run.sh
```

`web_search` returns a short unavailability error. `/status` shows all three
providers disabled, `search_available: false`, and a configuration error. No
metered budget directory is created. Other malformed settings still prevent
startup, even when their provider is disabled.

### Exa configured

Export `EXA_API_KEY` through your environment or secret manager and set the
monthly allowance. For example, **if your account provides $10 in recurring
monthly credits**, with DuckDuckGo disabled:

```bash
export WEB_SEARCH_DUCKDUCKGO_REQUESTS_PER_MINUTE=0
export WEB_SEARCH_EXA_MONTHLY_FREE_CREDITS_CENTS=1000
export WEB_SEARCH_EXA_MONTHLY_RESET_DAY=1
./tools/mcp/web-search/run.sh
```

Set the actual reset day for your account before launching.
Preserve the state directory across restarts and API key rotation. In a
container, set `WEB_SEARCH_STATE_DIR` to an absolute path on persistent storage.
Startup prepares the client and ledger without verifying the key with Exa. `/status` reports local eligibility, not confirmation that a
provider will accept a request; the actual Exa balance remains unknown.

A key without a configured free allowance cannot spend credits.
To use DuckDuckGo alongside Exa, set
`WEB_SEARCH_DUCKDUCKGO_REQUESTS_PER_MINUTE` to a positive integer before launch.
Ready DuckDuckGo slots are preferred; Exa and Tavily absorb bursts or serve calls
while DuckDuckGo is busy, locally paced, or cooling down. Configuration changes
require a server restart.

### Tavily configured

Create a key in the [Tavily dashboard](https://app.tavily.com/) and export
`TAVILY_API_KEY` through your environment or secret manager. As of October 17,
2026, Tavily's [free plan](https://docs.tavily.com/documentation/api-credits)
provides 1,000 API credits per month, and a basic search uses one credit.
The adapter fixes `search_depth: basic` and `auto_parameters: false` so automatic
parameter selection cannot upgrade the request to a two-credit advanced search.

The shared ledger uses monetary units. Tavily credits are normalized at the
published pay-as-you-go rate of **$0.008 per credit**: one credit is 8,000 USD
micros, or 0.8 cents. Thus 1,000 free credits correspond to **800 cents** of local
accounting allowance. This conversion describes capacity; it does not mean the
free plan costs $8. Paid capacity is outside the scope of this service.

For an account with 1,000 recurring free credits:

```bash
# Export TAVILY_API_KEY separately through your environment/secret manager.
export WEB_SEARCH_TAVILY_MONTHLY_FREE_CREDITS_CENTS=800
export WEB_SEARCH_TAVILY_MONTHLY_RESET_DAY=1
./tools/mcp/web-search/run.sh
```

Set the allowance and reset day to match the account. A key alone,
with the free allowance at zero, cannot spend credits. Preserve the state
directory across restarts and API key rotation. Exa and Tavily share one ledger
directory with separate provider balances; existing Exa ledger entries retain
their usage. DuckDuckGo participates when a positive request rate is configured;
Exa participates when its key and free allowance are configured.

The adapter uses authenticated `POST https://api.tavily.com/search` with Bearer
authentication, `topic: general`, and at most 20 results. Larger `numResults`
requests can return fewer results without additional pagination calls. Answers,
raw page content and images are disabled. Titles, URLs and content snippets are
normalized into the existing MCP result shape; duplicate and non-HTTP(S) URLs
are discarded, and snippets are limited to 1,000 characters. Responses are
bounded to 2 MiB. There are no internal retries.

`include_usage: true` requests the search response's `usage.credits`. Valid
integer credit usage is normalized at the same rate and settled in the ledger;
missing or invalid usage metadata leaves the one-credit estimate in place.
This is request usage, not an account balance. Account usage polling is not
implemented, so Tavily reports `usage.state: unsupported` in local status and
background refresh makes no Tavily API calls. Usage from other applications is
not discovered automatically.

Tavily's [documented HTTP errors](https://docs.tavily.com/documentation/api-reference/endpoint/search)
include 401 for invalid credentials, 429 for rate limiting, 432 for plan usage
limits, and 433 for pay-as-you-go limits. The router disables invalid credentials
until restart, applies cooldowns to rate limiting (honoring delta-seconds
`Retry-After`), and persists a zero-capacity cap after 432/433 until the configured
monthly reset. Other eligible providers can serve fallback requests. Uncertain
billing, including error responses and timeouts, conservatively consumes the
reservation; error bodies and API keys are not included in diagnostics.

### Exhausted credits and invalid credentials

Inspect `/status` and server diagnostics to distinguish local budget limits from
provider failures. Availability there refers to the five-result reference request;
a request for more results may need a larger budget.

| Condition | Behavior and recovery |
| --- | --- |
| Exa key set, allowances left at zero | Exa is enabled but has insufficient local budget. Configure the account's actual allowance and reset schedule, then restart. |
| Local remaining capacity is below the estimated request cost | Exa is skipped without sending a request. DuckDuckGo can serve the call when enabled and locally eligible. Smaller requests may still fit; otherwise the configured monthly reset restores the local allowance. |
| Exa returns HTTP 402 | The router records remote quota exhaustion. A zero-capacity cap is persisted until the configured monthly reset, and enabled DuckDuckGo can serve as fallback. Restarting or increasing the local allowance does not clear this cap. |
| Exa returns HTTP 401 | The provider is disabled until restart. Correct `EXA_API_KEY` in the launch environment and restart preserving the ledger. Enabled DuckDuckGo can serve as fallback. |
| Exa returns HTTP 403 or 429 | These are classified as blocking or rate limiting, respectively. Status shows a cooldown; routing can use enabled DuckDuckGo while Exa is unavailable. |
| API key contains invalid HTTP header characters | Initialization fails before binding the server, including when DuckDuckGo is enabled. Correct the key; inspect stderr because `/status` cannot be served. |
| Ledger is unreadable, invalid or already locked by another process | Initialization fails. Repair the storage or stop the other ledger owner, then restart while preserving accounting history. |
| A ledger write fails during operation | Further metered dispatch is blocked. Status shows the persistence error; repair storage and restart. DuckDuckGo can still serve when its pacing and health allow. |

There is no command to refresh an Exa or Tavily balance or clear a remote exhaustion cap
after topping up credits mid-period. This implementation continues honoring the
cap until its configured reset. DuckDuckGo can serve as fallback in the meantime
when enabled and locally eligible. Changing the reset day of an existing account is rejected.

Attempts with uncertain billing, including HTTP 401 and 402, conservatively commit
their reserved cost. Correcting a key and restarting preserves that consumption.
When fallback succeeds, the MCP result contains that provider's normal results;
logs and `/status` expose failures of the earlier provider. If no provider can
serve the call, `web_search` returns `isError: true` with a short unavailability
message. Provider failure and skip reasons remain in server logs and local status.
An empty result triggers fallback to another eligible provider before the tool
returns to the model. Intermediate empty responses and routing details remain
internal.

### Provider selection and fallback

Only configured providers participate. DuckDuckGo has short-lived paced capacity;
Exa and Tavily have monthly free allowances. These capacities are deliberately
not compared as percentages of the same budget.

Routing prefers a healthy, ready DuckDuckGo slot because that opportunity cannot
be banked for a later burst. DuckDuckGo is skipped while its minimum interval is
running or another DuckDuckGo request is in flight. Exa and Tavily absorb that
traffic, choosing the highest remaining free allowance percentage; equal
percentages use Exa first. Monthly providers are excluded when the entire
estimated request cost does not fit. Paid capacity is never eligible.

For example, with a DuckDuckGo rate of six per minute, an isolated search uses
DuckDuckGo when healthy. A burst admits one DuckDuckGo attempt and routes other
calls to eligible monthly providers. An empty result or failure tries another
eligible provider internally. An already attempted provider is never retried in
that call. No requests sleep waiting for a pacing slot: when no provider is
currently eligible, search returns an error.

Pacing admission and the in-flight check share the provider's health mutex, so
concurrent searches cannot take the same slot. The interval is rounded up to
nanosecond precision. Slots are consumed at admission even if an attempt later
fails or is cancelled. Local rate skips do not mark the provider unhealthy or
extend its cooldown. Bot-block and remote rate-limit cooldowns still apply.

Provider usage reporting can conservatively reconcile local estimates. Durable
reservations and consumption tracking are implemented. An empty search result
tries the next eligible provider using the same funding and health rules. Empty
results still count as successful requests for health and budget accounting;
they do not disable the provider for other queries. If at least one search
completed successfully but no fallback produced results, the tool returns one
empty result set. If every attempt failed, it returns an unavailability error.
The overall deadline still returns an error when exceeded. Each provider is
attempted at most once per call, with at most three attempts in total. Provider
attempts have a 20-second timeout within a shared 30-second request deadline.
The shared deadline covers selection, health-lock waits, budget-worker waits,
reservations, provider HTTP and settlement. Runtime ledger operations run in
blocking workers, and health locks are asynchronous, so slow storage cannot hold
the search response past its deadline. A timed-out request stops waiting;
an already-started storage operation can finish in the background. No provider
request is dispatched for a reservation that completes after its deadline.
Fallback happens immediately without sleeping through cooldowns; a provider
already attempted for this call is never retried. Budget reservations are
checked again at dispatch to handle concurrent requests consuming capacity
after selection.

Invalid credentials disable a provider until restart after correcting its
configuration. Internal adapter/accounting failures also disable it until repair
and restart. Provider-reported quota exhaustion suspends a metered account until
its configured monthly reset; the zero-capacity cap is persisted with settlement
and survives restarts. This cap blocks further metered dispatch, even when
local configured allowances still show unused capacity. Requests to each metered
provider are serialized from reservation through durable settlement, so queued
requests cannot dispatch before an earlier quota-exhaustion cap is saved.
Different providers can operate independently. A local request whose cost does
not fit is distinguished from remote exhaustion, so a smaller later request can
still use the remainder.
Providers without a known quota reset are disabled until restart after replenishment.

DuckDuckGo provider failures (blocking, rate limiting, transient failures,
unexpected responses and cancellation) impose at least a one-hour cooldown.
A longer delta-seconds `Retry-After` extends it; a shorter one does not reduce it.
Exa and Tavily rate limits use `Retry-After`, or 60 seconds when absent. Their
blocking defaults to 15 minutes. Transient failures back off from 2 seconds to
5 minutes; unexpected responses use at least 15 seconds. A supplied `Retry-After`
overrides those defaults, with a minimum of one second.
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

### Local provider/fetch status

Inspect the running server without spending search credits:

```bash
curl http://127.0.0.1:8791/status
```

`GET /status` returns JSON showing all three supported providers, whether each is
enabled, reasons it is unavailable, local budget balances, monthly boundaries,
cooldowns, suspensions, requests in flight and usage-reporting state. Availability
and `funding` are evaluated for a reference search requesting five results;
`funding` identifies the budget class that fits even if health currently prevents
dispatch. Actual eligibility can change with result count and concurrent requests.
`search_available` reports whether at least one provider can currently serve that
reference request. An unavailable search service still returns HTTP 200 so its
diagnostics can be inspected; failure to obtain status returns HTTP 503.

All monetary values are integer USD micros (1,000,000 = $1). `budget` contains
configured free allowances, remaining free capacity, consumed estimates
and outstanding reservations. `period_start`, `period_end`, `quota_resets_at`,
`generated_at` and usage observation/reset times are Unix seconds in UTC.
`cooldown_remaining_ms` is the remaining delay in milliseconds.

DuckDuckGo's `rate_limit` reports `requests_per_minute` and
`next_request_in_ms`, the remaining minimum-interval delay rounded up to whole
milliseconds. A zero delay does not override a request already in flight or a
health cooldown; inspect `available` and `unavailable_reasons` too. Monthly
providers have `rate_limit: null`. Status reads never reserve a pacing slot.

`usage.state` is `not_checked`, `unsupported`, `reported` or `error`.
`usage.last_report`, when present, is the last provider observation, timestamped
separately from the latest refresh attempt; it can be stale after a failure or
monthly reset. Exa, Tavily and DuckDuckGo currently report `unsupported`, so
their actual remaining account capacity is unknown. Local estimates are not reported balances.
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

`budget.json` records each provider's free allowance, monthly UTC boundaries,
consumption estimates and outstanding reservations. API keys and search queries
are never written to it. Each provider uses one local account automatically;
rotating an API key does not reset usage. New accounts start at zero consumption.
Existing accounts retain their recorded usage and quota caps across restarts.
The existing ledger format is retained. A single saved entry is reused even if
it formerly had a custom label. Multiple saved entries for an enabled provider
are rejected rather than silently selecting an account or resetting usage.
Usage from other applications is not automatically known; a provider quota-exhaustion error
blocks further dispatch until the configured reset.

Allowances can change on restart without clearing consumption. The reset day
must match the stored schedule; changing it is rejected instead of silently
starting a new allowance period. Days 29–31 clamp to the final day of shorter
months. Consumption resets at the configured boundary. Requests still in flight
also reserve capacity in the new period because their billing time is uncertain.

Budget ledger version 1 is migrated to version 2 at startup. Only the obsolete
paid-allowance field is removed; recorded consumption, pending reservations and
remote quota caps are preserved, including accounts not currently configured.
The normal durable write publishes the migration. `/status` no longer includes
`configured_paid_limit_usd_micros` or `total_remaining_usd_micros`; use
`free_remaining_usd_micros`. Old paid-limit environment variables have no effect.

Each estimated request cost is reserved and durably saved before dispatch. The
accounting wrapper permits free capacity only. There is no paid-budget
configuration or paid routing path. Concurrent reservations share a mutex and
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
cap; it does not queue a second settlement. The settlement worker retains that
provider's dispatch lock even after caller cancellation, releasing it only after
the ledger operation finishes. A failed ledger write blocks further metered
dispatch. Waiting for the provider lock remains within the request deadline.
While background cleanup is pending, the durable reservation continues to
constrain capacity. If cleanup cannot complete before a crash or shutdown,
restart recovery charges the outstanding reservation conservatively. Status snapshots and usage polling also run ledger
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
estimates in place. Exa and Tavily currently return `None`, so their polls perform
no HTTP requests and cannot discover actual account balances. Price changes, provider
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
