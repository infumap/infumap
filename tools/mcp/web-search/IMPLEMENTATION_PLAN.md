# Browser-backed web fetch and native PDF extraction

Implementation plan, October 15, 2026. Tests require separate authorization.

Step 1 is implemented: the PDF service and gateway expose `pdf_extract_native`
at `/pdf-extract-native`, with strict native quality checks and no OCR fallback.
Existing upload extraction retains its OCR policy. This establishes the service
boundary described in step 6.

Step 2 is implemented: fetch state/configuration, URL policy, direct downloads,
Chromiumoxide rendering, response-type dispatch, Markdown and PDF handling are
separate components under `src/fetch/`. Ordinary URLs use Chrome, while known
text-resource suffixes use direct HTTP with response classification. PDFs are
captured from the original browser response and reach a dedicated handler that
returns an explicit unavailable error until step 7 connects native extraction.
MCP names, arguments and compact response fields are unchanged.

The renderer includes a public-address connection proxy and basic per-request
ownership/deadlines as prerequisites. Step 3's full browser-network audit,
step 4's browser reuse/shutdown supervision, and step 5's content heuristics are
still outstanding. Browser installation remains step 9. Validation so far is
static compilation/linting only; behavioral checks require authorization.

The target is browser-rendered HTML and optional PDF-to-Markdown extraction
through configured GPU tools. PDF extraction must never perform OCR. If usable
text cannot be extracted without OCR, return an error. Browser installation
should be local to the user and handled by this sidecar's `run.sh`.

1. **Keep native-only fetches separate from existing upload extraction.**

   The existing `tools/gpu/pdf_extract` service automatically falls back to OCR
   after native extraction fails or its coverage assessment rejects the result.
   Its current native quality policy can also accept some unusable pages.
   Neither behavior satisfies strict native-only web fetches.

   Confirmed scope: strictly prohibit OCR for `web_fetch` PDF requests while
   retaining the existing extraction behavior for Infumap uploads. Add a
   dedicated native-only capability in the shared service; do not change the
   existing OCR-capable endpoint's default routing. Keep stricter native quality
   rules local to the new capability. Any further compatibility decision must
   be raised with the user before implementation.

   Keep the existing MCP endpoint names, arguments, compact result shape and
   `maxChars` truncation behavior as the proposed initial contract. Browser
   errors should be explicit rather than silently falling back to unrendered
   HTML. Outline/section retrieval and resumable MCP jobs are separate API work;
   ask before introducing changes to existing caller behavior.

2. **Separate fetching, rendering and extraction.**

   Refactor `src/fetch.rs` into a small dispatcher plus shared URL policy,
   bounded HTTP download, browser rendering, PDF extraction and Markdown
   normalization components. Introduce process-owned fetch state initialized
   from configuration in `src/main.rs`, separate from search-provider state.

   Use `chromiumoxide` for asynchronous Chrome DevTools Protocol control.
   Render HTML by default, retain direct handling of supported text/JSON
   resources, and route PDF bytes to the PDF handler. Detect PDFs using response
   type and a bounded `%PDF-` signature check, including extensionless URLs and
   redirects. A `.pdf` suffix alone is insufficient. Detect downloads reached
   during browser navigation too; do not return PDF-viewer UI as document text.

   Avoid downloading every HTML page twice just to look for PDFs. Use browser
   response/navigation metadata where practical, with bounded direct downloads
   for PDFs and non-HTML resources. Document how browser-session cookies are
   transferred when required for the actual PDF download, keeping them confined
   to the same fetch.

3. **Enforce destination policy across all browser traffic.**

   Reuse and review the existing scheme, credential, hostname, IP and redirect
   restrictions. Validate each direct-download redirect before connecting.
   Preserve the restriction on fetching search-engine documents.

   Extend the public-network restriction to scripts, frames, workers, XHR/fetch,
   WebSockets and browser-created targets. Establish connection-time address
   enforcement, using a controlled filtering proxy or network isolation, to
   prevent DNS rebinding and traffic outside request interception. Configure any
   proxy to avoid browser bypasses, including implicit loopback bypass. Fail
   closed when enforcement cannot be established. Browser interception alone
   or checking the landing URL afterwards is insufficient.

   Keep configured GPU-service traffic separate: an operator may deliberately
   configure a private service address, but a fetched document cannot choose
   that destination. Constrain discovery paths to the configured service and
   reject unexpected redirects rather than forwarding document bytes elsewhere.

4. **Implement browser ownership, deadlines and cleanup.**

   Start lazily and reuse one owned browser, initially with one active browser
   fetch. Use a unique temporary profile for the browser and a fresh isolated
   context for each request. Do not use the user's normal browser profile.

   Explicitly enable the Chrome sandbox and certificate validation, and select
   modern headless mode. Review library launch defaults rather than inheriting
   them blindly. Bound queueing, browser startup, navigation, content settling
   and extraction within one request deadline. Close contexts on errors,
   cancellation and timeouts; recycle an unresponsive browser.

   Own and reap the browser's processes on shutdown, including when `run.sh`
   stops or forcibly restarts the server. Avoid scanning for and killing all
   processes with generic Chrome/profile markers. Keep concurrency permits
   until the underlying browser work has actually stopped.

5. **Extract useful Markdown from the rendered page.**

   Wait for DOM readiness and a bounded opportunity for meaningful content to
   settle. Do not depend solely on navigation completion, a `body` element or
   network inactivity. Retain CSS and JavaScript needed for rendering; optional
   resource blocking must not prevent content from loading.

   Adapt Groundwork's guarded consent-UI removal and conservative Markdown
   cleanup. Protect main content and cookie/privacy policy pages. Keep links,
   tables and headings; resolve relative links against the document's effective
   base URL. Detect clear challenge/refusal pages conservatively and return a
   useful error instead of reporting them as extracted articles.

   Reuse the existing HTML-to-Markdown path where suitable. Bound DOM transfer
   and extraction memory separately from the returned character limit, and
   avoid silently presenting a resource-limit failure as a complete document.
   Add opt-in HTML dumps before cleanup, with unique filenames and no effect
   on fetch success when the diagnostic write fails.

6. **Provide a service-enforced native-only PDF capability.**

   Implement the native-only service contract in
   `tools/gpu/pdf_extract` and advertise it through `/gpu-tools` and the gateway.
   Use a dedicated capability such as
   `pdf_extract_native` at `/pdf-extract-native`, including gateway routing and
   GPU serialization. An older service without that capability is unavailable
   for this feature. Sending an optional header to an OCR-capable legacy
   endpoint and hoping it is honored is not sufficient.

   Keep `PdfPipelineOptions.do_ocr = False` throughout the native-only path.
   Never enter the OCR worker, initialize an OCR engine, or retry with OCR.
   Disable image descriptions, chart-to-text and other generative text
   substitutes. Layout analysis and table reconstruction using existing text
   remain allowed. Give native extraction its full conversion budget rather
   than reserving half for an OCR fallback.

   Audit parsed text provenance and reject unexpected OCR-derived output from
   the conversion. Reject scanned/no-text documents, unusable text layers and
   native conversion failures with a structured terminal document error, such
   as `pdf_native_text_unavailable`. Distinguish password, corruption, timeout
   and service-unavailable errors. Do not treat every native failure as proof
   that OCR would have worked.

   Do not silently accept a mixed document with identified unreadable textual
   pages. Tighten native coverage acceptance for this path rather than reusing
   the current document-wide OCR threshold. Preserve ordinary illustrations
   without inventing descriptions. Specify blank-document handling explicitly:
   for this fetch feature, return a no-readable-text error. These quality checks
   remain heuristics, not proof of complete or semantically correct extraction.

   Report an explicit native-only policy/version and `ocr_performed: false` in
   successful extraction metadata. Validate that metadata before caching or
   returning text. This is defense in depth; the service must enforce the rule
   before work begins. An existing text layer may itself have been created by
   OCR before upload; the guarantee is that this pipeline never performs OCR,
   not that it can establish the historical origin of embedded text.

7. **Connect web fetch to the configured PDF service.**

   Add optional `WEB_FETCH_GPU_TOOLS_URL` configuration. Adapt the discovery
   protocol already implemented in `infumap/src/ai/gpu_tools.rs` without pulling
   the main application's configuration/database dependencies into the sidecar.
   Upload bounded PDF bytes as multipart `file` data to the confirmed native-only
   endpoint, then consume Markdown and extraction metadata.

   Give PDF downloads their own byte limit; do not reuse the existing 512 KiB
   HTML limit. Coordinate it with the service upload limit. Bound response sizes
   too. Keep download, upload, queue and conversion deadlines explicit. Pass
   the remaining conversion allowance through `X-Pdf-Conversion-Timeout-Secs`.

   The current conversion header does not bound gateway/worker queue waits.
   Add or configure bounded waits so a request cannot wait beyond its overall
   budget and then start a full conversion after the MCP caller has timed out.
   Client disconnect alone is not a reliable worker cancellation mechanism.

   Initially use a bounded synchronous native-only request and document an MCP
   `timeout_secs` above the total fetch budget. If extraction cannot fit, return
   a clear timeout; do not silently submit untracked background work. The
   gateway's existing async job API does not remove MCP deadlines, and any
   future use must preserve native-only policy through submission and execution.

   A missing service or missing native-only capability must produce a clear PDF
   error while HTML fetching and search remain usable. `run.sh` must not install
   Docling, OCR packages or GPU models as part of browser setup.

8. **Cache full native-only PDF results.**

   Store the downloaded PDF, complete extracted Markdown and extraction metadata
   outside the checkout, with atomic publication only after successful policy
   validation. Use per-document request coalescing so simultaneous fetches do
   not repeat conversion. Account for multiple processes sharing a cache.

   Associate results with content hashes and extraction policy/version, including
   the no-OCR guarantee. Never reuse old OCR-backed results or entries whose
   provenance is unknown. Apply `maxChars` after loading the full conversion.
   Add bounded disk usage, expiration/revalidation with HTTP validators where
   available, cleanup of incomplete entries and an explicit refresh mechanism.
   Keep document-cache storage separate from the search-credit ledger.

9. **Install and discover the browser from `run.sh`.**

   Add a Rust bootstrap command, invoked after the wrapper builds the server,
   to resolve `WEB_FETCH_BROWSER_PATH`, a usable managed installation, or a
   suitable installed Chrome/Chromium. If none works, download an official
   Chrome for Testing archive to
   `${XDG_CACHE_HOME:-$HOME/.cache}/infumap-web-search/browsers/`.

   Select an explicit supported version and platform from official download
   metadata. Support Linux x86_64/ARM64 and macOS Intel/ARM64 where artifacts
   and host dependencies are available. Use locked, bounded downloads, safe ZIP
   extraction and atomic installation. Reuse cached installations offline and
   across restarts. Provide a deliberate update operation rather than updating
   on every restart; document how browser security updates are maintained.

   Establish launch readiness with the required sandbox, network policy and
   certificate settings during implementation validation only when authorized.
   Runtime setup should diagnose missing libraries or sandbox restrictions and
   explain remediation without automatically using `sudo`, installing global
   packages or disabling the sandbox. A musl server binary does not make the
   downloaded Chrome binary independent of its host's libraries.

   Browser setup failures must leave search usable and make affected HTML
   requests fail clearly; avoid a supervisor restart/download loop. Make the
   selected executable and readiness visible in operator diagnostics.

10. **Document configuration and perform authorized validation.**

    Update this directory's README, `tools/mcp/README.md`, relevant GPU service
    documentation, and configuration examples. Document browser discovery and
    updates, native-only capability requirements, cache controls, limits,
    timeouts, host dependencies and the absence of OCR fallback. Add fetch and
    PDF readiness to the loopback operator status without leaking fetched URLs,
    document contents or configuration secrets. Keep ordinary MCP results
    compact.

    Run appropriate production compilation, formatting, lint and shell syntax
    checks after implementation, plus `git diff --check`. Do not write, update
    or run tests unless explicitly requested under the repository instructions.
    Browser launch probes and extraction exercises are behavioral validation;
    request explicit authorization before running those too.

    Once authorized, cover static and JavaScript pages, redirects, extensionless
    PDFs, native-text PDFs, scans, mixed readable/unreadable pages, corrupt and
    encrypted files, old OCR-capable services, cache provenance, cancellation,
    queue deadlines, browser cleanup and restricted-network destinations. Observe
    service dispatch to establish that rejected documents never launch OCR;
    rejecting an OCR result after it was produced does not satisfy the rule.

Reference implementations and design sources:

- `../fundamental/rproc/src/util/chrome.rs` (relative to the repository root):
  browser lifecycle and bounded concurrency.
- `../groundwork/src/web/`: PDF dispatch/cache, consent cleanup, block-page
  detection and rendered-HTML diagnostics. Adapt ideas rather than importing
  its site-specific rules or ingestion/catalog pipeline.
- `tools/gpu/pdf_extract/` and `tools/gpu/gateway/`: existing extraction,
  discovery, deadlines and GPU serialization; currently OCR-capable.
- [Chromiumoxide](https://github.com/mattsse/chromiumoxide),
  [Chrome headless](https://developer.chrome.com/docs/automation-and-testing/headless),
  [Chrome for Testing downloads](https://github.com/GoogleChromeLabs/chrome-for-testing).
