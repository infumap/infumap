# Web-fetch network policy

Steps 3–4 implementation, October 15, 2026. This is a source-level policy review;
no browser launch, network exercise or test has been performed.

The fetched URL is untrusted. A browser executable and the host's network and
sandbox configuration are operator-controlled. Chrome's own sandbox and TLS
certificate validation remain enabled. OS network confinement is additional
protection, not a substitute for the browser sandbox.

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

4. **macOS browser boundary.** The internal helper starts the guardian/Chrome
   through system `sandbox-exec`, with outbound IP traffic denied except IPv4
   TCP to the owned browser's filtering proxy port. Restrictions are inherited
   by descendants; filesystem Unix IPC remains available for Chrome's normal
   sandbox and the ownership protocol. The policy also denies execution of
   `chrome_crashpad_handler`: Crashpad deliberately detaches into another
   session, and macOS lacks Linux subreaping. This keeps the optional crash
   daemon outside the launch contract instead of attempting global process
   matching. Missing/rejected sandbox support causes a launch error. This path,
   including Chrome's behavior when that daemon is denied, needs separate
   compilation and behavioral validation on macOS.

5. **Interception and browser settings.** Document URLs retain the search-engine
   restriction, and frames/requests receive URL checks as well. Non-network
   `data:`, `blob:` and `about:` child content may render, but any network
   requests it initiates encounter the same OS/proxy boundary. WebSocket URLs
   receive the corresponding HTTP/HTTPS address checks. Proxy flags supply no
   DIRECT fallback and remove implicit loopback bypass; local name resolution
   and QUIC are disabled. Explicit launch options preserve popup and IPC
   flooding protections that the library's default automation flags disabled.
   These flags and request interception are defense in depth; OS confinement
   covers workers and browser-created targets outside the page's event stream.

6. **GPU services.** No GPU requests are enabled in `web_fetch` yet. PDF bytes
   reach a handler that returns an unavailable error without contacting a
   service. Step 7 must create a separate client from operator configuration,
   permit private addresses only for that configured origin, disable redirects,
   and validate advertised endpoint paths without accepting authorities,
   schemes, credentials or path escapes supplied by discovery. Upload the
   already-downloaded bytes; never ask that service to fetch a page-selected
   URL. A public URL must never become a service configuration or bypass the
   public downloader's policy.

Host configuration can prevent a confined browser from starting, particularly
when user namespaces are restricted. The server does not install privileged
helpers, change firewall/AppArmor settings, disable Chrome's sandbox or retry
without confinement. Search and direct text downloads do not need the browser
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
and reap adopted descendants that changed sessions. No process-name/profile
scan is used. A cleanup acknowledgement follows reaping and removal of that
exact private profile. A cancelled startup cannot launch Chrome after permission
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
