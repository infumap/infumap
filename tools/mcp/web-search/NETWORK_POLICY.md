# Web-fetch network policy

Steps 3–4 implementation, October 15, 2026, with the approved native macOS
revision. This is a source-level policy review; no browser launch, network
exercise or test has been performed in this development environment. Operator
macOS logs identified the previous outer sandbox's startup failures.

The fetched URL is untrusted. A browser executable and the host's network and
sandbox configuration are operator-controlled. Chrome's own sandbox and TLS
certificate validation remain enabled. Linux has an additional OS network
boundary. Native macOS uses the filtering proxy and request checks without that
additional boundary; Chrome's own sandbox remains required on both platforms.

1. **Direct documents.** `policy::document_addresses` validates the document
   URL and resolves all addresses before a connection is attempted. Any local,
   metadata, reserved, translation/tunnel or otherwise rejected address rejects
   the result. A custom reqwest resolver returns only that validated address
   set for that host and has no system-DNS fallback. Each redirect is handled
   explicitly and receives the same checks. The URL hostname remains available
   for TLS validation; redirects and environment proxies are disabled in the
   HTTP client.

2. **Browser proxy.** All proxied connections resolve and validate their own
   destination immediately before connecting to a literal `SocketAddr`.
   Resolution used for page interception is not relied on to prevent rebinding.
   HTTP and WebSocket upgrades use pinned sockets; HTTPS and secure WebSockets
   use CONNECT tunnels to pinned sockets. Proxy requests cannot choose a
   different upstream through their Host header. Only HTTP/HTTPS and their
   WebSocket forms are accepted; credentials and invalid ports are rejected.
   At most 64 client connections/tunnels are
   active, with permits held across upgrades. Each fetch activates a separate
   network session; idle traffic is rejected. Cancellation, completion and the
   request deadline stop forwarding. Session revocation drains all connection
   permits before another fetch can own the browser.

3. **Linux browser boundary.** The server invokes itself in an internal helper
   mode before starting Tokio. The helper closes non-stdio inherited FDs,
   creates unprivileged user and network namespaces, maps only the calling
   user's UID/GID, and brings up loopback without external interfaces/routes.
   Chrome and all descendants inherit that network namespace. Even a browser
   channel that ignores proxy flags has no route to the host/private/public
   network. A filesystem Unix socket in the private temporary profile bridges
   its local HTTP proxy to the parent's filtering proxy. A separate bridge
   exposes its DevTools connection to the parent, with no arbitrary destination
   chosen by page data. Relays last for the owned browser, while the filtering
   proxy limits outbound connections to the active request's session/deadline.
   A parent-death signal terminates the namespace helper; the independent
   guardian closes the Chrome tree (see ownership below). Namespace or interface
   setup errors stop launch before Chrome is started.

4. **Native macOS policy.** The internal helper starts the guardian directly,
   which launches native Chrome with its own sandbox enabled. An outer
   `sandbox-exec` wrapper prevents Chrome's child processes from initializing
   their own Seatbelt sandboxes; operator logs confirmed these failures. The
   previous wrapper and its Crashpad execution denial have been removed.
   Filtering proxy configuration, public-address validation, request
   interception, and proxy-bypass controls remain enabled. They provide no
   OS-enforced guarantee that browser channels outside interception cannot
   bypass the proxy. This platform-specific policy was explicitly approved;
   run the Linux server, optionally in a VM, when the OS boundary is required.
   Status reports `network_policy: "proxy_only"` and
   `network_confinement_required: false` on macOS, while
   `browser_sandbox_required` remains true. The revised native macOS path needs
   separate compilation and behavioral validation on macOS.

5. **Interception and browser settings.** Document URLs retain the search-engine
   restriction, and frames/requests receive URL checks as well. Non-network
   `data:`, `blob:` and `about:` child content may render, but any network
   requests it initiates encounter the same platform-specific proxy/OS policy. WebSocket URLs
   receive the corresponding HTTP/HTTPS address checks. Proxy flags supply no
   DIRECT fallback and remove implicit loopback bypass; local name resolution
   and QUIC are disabled. Explicit launch options preserve popup and IPC
   flooding protections that the library's default automation flags disabled.
   On Linux, these flags and request interception are defense in depth; OS
   confinement covers workers and browser-created targets outside the page's
   event stream. On macOS, the proxy/flags do not provide that OS guarantee.

6. **GPU services.** A separate, operator-configured HTTP(S) origin can
   deliberately be private. Page URLs never choose this configuration. Discovery
   accepts only schema 1, the fixed `/pdf-extract-native` POST path, native-only
   policy/version and the absolute-deadline protocol. The client constructs the
   path beneath the configured prefix itself and rejects all redirects; it never
   uses a discovery-supplied authority, scheme, query or alternate endpoint.
   Uploaded bytes come from the bounded public downloader/browser response;
   the service never receives a page-selected URL to fetch. Native metadata and
   diagnostics are validated before returning or caching text. No OCR-capable
   fallback or async job is used. The gateway verifies its upstream worker's
   capability and both enforce absolute upload/queue/conversion expiry.

7. **Native PDF cache.** A private policy-versioned cache holds full PDF bytes,
   Markdown and provenance. Content hashes and native policy diagnostics are
   checked on reads. Fresh sources can reuse text; expired sources revalidate
   their effective URL with the same public URL/address/redirect policy and
   validators when available. Failed direct revalidation can use a fresh browser
   context for the original URL. Striped process-shared locks coalesce work;
   staged artifacts and atomic indexes prevent partial publication. The cache
   does not grant a document any new network/service authority. Loopback status
   exposes no source URL, content, GPU origin or keys and performs no probes.

Host configuration can prevent a confined browser from starting, particularly
when user namespaces are restricted. The server does not install privileged
helpers, change firewall/AppArmor settings, disable Chrome's sandbox or retry
without confinement on Linux. Native macOS intentionally uses the policy in
point 4. Search and direct text downloads do not need the browser
helper.

The browser is launched lazily into a unique temporary profile. Each fetch
creates an isolated context with `disposeOnDetach` and denies downloads in that
context. Successful/error paths dispose the context; cancellation, timeout,
control-channel failure or uncertain context creation cause browser recycling.
One request deadline bounds queueing, startup and document work. Cleanup is
outside the cancellable request future, so the browser slot remains held until
its network/process work has stopped even if the caller has already timed out.

An independent guardian receives launch permission over a private Unix socket
before spawning Chrome in a new process group. It watches both that ownership
socket and its helper's stdin lifeline. Owner/helper death or a shutdown command
ends the Chrome group; Chrome's group leader remains unreaped until after the
signal, preventing PID reuse from targeting unrelated processes. Linux also
uses `PR_SET_CHILD_SUBREAPER` and reads only its own direct-child list to kill
and reap adopted descendants that changed sessions. macOS permits Crashpad's
normal detached handlers: their Mach exception servers stop on a no-senders
notification when their last client disappears. Their shutdown is managed by
Crashpad; the guardian does not reap or await these detached handlers. No
process-name/profile scan is used. A cleanup acknowledgement follows owned-group
reaping (plus adopted descendants on Linux) and removal of that exact private
profile. A cancelled startup cannot launch Chrome after permission
has been revoked. SIGINT/SIGTERM abort HTTP handlers and await this cleanup;
`run.sh` forces a stuck server after five seconds, leaving the independent
guardian able to finish cleanup after server SIGKILL.

Compilation and linting establish that the Linux implementation builds; they
do not establish end-to-end isolation on deployed hosts. Browser/redirect,
WebSocket, WebRTC, child-target and cancellation exercises require explicit
authorization under this repository's no-tests rule.

Design references:

- [Linux network namespaces](https://man7.org/linux/man-pages/man7/network_namespaces.7.html)
  and [user namespaces](https://man7.org/linux/man-pages/man7/user_namespaces.7.html).
- [Chromium proxy configuration](https://github.com/chromium/chromium/blob/main/net/docs/proxy.md).
- [Chromium's non-proxied TURN issue](https://issues.chromium.org/issues/41345813):
  proxy flags alone are insufficient for the intended boundary.
- [IANA IPv4](https://www.iana.org/assignments/iana-ipv4-special-registry/)
  and [IPv6 special-purpose registries](https://www.iana.org/assignments/iana-ipv6-special-registry/).
- [Azure platform virtual IP](https://learn.microsoft.com/en-us/azure/virtual-network/what-is-ip-address-168-63-129-16).

- [Linux wait semantics, including WNOWAIT](https://man7.org/linux/man-pages/man2/waitpid.2.html)
  and [child subreapers](https://man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html).
- [Crashpad subprocess detachment](https://github.com/chromium/crashpad/blob/main/util/posix/spawn_subprocess.cc)
  and [Chrome's macOS Crashpad startup](https://github.com/chromium/chromium/blob/main/components/crash/core/app/crashpad_mac.mm).
- [Crashpad's macOS no-senders shutdown](https://github.com/chromium/crashpad/blob/main/handler/mac/exception_handler_server.cc).
- [Chromium's Seatbelt initialization](https://github.com/chromium/chromium/blob/main/sandbox/mac/seatbelt.cc)
  and [nested sandbox limitations](https://bazel.build/versions/7.5.0/docs/sandboxing).
