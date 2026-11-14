# Building

## Prerequisites

The build requires Node.js with npm, Python 3, and Rust with Cargo and a native compiler toolchain. For Rust installation, follow the [official Rust setup instructions](https://www.rust-lang.org/tools/install). The Rust version is pinned in `rust-toolchain.toml`; run `rustup install` from the repository root to install it. On macOS, install Apple's Command Line Tools with `xcode-select --install` if they are missing.

### Node.js and npm

The required Node.js version is recorded in the repository root's `.nvmrc`. Use a Node version manager to install that version, rather than installing whichever Node release is newest. Node.js includes npm; the build automatically uses the npm version specified in `web/package.json`.

On macOS with zsh, one option is [fnm](https://github.com/Schniz/fnm#installation) via [Homebrew](https://brew.sh/). If `brew` is unavailable, install Homebrew using its official instructions and complete its shell setup first. Then, from the repository root:

```sh
brew install fnm
eval "$(fnm env --use-on-cd --shell zsh)"
fnm install
fnm use
```

Add the following line once to `~/.zshrc` so fnm is initialized in future terminals and selects the repository's Node version when you enter its directory:

```sh
eval "$(fnm env --use-on-cd --shell zsh)"
```

If you already use [nvm](https://github.com/nvm-sh/nvm#installing-and-updating), keep using it. From the repository root:

```sh
nvm install
nvm use
```

For other operating systems or shells, follow the version manager's official installation and shell setup instructions linked above. If you have installed a manager but its command is unavailable, open a new terminal after completing its shell setup.

## Run the build

Execute the build script in the repo root:

```
./build.sh
```

This will create a fully self-contained `infumap` executable here: `./infumap/target/release/infumap`.

### macOS menu bar binary

On macOS with Apple's Command Line Tools installed, build the Apple Silicon version with:

```sh
rustup target add aarch64-apple-darwin
./build.sh --macos-menu-bar
./infumap/target/aarch64-apple-darwin/release/infumap-macos
```

The output is one executable with the web client and menu bar icon embedded. It requires macOS 11 or later and does not need a separate `infumap` server executable. Add `--dev` for an unoptimized build; its output is under `target/aarch64-apple-darwin/debug/`.

Running it starts the web server automatically. Its menu offers **Start Web Server**, **Stop Web Server**, **Open Infumap in Browser**, **Show Logs**, **Settings…**, and **Quit Infumap**. The browser action becomes available once startup finishes and uses the configured listening address and port. Wildcard listening addresses use the corresponding loopback address for the browser. Logs append across restarts to `~/Library/Logs/Infumap/server.log`; **Show Logs** opens this file in macOS Console, with Finder as a fallback.

Configuration, environment overrides, and data directories work as for `infumap web`. To select a settings file or directory:

```sh
./infumap/target/aarch64-apple-darwin/release/infumap-macos --settings /path/to/settings.toml
```

**Settings…** works even with the server stopped. **Server** edits the listen address and port; port `0` selects an available port on startup. **Chat Providers** adds or removes any number of providers and edits their type, API base URL, API key, model discovery or fixed model ID, and optional reasoning efforts. New providers receive an ID that can be edited before saving. Saved IDs remain fixed because query profiles reference them. Removing a provider can leave those profiles needing another provider selection.

API keys are masked, with a **Show** button for editing. **Check Connection** checks the current draft without saving it. With model discovery enabled it fetches the model list; a successful catalog fetch does not establish that chat requests or credentials work. With discovery disabled it sends a short synthetic chat request to the configured model, which may incur provider charges. No Infumap account data is sent by either check.

**Save** writes settings while stopped. **Save and Restart** gracefully stops the running server and starts it with the saved settings. The window stays open and displays restart status, including startup failures; **Show Logs** opens the server log. **Cancel** discards unsaved edits when the window is reopened, and **Reload** reads the file again. Values overridden by environment variables are read-only. Environment-only configuration makes the entire editor read-only.

Edits preserve unrelated settings and TOML comments, and save through a private temporary file followed by atomic replacement. If the settings file changed while the window was open, saving is rejected; reload it before trying again. The editor uses the same settings file selected by `--settings`, or the default `~/.infumap/settings.toml`.

Only one menu bar instance and one managed server can run per user. Stop an existing command-line server before launching the menu bar version against the same data. Stop and Quit wait for startup maintenance and active HTTP requests to finish; the menu displays **Stopping…** until the child process exits. Closing the launcher's terminal or terminating the launcher also requests server shutdown. Pending search indexing is recovered at the next startup.

After a web build, rebuild just the menu bar executable with `./infumap/build.sh --macos-menu-bar`. The native UI uses AppKit from the macOS SDK. The settings editor uses `toml_edit`, already present in the server's dependency graph, to preserve file formatting.

## Additional Information

The `build.sh` script generates the various client side artifacts as well as Rust code for route handlers to serve them (using the `web/generate_dist_handlers.py` script) before building the server executable `./infumap/target/release/infumap`. This executable is fully self contained - to deploy Infumap, you simply need to copy this one file.

The `build.sh` script also accepts `--no-minify` for a more debuggable web build, and it accepts an optional Rust target triple argument. See the [Platform Support](https://doc.rust-lang.org/rustc/platform-support.html) page for a discussion of the supported platforms.

### Linux musl builds (without Docker)

The Linux release targets are `x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl`. The ARM64 binary covers Raspberry Pi running a 64-bit OS, ARM64 Linux VMs on Apple Silicon, and ARM servers. It does not run on a 32-bit Raspberry Pi OS. The x86-64 binary covers Intel/AMD Linux machines.

Build either target from macOS or Linux using [Zig](https://ziglang.org/download/) and [cargo-zigbuild](https://github.com/rust-cross/cargo-zigbuild). Use Zig **0.14.1** on `PATH` and install cargo-zigbuild **0.23.0**:

```sh
cargo install --locked --version 0.23.0 cargo-zigbuild
rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl
```

The repository's Rust toolchain is selected by `rust-toolchain.toml`. Zig supplies the target C compiler, headers and linker needed by native dependencies such as AWS-LC, ring and zstd; installing Rust targets alone is insufficient. Docker and a separate musl cross compiler are not required.

From the repository root, build either target:

```sh
./build.sh x86_64-unknown-linux-musl
./build.sh aarch64-unknown-linux-musl
```

Outputs are `infumap/target/<target>/release/infumap` unless you override Cargo's target directory. To build the web client once and reuse it:

```sh
./web/build.sh
./infumap/build.sh x86_64-unknown-linux-musl
./infumap/build.sh aarch64-unknown-linux-musl
```

Musl builds statically link the C runtime to avoid depending on the host's glibc version, including on distributions such as Alpine. They still require a compatible Linux kernel and CPU, and outbound HTTPS uses the host's CA certificate store (usually provided by `ca-certificates`). Keep release builds at the default target CPU baseline; do not use `-C target-cpu=native` for binaries distributed to other machines.

### Release archives

`build-release.sh` builds and packages one of these release executables:

| Target | Executable |
| --- | --- |
| `x86_64-unknown-linux-musl` | `infumap` |
| `aarch64-unknown-linux-musl` | `infumap` |
| `aarch64-apple-darwin` | `infumap-macos` |

```sh
./build-release.sh x86_64-unknown-linux-musl
./build-release.sh aarch64-unknown-linux-musl
# Run on macOS with Apple's Command Line Tools:
./build-release.sh aarch64-apple-darwin
```

Archives are written under the repository root's `dist/` directory. Linux archives are named `<executable>-<version>-<target>.tar.gz` and contain a directory holding the executable and `LICENSE.txt`. The version comes from `infumap/Cargo.toml`.

The macOS archive contains `Infumap.app`, including the menu bar executable, app icon, metadata and license. It targets macOS 11 or later. Double-click the app to start it, or move it into Applications first. The command-line macOS executable remains available through the ordinary build script.

macOS filenames distinguish distribution states:

| Build options | Filename |
| --- | --- |
| No signing options (local ad hoc signature) | `infumap-macos-<version>-aarch64-apple-darwin-unsigned.zip` |
| `--sign` (Developer ID signature only) | `infumap-macos-<version>-aarch64-apple-darwin-signed.zip` |
| `--notarize` (Developer ID signature and stapled notarization ticket) | `infumap-macos-<version>-aarch64-apple-darwin.zip` |

Every archive has a matching `.sha256` file, calculated after packaging and any notarization. Public macOS downloads should use `--notarize`; the other modes are useful for local development and signing diagnosis.

To reuse a web build, pass `--skip-web` to each release build. When transferring a web build between CI jobs, transfer **both** `infumap/dist/` and `infumap/src/web/dist_handlers.rs`; the generated Rust routes embed the assets at compile time. Preserve their repository-relative paths. Build the web client from the same revision as the Rust source.

### Signing and notarizing macOS releases

`./build-release.sh --notarize aarch64-apple-darwin` builds the app, signs it with Hardened Runtime and a secure timestamp, submits a ZIP to Apple, checks for an `Accepted` response, staples and validates the ticket, and assesses the app for distribution. It then creates the final ZIP containing the stapled app. A failure stops packaging; signing or notarization never falls back to an unsigned release. This follows [Apple's notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow).

You need a **Developer ID Application** certificate and its private key, plus notarization credentials from your Apple Developer account. The scripts use `codesign`, `security`, `sips`, `iconutil`, `ditto`, `notarytool` and `stapler` from macOS and Apple's developer tools. No Xcode project or installer is required.

For local signing, install the certificate/private key in your keychain. Store notarization credentials with `xcrun notarytool store-credentials infumap`, then run:

```sh
export MACOS_SIGNING_IDENTITY='Developer ID Application: Your Name (TEAMID)'
export MACOS_NOTARY_KEYCHAIN_PROFILE=infumap
./build-release.sh --notarize aarch64-apple-darwin
```

`MACOS_SIGNING_KEYCHAIN` can select an existing signing keychain. As an alternative to a notarization profile, set `MACOS_NOTARY_KEY_PATH` to an App Store Connect **team** API key's `.p8` file, along with `MACOS_NOTARY_KEY_ID` and `MACOS_NOTARY_ISSUER_ID`. Choose either a profile or API key authentication.

For GitHub Actions, export the Developer ID Application certificate **with its private key** as a password-protected `.p12` file and provide the following environment variables from secrets:

| Variable | Value |
| --- | --- |
| `MACOS_CERTIFICATE_BASE64` | Base64-encoded `.p12` file |
| `MACOS_CERTIFICATE_PASSWORD` | Password used when exporting the `.p12` file |
| `MACOS_SIGNING_IDENTITY` | Full `Developer ID Application: … (TEAMID)` certificate name |
| `MACOS_NOTARY_KEY_BASE64` | Base64-encoded App Store Connect team API key `.p8` file |
| `MACOS_NOTARY_KEY_ID` | API key ID |
| `MACOS_NOTARY_ISSUER_ID` | API key issuer ID |

On macOS, `base64 -i certificate.p12 | pbcopy` copies a certificate's encoded value for adding to a secret; use the same command with the `.p8` file for the API key. Base64 is encoding, so keep both values in secrets.

After checking out the source and selecting the repo-pinned Node and Rust versions on an Apple Silicon macOS runner, an Actions step can invoke the whole workflow:

```yaml
- name: Build signed and notarized macOS release
  env:
    MACOS_CERTIFICATE_BASE64: ${{ secrets.MACOS_CERTIFICATE_BASE64 }}
    MACOS_CERTIFICATE_PASSWORD: ${{ secrets.MACOS_CERTIFICATE_PASSWORD }}
    MACOS_SIGNING_IDENTITY: ${{ secrets.MACOS_SIGNING_IDENTITY }}
    MACOS_NOTARY_KEY_BASE64: ${{ secrets.MACOS_NOTARY_KEY_BASE64 }}
    MACOS_NOTARY_KEY_ID: ${{ secrets.MACOS_NOTARY_KEY_ID }}
    MACOS_NOTARY_ISSUER_ID: ${{ secrets.MACOS_NOTARY_ISSUER_ID }}
  run: |
    rustup target add aarch64-apple-darwin
    ./build-release.sh --notarize aarch64-apple-darwin
```

The packaging helper imports the certificate into a temporary unlocked keychain, grants noninteractive access to the signing tool, and deletes the keychain and decoded credential files on exit. It leaves existing keychains intact. Only make these secrets available to trusted release jobs. See [GitHub's signing certificate guidance](https://docs.github.com/en/actions/how-tos/deploy/deploy-to-third-party-platforms/sign-xcode-applications).

Collect `dist/infumap-macos-*-aarch64-apple-darwin.zip` and the matching `.zip.sha256` as release artifacts. Apple's submission response and diagnostic log are retained as `dist/*-notary-submission.json` and `dist/*-notary-log.json`, including on rejection when Apple supplies a log. Collect those diagnostics even if the job fails. `MACOS_NOTARY_LOG_DIR` overrides their directory; `MACOS_NOTARY_TIMEOUT` overrides the default `30m` wait. A timeout fails the build and preserves the submission response so its ID can be used with `notarytool info` or `notarytool log`.

The lower-level `infumap/macos/package.sh` command can also package an already-built executable; run it with `--help` for its arguments and credential options.


# Iterative Development

From the repo `infumap` directory:

```
cargo run web
```

This will start a server listening on port `8000` that handles API requests and serves embedded resources from the previous build. Note that you need to have run the root `./build.sh` script at least once for this to work.

From the repo `web` directory:

```
npm run start
```

This will start a vite development server listening on port `3000`, serving the current state of `web`, with hot reload. Requests to the API (but not requests for client resources) will be forwarded to port `8000`.

Set `INFUMAP_LLM_LOG=1` before starting the server to write each chat run's requests, responses and full tool results
to `/tmp/llm.txt`. The file starts over for every message sent. The run's first request holds the whole conversation;
later requests show messages already logged as `<messages 0–N unchanged since request K>`.
