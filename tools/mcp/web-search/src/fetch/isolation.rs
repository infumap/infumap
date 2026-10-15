// Copyright (C) The Infumap Authors
// This file is part of Infumap.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

//! OS-enforced network confinement for Chrome and all its descendants.
//!
//! Linux gives Chrome a network namespace with loopback only. Filesystem Unix
//! sockets bridge the filtering proxy and DevTools across that boundary. macOS
//! uses Seatbelt to allow outbound TCP only to the filtering proxy's local port.
//! There is deliberately no unconfined fallback.

use std::ffi::OsString;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use chromiumoxide::BrowserConfig;
use serde::{Deserialize, Serialize};
use tokio::time::Instant;

use crate::error::InfuResult;

#[cfg(target_os = "linux")]
use super::proxy::AbortTask;

const HELPER_FLAG: &str = "--infumap-isolated-browser";
const HELPER_ENV: &str = "INFUMAP_BROWSER_CONFINEMENT";

#[derive(Serialize, Deserialize)]
struct HelperConfig {
  browser: PathBuf,
  proxy_address: SocketAddr,
  proxy_socket: PathBuf,
  devtools_socket: PathBuf,
  devtools_address: SocketAddr,
}

pub(super) struct Isolation {
  config: HelperConfig,
  #[cfg(target_os = "linux")]
  _relays: Vec<AbortTask>,
}

impl Isolation {
  pub async fn prepare(
    profile: &Path,
    proxy_address: SocketAddr,
    browser: PathBuf,
    deadline: Instant,
  ) -> InfuResult<Self> {
    let config = HelperConfig {
      browser,
      proxy_address,
      proxy_socket: profile.join("proxy.sock"),
      devtools_socket: profile.join("devtools.sock"),
      devtools_address: proxy_address,
    };
    #[cfg(target_os = "linux")]
    {
      let mut config = config;
      let (address, relays) = prepare_relays(&config, deadline).await?;
      config.devtools_address = address;
      Ok(Self { config, _relays: relays })
    }
    #[cfg(target_os = "macos")]
    {
      let _ = deadline;
      if !Path::new("/usr/bin/sandbox-exec").is_file() {
        return Err("Browser network confinement requires macOS sandbox-exec.".into());
      }
      Ok(Self { config })
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
      let _ = (config, deadline);
      Err("Browser network confinement is not implemented on this platform.".into())
    }
  }

  pub fn launch_config(&self, builder: chromiumoxide::browser::BrowserConfigBuilder) -> InfuResult<BrowserConfig> {
    let executable = std::env::current_exe().map_err(|error| format!("Could not locate browser helper: {error}"))?;
    let config = serde_json::to_string(&self.config).map_err(|_| "Could not encode browser confinement settings.")?;
    builder
      .chrome_executable(executable)
      .arg(HELPER_FLAG)
      .env(HELPER_ENV, config)
      .build()
      .map_err(|error| format!("Could not configure isolated browser: {error}").into())
  }
}

/// Internal subprocess entry point, called before the server runtime exists.
pub(super) fn run_browser_helper() -> Option<i32> {
  if !std::env::args_os().any(|arg| arg == HELPER_FLAG) {
    return None;
  }
  let result = (|| {
    let raw = std::env::var(HELPER_ENV).map_err(|_| "Browser confinement settings are missing.".to_owned())?;
    let config: HelperConfig =
      serde_json::from_str(&raw).map_err(|_| "Browser confinement settings are invalid.".to_owned())?;
    let args: Vec<OsString> = std::env::args_os().skip(1).filter(|arg| arg != HELPER_FLAG).collect();
    run_confined(config, args).map_err(|error| error.to_string())
  })();
  Some(match result {
    Ok(code) => code,
    Err(error) => {
      eprintln!("Browser network confinement failed; refusing unconfined launch: {error}");
      125
    }
  })
}

#[cfg(target_os = "linux")]
async fn prepare_relays(config: &HelperConfig, deadline: Instant) -> InfuResult<(SocketAddr, Vec<AbortTask>)> {
  use tokio::io::copy_bidirectional;
  use tokio::net::{TcpListener, TcpStream, UnixListener, UnixStream};
  use tokio::task::JoinSet;
  use tokio::time::timeout_at;

  let proxy = UnixListener::bind(&config.proxy_socket)
    .map_err(|error| format!("Could not bind isolated proxy bridge: {error}"))?;
  let proxy_address = config.proxy_address;
  let proxy_task = AbortTask(tokio::spawn(async move {
    let mut connections = JoinSet::new();
    loop {
      tokio::select! {
        _ = tokio::time::sleep_until(deadline) => break,
        _ = connections.join_next(), if !connections.is_empty() => {},
        accepted = proxy.accept() => {
          let Ok((mut stream, _)) = accepted else { break };
          if connections.len() >= 64 { continue; }
          connections.spawn(async move {
            let _ = timeout_at(deadline, async {
              let mut upstream = TcpStream::connect(proxy_address).await?;
              copy_bidirectional(&mut stream, &mut upstream).await
            }).await;
          });
        }
      }
    }
  }));
  let debug = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
    .await
    .map_err(|error| format!("Could not bind isolated DevTools bridge: {error}"))?;
  let address = debug.local_addr().map_err(|error| format!("Could not inspect isolated DevTools bridge: {error}"))?;
  let path = config.devtools_socket.clone();
  let debug_task = AbortTask(tokio::spawn(async move {
    let mut connections = JoinSet::new();
    loop {
      tokio::select! {
        _ = tokio::time::sleep_until(deadline) => break,
        _ = connections.join_next(), if !connections.is_empty() => {},
        accepted = debug.accept() => {
          let Ok((mut stream, _)) = accepted else { break };
          if connections.len() >= 8 { continue; }
          let path = path.clone();
          connections.spawn(async move {
            let _ = timeout_at(deadline, async {
              let mut upstream = UnixStream::connect(path).await?;
              copy_bidirectional(&mut stream, &mut upstream).await
            }).await;
          });
        }
      }
    }
  }));
  Ok((address, vec![proxy_task, debug_task]))
}

#[cfg(target_os = "linux")]
fn run_confined(config: HelperConfig, mut args: Vec<OsString>) -> std::io::Result<i32> {
  use std::io::{BufRead, BufReader, Write};
  use std::os::unix::process::CommandExt;
  use std::process::{Command, Stdio};

  // Do not carry host-network sockets supplied by a supervisor into the new
  // namespace. Only stdio pipes are part of the helper protocol.
  let descriptors: Vec<_> = std::fs::read_dir("/proc/self/fd")?
    .filter_map(Result::ok)
    .filter_map(|entry| entry.file_name().to_str()?.parse::<libc::c_int>().ok())
    .filter(|descriptor| *descriptor > 2)
    .collect();
  for descriptor in descriptors {
    // SAFETY: single-threaded helper; only enumerated non-stdio FDs are closed.
    unsafe {
      libc::close(descriptor);
    }
  }
  // SAFETY: getppid has no pointer arguments.
  let server_pid = unsafe { libc::getppid() };
  enter_network_namespace()?;
  // SAFETY: no pointers; arrange cleanup if the owning MCP server disappears.
  if unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) } != 0 {
    return Err(std::io::Error::last_os_error());
  }
  // SAFETY: getppid has no pointer arguments. Close the parent-death race.
  if unsafe { libc::getppid() } != server_pid {
    return Err(std::io::Error::other("Browser owner exited during confinement setup."));
  }
  let proxy = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
  let proxy_address = proxy.local_addr()?;
  let debug = std::os::unix::net::UnixListener::bind(&config.devtools_socket)?;
  // This namespace has no external interfaces/routes. Its only outbound path
  // is this filesystem Unix socket to the parent-owned filtering proxy.
  std::thread::spawn(move || {
    relay_connections(proxy.incoming(), move || std::os::unix::net::UnixStream::connect(&config.proxy_socket));
  });
  std::thread::spawn(move || {
    relay_connections(debug.incoming(), || std::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, 9222)));
  });

  args.retain(|arg| {
    let arg = arg.to_string_lossy();
    !arg.starts_with("--proxy-server=")
      && !arg.starts_with("--remote-debugging-port=")
      && !arg.starts_with("--remote-debugging-address=")
  });
  args.extend([
    format!("--proxy-server=http://{proxy_address}").into(),
    "--remote-debugging-address=127.0.0.1".into(),
    "--remote-debugging-port=9222".into(),
  ]);
  let parent_pid = std::process::id();
  let mut command = Command::new(&config.browser);
  command.args(args).env_remove(HELPER_ENV).stdin(Stdio::null()).stderr(Stdio::piped());
  // SAFETY: the post-fork closure only uses async-signal-safe Linux syscalls.
  unsafe {
    command.pre_exec(move || {
      if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
        return Err(std::io::Error::last_os_error());
      }
      if libc::getppid() != parent_pid as libc::pid_t {
        libc::_exit(125);
      }
      Ok(())
    });
  }
  let mut child = command.spawn()?;
  let stderr = child.stderr.take().ok_or_else(|| std::io::Error::other("Chrome stderr is unavailable."))?;
  // Chromiumoxide connects to the parent's loopback relay, never to this
  // namespace's loopback. All other Chrome arguments and diagnostics survive.
  let outside = config.devtools_address;
  std::thread::spawn(move || {
    for line in BufReader::new(stderr).lines() {
      let Ok(line) = line else { break };
      let line = line.replace("ws://127.0.0.1:9222/", &format!("ws://{outside}/"));
      let _ = writeln!(std::io::stderr(), "{line}");
    }
  });
  Ok(child.wait()?.code().unwrap_or(125))
}

#[cfg(target_os = "linux")]
fn enter_network_namespace() -> std::io::Result<()> {
  use std::os::fd::AsRawFd;

  // SAFETY: these syscalls have no pointers; this subprocess is single-threaded.
  let (uid, gid) = unsafe { (libc::getuid(), libc::getgid()) };
  if uid == 0 {
    return Err(std::io::Error::other("Run the browser as an unprivileged user."));
  }
  // SAFETY: called before creating threads; privileges apply only to the new
  // user namespace. No host namespace or system configuration is modified.
  if unsafe { libc::unshare(libc::CLONE_NEWUSER | libc::CLONE_NEWNET) } != 0 {
    return Err(std::io::Error::other(format!(
      "Linux user/network namespaces are unavailable: {}",
      std::io::Error::last_os_error()
    )));
  }
  std::fs::write("/proc/self/uid_map", format!("{uid} {uid} 1\n"))?;
  std::fs::write("/proc/self/setgroups", "deny\n")?;
  std::fs::write("/proc/self/gid_map", format!("{gid} {gid} 1\n"))?;
  let socket = std::net::UdpSocket::bind((std::net::Ipv4Addr::UNSPECIFIED, 0))?;
  // SAFETY: zero is a valid initial representation for the Linux ifreq struct;
  // both ioctls receive its valid pointer and the interface name is terminated.
  let mut interface: libc::ifreq = unsafe { std::mem::zeroed() };
  interface.ifr_name[0] = b'l' as libc::c_char;
  interface.ifr_name[1] = b'o' as libc::c_char;
  if unsafe { libc::ioctl(socket.as_raw_fd(), libc::SIOCGIFFLAGS, &mut interface) } != 0 {
    return Err(std::io::Error::last_os_error());
  }
  // SAFETY: SIOCGIFFLAGS initialized the flags field of this union.
  unsafe {
    interface.ifr_ifru.ifru_flags |= libc::IFF_UP as libc::c_short;
  }
  if unsafe { libc::ioctl(socket.as_raw_fd(), libc::SIOCSIFFLAGS, &interface) } != 0 {
    return Err(std::io::Error::last_os_error());
  }
  Ok(())
}

#[cfg(target_os = "linux")]
fn relay_connections<S, T>(
  incoming: impl Iterator<Item = std::io::Result<S>>,
  connect: impl Fn() -> std::io::Result<T> + Send + Sync + 'static,
) where
  S: RelayStream,
  T: RelayStream,
{
  use std::sync::Arc;
  use std::sync::atomic::{AtomicUsize, Ordering};

  let connect = Arc::new(connect);
  let active = Arc::new(AtomicUsize::new(0));
  for stream in incoming {
    let Ok(mut stream) = stream else { break };
    if active.fetch_add(1, Ordering::Relaxed) >= 64 {
      active.fetch_sub(1, Ordering::Relaxed);
      continue;
    }
    let (connect, active) = (connect.clone(), active.clone());
    std::thread::spawn(move || {
      if let Ok(mut upstream) = connect()
        && let (Ok(mut reader), Ok(mut writer)) = (stream.duplicate(), upstream.duplicate())
      {
        let reverse = std::thread::spawn(move || {
          let _ = std::io::copy(&mut reader, &mut writer);
          writer.close_write();
        });
        let _ = std::io::copy(&mut upstream, &mut stream);
        stream.close_write();
        let _ = reverse.join();
      }
      active.fetch_sub(1, Ordering::Relaxed);
    });
  }
}

#[cfg(target_os = "linux")]
trait RelayStream: std::io::Read + std::io::Write + Send + Sized + 'static {
  fn duplicate(&self) -> std::io::Result<Self>;
  fn close_write(&self);
}

#[cfg(target_os = "linux")]
impl RelayStream for std::net::TcpStream {
  fn duplicate(&self) -> std::io::Result<Self> {
    self.try_clone()
  }
  fn close_write(&self) {
    let _ = self.shutdown(std::net::Shutdown::Write);
  }
}

#[cfg(target_os = "linux")]
impl RelayStream for std::os::unix::net::UnixStream {
  fn duplicate(&self) -> std::io::Result<Self> {
    self.try_clone()
  }
  fn close_write(&self) {
    let _ = self.shutdown(std::net::Shutdown::Write);
  }
}

#[cfg(target_os = "macos")]
fn run_confined(config: HelperConfig, args: Vec<OsString>) -> std::io::Result<i32> {
  use std::os::unix::process::CommandExt;
  // This helper is single-threaded and carries no inherited socket protocol.
  // Drop any supervisor FDs before applying the process network sandbox.
  // SAFETY: sysconf has no pointer arguments.
  let limit = unsafe { libc::sysconf(libc::_SC_OPEN_MAX) };
  if !(3..=libc::c_int::MAX as libc::c_long).contains(&limit) {
    return Err(std::io::Error::other("Could not establish inherited-descriptor bounds."));
  }
  for descriptor in 3..limit as libc::c_int {
    // SAFETY: single-threaded; only non-stdio descriptors are closed.
    unsafe {
      libc::close(descriptor);
    }
  }
  // Permit filesystem Unix IPC and listening sockets used by Chrome itself,
  // but outbound IP traffic can only reach this request's loopback TCP proxy.
  let profile = format!(
    r#"(version 1) (allow default) (deny network-outbound (remote ip))
    (allow network-outbound (remote tcp4 "localhost:{}"))"#,
    config.proxy_address.port()
  );
  Err(
    std::process::Command::new("/usr/bin/sandbox-exec")
      .arg("-p")
      .arg(profile)
      .arg(config.browser)
      .args(args)
      .env_remove(HELPER_ENV)
      .stdin(std::process::Stdio::null())
      .exec(),
  )
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn run_confined(_: HelperConfig, _: Vec<OsString>) -> std::io::Result<i32> {
  Err(std::io::Error::other("Browser network confinement is unsupported on this platform."))
}
