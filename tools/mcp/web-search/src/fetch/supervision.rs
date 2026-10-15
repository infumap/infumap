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

//! A private ownership socket and an independent guardian for one Chrome tree.
//! The guardian survives SIGKILL of the server/helper, then kills only its own
//! Chrome process group. No executable-name or profile-marker process scans.

#![cfg(unix)]

use std::io::{Read, Write};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixListener;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::error::InfuResult;

use super::proxy::cancelled;

pub(super) const GUARDIAN_FLAG: &str = "--infumap-browser-guardian";

pub(super) struct Ownership {
  stop: watch::Sender<bool>,
  task: JoinHandle<()>,
}

impl Ownership {
  pub fn bind(path: &Path) -> InfuResult<Self> {
    let listener =
      UnixListener::bind(path).map_err(|error| format!("Could not bind browser ownership socket: {error}"))?;
    let (stop, stopped) = watch::channel(false);
    let task = tokio::spawn(async move {
      let accepted = tokio::select! {
        biased;
        _ = cancelled(stopped.clone()) => return,
        accepted = listener.accept() => accepted,
      };
      // Only this accepted guardian can receive permission to launch Chrome.
      drop(listener);
      let Ok((mut stream, _)) = accepted else { return };
      if stream.write_all(&[1]).await.is_err() {
        return;
      }
      let mut ack = [0];
      tokio::select! {
        _ = cancelled(stopped) => {
          let _ = stream.write_all(&[0]).await;
          // Acknowledge only after killing/reaping the owned Chrome tree.
          let _ = stream.read_exact(&mut ack).await;
        },
        _ = stream.read_exact(&mut ack) => {},
      }
    });
    Ok(Self { stop, task })
  }

  pub fn is_finished(&self) -> bool {
    self.task.is_finished()
  }

  pub async fn shutdown(&mut self) {
    let _ = self.stop.send(true);
    let _ = (&mut self.task).await;
  }
}

impl Drop for Ownership {
  fn drop(&mut self) {
    // Deliberately do not abort the task: it must finish guardian cleanup even
    // if its caller is cancelled. Server death closes the socket in the kernel.
    let _ = self.stop.send(true);
  }
}

/// Run before any threads exist. stdin is a second lifeline from the immediate
/// helper, so a cancelled Chromiumoxide launch cannot strand the guardian.
pub(super) fn run_guardian(owner: &Path, mut chrome: Command) -> std::io::Result<i32> {
  // Separate the guardian from a wrapper/server process group before Chrome
  // starts. A forced group kill of the owner must not interrupt cleanup.
  // SAFETY: scalar-only syscall on this single-threaded internal subprocess.
  if unsafe { libc::setpgid(0, 0) } != 0 {
    return Err(std::io::Error::last_os_error());
  }
  // Do not inherit an ignored SIGCHLD disposition: waitid/WNOWAIT must
  // retain the owned child's PID until process-group cleanup completes.
  // SAFETY: a valid zero-initialized sigaction and initialized empty mask,
  // installed before any threads or children are created.
  let mut child_signal: libc::sigaction = unsafe { std::mem::zeroed() };
  child_signal.sa_sigaction = libc::SIG_DFL;
  if unsafe { libc::sigemptyset(&mut child_signal.sa_mask) } != 0
    || unsafe { libc::sigaction(libc::SIGCHLD, &child_signal, std::ptr::null_mut()) } != 0
  {
    return Err(std::io::Error::last_os_error());
  }
  #[cfg(target_os = "linux")]
  {
    // SAFETY: scalar-only syscall; affects only this guardian's descendants.
    if unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1) } != 0 {
      return Err(std::io::Error::last_os_error());
    }
    // Fail before spawning Chrome if this kernel does not expose the direct
    // child list needed to terminate adopted descendants in other groups.
    owned_children()?;
  }
  let mut ownership = std::os::unix::net::UnixStream::connect(owner)?;
  let mut start = [0];
  ownership.read_exact(&mut start)?;
  if start != [1] {
    return Err(std::io::Error::other("Browser ownership permission missing."));
  }
  let stopped = Arc::new(AtomicBool::new(false));
  let mut socket = ownership.try_clone()?;
  let socket_stop = stopped.clone();
  std::thread::spawn(move || {
    let _ = socket.read(&mut [0]);
    socket_stop.store(true, Ordering::Release);
  });
  let helper_stop = stopped.clone();
  std::thread::spawn(move || {
    let _ = std::io::stdin().read(&mut [0]);
    helper_stop.store(true, Ordering::Release);
  });
  // The group's leader is not reaped until after killpg, preventing PID/group
  // reuse from ever making cleanup target an unrelated process.
  chrome.process_group(0).stdin(Stdio::null());
  let mut child = chrome.spawn()?;
  let pid = child.id() as libc::pid_t;
  let result = loop {
    let mut status = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
    // SAFETY: valid output storage; WNOWAIT preserves ownership of the PID.
    let wait = unsafe {
      libc::waitid(libc::P_PID, pid as libc::id_t, status.as_mut_ptr(), libc::WEXITED | libc::WNOHANG | libc::WNOWAIT)
    };
    if wait != 0 {
      break Err(std::io::Error::last_os_error());
    }
    // SAFETY: successful waitid initialized siginfo_t (including a zero PID
    // when no child has exited). si_pid's accessor is platform-provided.
    if stopped.load(Ordering::Acquire) || unsafe { status.assume_init().si_pid() } != 0 {
      break Ok(());
    }
    std::thread::sleep(Duration::from_millis(20));
  };
  // SAFETY: this still-owned child created this process group; its leader has
  // not been reaped. All signals are confined to this browser's group.
  unsafe {
    libc::kill(-pid, libc::SIGKILL);
  }
  let exit = child.wait();
  #[cfg(target_os = "linux")]
  reap_descendants()?;
  // macOS has no subreaper here. Detached Crashpad handlers are not part of
  // this process group: their Mach exception servers exit when the last
  // Chrome client send right disappears. Do not scan for or signal them by
  // executable name. The acknowledgement covers the owned group, not a wait
  // for those detached handlers to finish their own shutdown.
  result?;
  let code = exit?.code().unwrap_or(125);
  // This is the exact private profile supplied by the owner, not a directory
  // scan. Also remove it after abrupt owner death, when TempDir cannot run.
  if let Some(profile) = owner.parent() {
    let _ = std::fs::remove_dir_all(profile);
  }
  ownership.write_all(&[1])?;
  Ok(code)
}

#[cfg(target_os = "linux")]
fn reap_descendants() -> std::io::Result<()> {
  // Chrome may create additional groups. As a subreaper, this guardian adopts
  // any survivors; enumerate only its own direct children, never all processes.
  loop {
    let mut status = 0;
    loop {
      let pid = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) };
      if pid > 0 {
        continue;
      }
      if pid < 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ECHILD) {
          return Ok(());
        }
        if error.raw_os_error() == Some(libc::EINTR) {
          continue;
        }
        return Err(error);
      }
      break;
    }
    for pid in owned_children()? {
      // Single reaping thread: these owned children cannot have their PIDs
      // reused until the next waitpid above.
      unsafe {
        libc::kill(pid, libc::SIGKILL);
      }
    }
    std::thread::sleep(Duration::from_millis(20));
  }
}

#[cfg(target_os = "linux")]
fn owned_children() -> std::io::Result<Vec<libc::pid_t>> {
  let path = format!("/proc/self/task/{}/children", std::process::id());
  Ok(std::fs::read_to_string(path)?.split_whitespace().filter_map(|value| value.parse().ok()).collect())
}

/// The helper retains the guardian's stdin and waits for it. On macOS this
/// also notices direct server death, where Linux uses PR_SET_PDEATHSIG.
pub(super) fn wait_guardian(mut child: Child) -> std::io::Result<i32> {
  let parent = unsafe { libc::getppid() };
  loop {
    if let Some(status) = child.try_wait()? {
      return Ok(status.code().unwrap_or(125));
    }
    if unsafe { libc::getppid() } != parent {
      drop(child.stdin.take());
    }
    std::thread::sleep(Duration::from_millis(20));
  }
}
