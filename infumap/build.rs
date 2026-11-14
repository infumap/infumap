use std::env;
use std::path::PathBuf;
use std::process::Command;

fn run(command: &mut Command) {
  let status = command.status().expect("Could not run the macOS native build tool");
  assert!(status.success(), "macOS native build failed: {command:?}");
}

fn main() {
  println!("cargo:rerun-if-changed=macos/menu_bar.m");
  println!("cargo:rerun-if-changed=macos/settings_window.m");
  println!("cargo:rerun-if-changed=macos/settings_window.h");
  if env::var_os("CARGO_FEATURE_MACOS_MENUBAR").is_none() {
    return;
  }
  assert_eq!(env::var("TARGET").unwrap(), "aarch64-apple-darwin", "The menu bar binary requires Apple Silicon macOS");
  assert!(
    env::var("HOST").unwrap().ends_with("-apple-darwin"),
    "Build the menu bar binary on macOS with Apple's Command Line Tools"
  );

  let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
  for source in ["menu_bar", "settings_window"] {
    run(
      Command::new("xcrun")
        .args([
          "clang",
          "-arch",
          "arm64",
          "-mmacosx-version-min=11.0",
          "-fobjc-arc",
          "-fblocks",
          "-Wall",
          "-Wextra",
          "-Werror",
          "-c",
          "-I",
        ])
        .arg(&out)
        .arg(format!("macos/{source}.m"))
        .arg("-o")
        .arg(out.join(format!("{source}.o"))),
    );
  }
  run(
    Command::new("xcrun")
      .args(["libtool", "-static", "-o"])
      .arg(out.join("libinfumap_menu_bar.a"))
      .arg(out.join("menu_bar.o"))
      .arg(out.join("settings_window.o")),
  );
  println!("cargo:rustc-link-search=native={}", out.display());
  println!("cargo:rustc-link-lib=static=infumap_menu_bar");
  println!("cargo:rustc-link-lib=framework=AppKit");
  println!("cargo:rustc-link-lib=framework=Foundation");
  println!("cargo:rustc-link-lib=dylib=objc");
}
