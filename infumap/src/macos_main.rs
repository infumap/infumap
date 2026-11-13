// Copyright (C) The Infumap Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

use clap::{Arg, ArgAction, Command};
use infumap::{setup, web};
use infusdk::util::infu::InfuResult;
use std::ffi::{CString, c_char};
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};

unsafe extern "C" {
  fn infumap_menu_bar_main(executable: *const c_char, settings: *const c_char) -> i32;
}

// JSON crosses only this local in-process bridge; credentials are never put in
// command-line arguments, logs, or an HTTP settings endpoint.
#[unsafe(no_mangle)]
unsafe extern "C" fn infumap_settings_request(settings: *const c_char, request: *const c_char) -> *mut c_char {
  let result = std::panic::catch_unwind(|| {
    if request.is_null() {
      return r#"{"ok":false,"error":"Missing settings request."}"#.to_owned();
    }
    let request = unsafe { std::ffi::CStr::from_ptr(request) }.to_str();
    let settings =
      if settings.is_null() { Ok(None) } else { unsafe { std::ffi::CStr::from_ptr(settings) }.to_str().map(Some) };
    match (settings, request) {
      (Ok(settings), Ok(request)) => infumap::settings::request(settings, request),
      _ => r#"{"ok":false,"error":"Settings input is not valid UTF-8."}"#.to_owned(),
    }
  })
  .unwrap_or_else(|_| r#"{"ok":false,"error":"Could not process settings."}"#.to_owned());
  CString::new(result).expect("JSON contains no literal NUL bytes").into_raw()
}

#[unsafe(no_mangle)]
unsafe extern "C" fn infumap_settings_free(response: *mut c_char) {
  if !response.is_null() {
    drop(unsafe { CString::from_raw(response) });
  }
}

fn main() {
  let matches = Command::new("infumap-macos")
    .version(env!("CARGO_PKG_VERSION"))
    .about("Runs Infumap from the macOS menu bar (Apple Silicon).")
    .arg(
      Arg::new("settings")
        .short('s')
        .long("settings")
        .num_args(1)
        .help("Settings file or directory; defaults to ~/.infumap/settings.toml"),
    )
    .arg(Arg::new("server").long("server").hide(true).action(ArgAction::SetTrue))
    .get_matches();
  let result = if matches.get_flag("server") {
    run_server(matches.get_one::<String>("settings"))
  } else {
    run_menu_bar(matches.get_one::<String>("settings"))
  };
  if let Err(error) = result {
    eprintln!("{error}");
    std::process::exit(1);
  }
}

fn run_menu_bar(settings: Option<&String>) -> InfuResult<()> {
  use std::os::unix::ffi::OsStrExt;
  let executable = CString::new(std::env::current_exe()?.as_os_str().as_bytes()).map_err(|error| error.to_string())?;
  let settings =
    settings.map(|settings| CString::new(settings.as_bytes())).transpose().map_err(|error| error.to_string())?;
  // AppKit owns the main thread until Quit. The strings outlive this call, and
  // the native entry point copies them before launching its child process.
  let status =
    unsafe { infumap_menu_bar_main(executable.as_ptr(), settings.as_ref().map_or(std::ptr::null(), |s| s.as_ptr())) };
  if status != 0 {
    return Err("Could not start the Infumap menu bar application.".into());
  }
  Ok(())
}

fn run_server(settings: Option<&String>) -> InfuResult<()> {
  let logs = dirs::home_dir().ok_or("Could not locate the home directory.")?.join("Library/Logs/Infumap");
  std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&logs)?;
  let lock =
    std::fs::OpenOptions::new().create(true).truncate(false).write(true).mode(0o600).open(logs.join("server.lock"))?;
  // The child also owns a lock: if the menu process crashes, a replacement
  // launcher cannot start another server while the old one is still draining.
  lock.try_lock().map_err(|error| format!("Another managed Infumap server is still running: {error}"))?;

  let runtime = tokio::runtime::Runtime::new()?;
  let (shutdown, receiver) = tokio::sync::watch::channel(false);
  let signal_shutdown = shutdown.clone();
  std::thread::spawn(move || {
    // A byte requests Stop; EOF also stops the server if the menu process dies.
    let _ = std::io::stdin().read(&mut [0u8; 1]);
    let _ = shutdown.send(true);
  });
  let mut control = web::ServerControl::new(receiver, |address| {
    let ip = match address.ip() {
      std::net::IpAddr::V4(ip) if ip.is_unspecified() => std::net::Ipv4Addr::LOCALHOST.into(),
      std::net::IpAddr::V6(ip) if ip.is_unspecified() => std::net::Ipv6Addr::LOCALHOST.into(),
      ip => ip,
    };
    // Stdout is a private readiness pipe. Diagnostics go to the log on stderr.
    let mut output = std::io::stdout().lock();
    writeln!(output, "INFUMAP_READY http://{}/", std::net::SocketAddr::new(ip, address.port()))?;
    output.flush()?;
    Ok(())
  });
  let result = runtime.block_on(async {
    use tokio::signal::unix::{SignalKind, signal};
    let mut interrupt = signal(SignalKind::interrupt())?;
    let mut terminate = signal(SignalKind::terminate())?;
    let mut hangup = signal(SignalKind::hangup())?;
    tokio::spawn(async move {
      tokio::select! {
        _ = interrupt.recv() => {},
        _ = terminate.recv() => {},
        _ = hangup.recv() => {},
      }
      let _ = signal_shutdown.send(true);
    });
    let config = setup::init_fs_maybe_and_get_config(settings).await?;
    web::start_server_controlled(config, false, Some(&mut control)).await
  });
  // The database guard in control must outlive runtime shutdown. This lets
  // blocking jobs finish while preventing new asynchronous database writes.
  drop(runtime);
  drop(control);
  drop(lock);
  result
}
