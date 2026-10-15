# Browser and native PDF operations

## Start and update

Run `./tools/mcp/web-search/run.sh`. It builds the release binary and runs
`--setup-browser` once, before entering its server restart loop. Selection is:

1. The exact absolute `WEB_FETCH_BROWSER_PATH`, if configured.
2. A complete managed installation selected by its private `active.json`.
3. A discovered installed Chrome/Chromium executable.
4. A download of pinned official Chrome for Testing **155.0.8059.79**.

The pin was checked against [Google's Stable metadata](https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json)
on October 15, 2026. Google now advertises `linux64`, `linux-arm64`, `mac-x64`
and `mac-arm64` [artifacts](https://github.com/GoogleChromeLabs/chrome-for-testing).
An unavailable platform/version fails explicitly. No global browser, Python,
Docling, OCR engine, GPU model or OS package is installed by this wrapper.

Managed files live in
`${XDG_CACHE_HOME:-$HOME/.cache}/infumap-web-search/browsers/`. Normal startup
reuses them offline. To select and install the current official Stable version:

```bash
./tools/mcp/web-search/run.sh --update-browser
```

This command exits after updating; restart the sidecar to use the new selection.
An explicit `WEB_FETCH_BROWSER_PATH` continues to override managed selection.
Updates are deliberate, so operators must schedule them to receive browser
security fixes; an existing installation is never silently updated on restart.
Old managed versions are retained for rollback and can be removed when no
sidecar uses them. Keep the current and any running version.

Setup uses a process-shared file lock, a five-minute overall deadline, 15-second
metadata requests and a 180-second archive request. Metadata is limited to 1 MiB,
the ZIP to 512 MiB, and expanded contents to 2 GiB/30,000 entries. Only fixed
official HTTPS metadata/archive URLs are accepted; redirects are rejected.
Archive checks reject traversal, duplicate paths, special files and links
escaping the installation. macOS framework symlinks are deferred, checked for
unsafe parent paths and resolved within the completed staging directory. File
permissions retain executable bits but strip setuid/setgid bits. Publication is
atomic and incomplete staging is never selected. Abandoned installer staging is
reclaimed under the install lock on the next install/update. SHA-256 of the downloaded
archive is recorded for diagnostics; it is not an independent publisher signature.

Setup checks executable permissions and format without launching a probe.
Actual host-library and sandbox readiness is established by an ordinary fetch;
its CDP version check requires Chrome/Chromium 112 or newer for modern headless.
Linux requires a non-root user, unprivileged user/network namespaces and the
guardian's `/proc/self/task/<pid>/children` interface. Missing Chrome libraries
must be supplied by the operator, or select another suitable browser; the
wrapper never uses `sudo` or disables sandbox/certificate checks. A musl server
does not make Google's Chrome independent of host libraries. macOS requires
`sandbox-exec`, and its optional detached Crashpad daemon is denied for process
ownership. See [network policy](NETWORK_POLICY.md).

A setup failure still starts search. Browser requests fail clearly and there
is no raw-HTML fallback. The wrapper does not retry downloads in its restart loop.

## Configure native PDF extraction

Start an updated [GPU gateway/PDF worker](../../gpu/README.md), then start the
sidecar, for example:

```bash
WEB_FETCH_GPU_TOOLS_URL=http://127.0.0.1:8787 \
WEB_FETCH_TIMEOUT_SECS=300 \
./tools/mcp/web-search/run.sh
```

Use your actual configured service port. A base prefix and a URL ending in
`/gpu-tools` are accepted. Discovery and POST use the same configured origin and
fixed paths beneath its prefix; discovery cannot supply another authority,
credentials, query, encoded path escape or legacy endpoint. Service redirects
and environment proxies are disabled. The service can intentionally be private;
this exception applies only to operator configuration, never to page URLs.

The client requires schema 1 and `pdf_extract_native` advertising POST at
`/pdf-extract-native`, native policy/version 1 and the absolute-deadline header.
Older services, including native-only services without queue deadline support,
return an unavailable error. The gateway also checks its upstream worker's
capability. Discovery successes/failures are cached for 60 seconds. A capability
confirmation is not a live GPU health guarantee.

The client uploads bounded bytes, never a URL for the GPU service to fetch. PDFs
reached through browser navigation use bytes from that same response and context.
No cookie transfer or second initial PDF download is required. A two-second
allowance is reserved for response handling; the remaining budget is sent as
`X-Pdf-Conversion-Timeout-Secs` and an absolute Unix expiry in
`X-Pdf-Request-Deadline-Unix-Ms`. Synchronize clocks on all hosts. Uploads, queue
waits and conversion consume that expiry; each service checks again before
dispatch. Work is synchronous and bounded; no async GPU jobs are submitted.
Gateway and worker each admit at most two native deadline requests, bounding
their in-memory upload buffers; additional requests return a busy error.
At most two PDF operations are tracked locally, retaining their content lock
through response verification/publication if the original caller disconnects.

Set Infumap's MCP `timeout_secs` above the **whole** sidecar budget, for example
330 seconds for a 300-second fetch. The default sidecar budget is still 30 seconds
and may be too short for model startup or large PDFs. Timeouts remain errors.

PDF fetch never performs OCR or attempts `/pdf-extract`, `/convert`, image
caption extraction or an OCR-capable async job. The service rejects scans,
blank documents and detected unusable/incomplete native text; password,
corruption, timeout and service failures remain distinguishable. Successful
Markdown must carry native-only policy/version, `ocr_performed: false`, a native
backend/version and acceptable page diagnostics before it is returned or cached.
These checks are heuristic quality checks. Embedded text may have been produced
by OCR historically; this pipeline does not run OCR. Existing Infumap uploads
retain their existing OCR behavior.

## Cache and rendering controls

The complete configuration table is in the [README](README.md#fetch-configuration-and-behavior).
Boolean settings accept `true`/`false` or `1`/`0`; paths intended for persistent
caches must be absolute. Defaults use the user cache outside the checkout.

The PDF cache stores full PDF bytes, Markdown and provenance in private
`pdf-native-v1` directories, separate from the search-credit ledger. Keys are
SHA-256 content hashes under the native policy namespace. Cache reads verify
PDF and Markdown hashes and native metadata. Old OCR-backed or unverifiable
entries are never reused. Results are truncated with `maxChars` only afterwards.

Fresh source entries avoid browser/service calls. After the default 24-hour TTL,
the cached effective URL is revalidated using its ETag or Last-Modified where
available. A 304 reuses verified text; otherwise bytes are downloaded again and
their hash can reuse an unchanged extraction. If direct revalidation cannot
access a session-dependent resource, a fresh browser context loads the original
URL. All destinations and redirects retain public-address checks. Set
`WEB_FETCH_PDF_REFRESH=true` before starting the sidecar to bypass both source and
content hits and republish a fresh native conversion. Disable caching with
`WEB_FETCH_PDF_CACHE_ENABLED=false`.

Fixed lock stripes coalesce URL/content work across processes sharing the cache.
Each process limits artifact reads/hash verification to two concurrent operations.
Artifacts are staged then atomically indexed, so failed or interrupted writes
cannot become valid entries. Maintenance removes old/unreferenced generations
by age and budget and reclaims abandoned staging under its own lock. The default
artifact budget is 2 GiB; artifacts also have a 4,096-generation limit. Source
and object indexes are limited separately to 4,096 each (source records at most
16 KiB); lock stripes have a fixed file count. Filesystem overhead and these
small indexes are additional to the artifact byte budget. Cache failures skip
reuse/publication and leave ordinary fetching usable. Never put the cache in a
publicly served directory: PDF contents and source URLs can be private.

HTML readiness allows 750 ms minimum and up to three seconds for content to
settle, within the request deadline. It tracks main text changes rather than
requiring network silence. Main content/policy pages are protected during
consent cleanup; no consent choices are clicked. Links use the document's base
URL. Specific short challenge/refusal pages fail explicitly. These heuristics
can miss late content or unusual interstitials.

Downloaded text/HTML and rendered HTML have separate byte limits; rendered
documents also have a 50,000-element/200-level capture limit, a
100,000-node/256-level extraction limit and a 32 MiB Markdown expansion budget. Tables use
unpadded Markdown to avoid amplification from one very wide cell. Resource-limit
failures return errors rather than incomplete documents marked complete.
`WEB_FETCH_HTML_DUMP_DIR` enables unique, private raw rendered HTML dumps before
cleanup. It is off by default, has two concurrent write slots and is best effort;
operators manage retention. Dumps may contain session data and page secrets.

## Operator status and validation

Loopback `GET /status` includes configured byte/time/cache limits, executable
availability, browser runtime state and last-observed PDF capability status.
Reading it launches no browser, calls no GPU/provider service and exposes no
fetched URL, document content, service URL or keys. `executable_available` is a
static check, and `not_launched`/`not_checked` explicitly mean unverified.

Browser stderr is drained for the helper's entire lifetime, including after
DevTools connects. Failed fetches include the last 8 KiB of stderr in the
returned error and server logs, along with the underlying control-connection
error when available. This captures Chrome and sandbox diagnostics that would
otherwise be lost after startup.

Validation performed during implementation is production Linux compilation and
linting, formatting, shell/Python syntax and TOML parsing. No tests or browser,
installer, network-isolation, cache-race or PDF extraction exercises were run.
The macOS implementation has not been compiled or exercised. Authorized
behavioral validation remains necessary before treating these paths as proven
on a deployment host; the [plan](IMPLEMENTATION_PLAN.md) lists the scenarios.
