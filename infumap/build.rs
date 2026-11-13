use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

fn run(command: &mut Command) {
  let status = command.status().expect("Could not run the macOS native build tool");
  assert!(status.success(), "macOS native build failed: {command:?}");
}

fn main() {
  println!("cargo:rerun-if-changed=macos/menu_bar.m");
  println!("cargo:rerun-if-changed=../web/src/assets/favicon.ico");
  if env::var_os("CARGO_FEATURE_MACOS_MENUBAR").is_none() {
    return;
  }
  assert_eq!(env::var("TARGET").unwrap(), "aarch64-apple-darwin", "The menu bar binary requires Apple Silicon macOS");
  assert!(
    env::var("HOST").unwrap().ends_with("-apple-darwin"),
    "Build the menu bar binary on macOS with Apple's Command Line Tools"
  );

  let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
  let icon = fs::read("../web/src/assets/favicon.ico").expect("Could not read the Infumap icon");
  let bytes = icon.iter().map(|byte| byte.to_string()).collect::<Vec<_>>().join(",");
  fs::write(out.join("icon.h"), format!("static const unsigned char infumap_icon[] = {{{bytes}}};\n")).unwrap();
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
        "macos/menu_bar.m",
        "-I",
      ])
      .arg(&out)
      .arg("-o")
      .arg(out.join("menu_bar.o")),
  );
  run(
    Command::new("xcrun")
      .args(["libtool", "-static", "-o"])
      .arg(out.join("libinfumap_menu_bar.a"))
      .arg(out.join("menu_bar.o")),
  );
  println!("cargo:rustc-link-search=native={}", out.display());
  println!("cargo:rustc-link-lib=static=infumap_menu_bar");
  println!("cargo:rustc-link-lib=framework=AppKit");
  println!("cargo:rustc-link-lib=framework=Foundation");
  println!("cargo:rustc-link-lib=dylib=objc");
}
