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

Sadly, [it seems](https://github.com/libp2p/rust-libp2p/discussions/1975) that support for TLS in Rust depends on a platform specific build chain (specifically because of [ring](https://github.com/briansmith/ring)). Further, when I attempt to build Infumap using [this popular](https://github.com/emk/rust-musl-builder) Docker image on my M1 mac, it panics. So this is all very inconvenient for setting up a multi-target build process.

### Creating a `x86_64-unknown-linux-musl` Build On Debian 11

Get the latest infumap source:

```
cd ~
mkdir git
cd git
git clone https://github.com/infumap/infumap
```

Follow the instructions [here](https://docs.docker.com/engine/install/debian/) to install docker:

```
sudo apt-get update

sudo apt-get install \
    ca-certificates \
    curl \
    gnupg \
    lsb-release

sudo mkdir -m 0755 -p /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \
  $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update

sudo apt-get install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Create the rust-musl-builder docker image:

```
cd ~/git/infumap/rust-musl-builder
docker build -t rust-musl-builder .
```

Explicitly build it rather than use the image on docker hub to:
1. Ensure the latest version of rust is used.
2. Be extra confident it's malware free.

Install and initialize `nvm` using its [official instructions](https://github.com/nvm-sh/nvm#installing-and-updating), then use the repo-pinned version from `.nvmrc` (see [Node.js and npm](#nodejs-and-npm) above):

```
cd ~/git/infumap
nvm install
nvm use
```

The root build script will bootstrap the repo-pinned npm version automatically, so no separate global `npm install` step is required on a clean machine.

Check current npm advisories explicitly:

```
cd ~/git/infumap/web
npm audit
```

Set permissions so the docker image can write the release build:

```
cd ~/git/infumap
chmod a+w infumap
```

Build infumap:

```
cd ~/git/infumap
./build-musl.sh
```

Copy the release build to the home directory for convenience:

```
cp ~/git/infumap/infumap/target/x86_64-unknown-linux-musl/release/infumap ~/
```


### `x86_64-unknown-linux-gnu` (glibc) vs `x86_64-unknown-linux-musl`

Notes:
- A glibc build has a dynamic dependency on glibc and will not work on platforms that don't use this (e.g. Alpine).
- The musl version statically links the runtime, so will work on pretty much any modern linux distro.
- The glibc target is a 'tier 1' supported Rust target, the musl target is not. However, the probability of problems seems very low.
- There are conflicting reports on the relative performance.
- The musl implementation is "leaner" and "cleaner".

For simplicity, we will take the approach of doing only a musl build for releases because it is the most portable.


# Iterative Development

From the repo `infumap` directory:

```
cargo run web
```

This will start a server listening on port `8000` that handles API requests and serves embedded resources from the previous build. Note that you need to have run the `build.sh` (or `build-musl.sh`) script at least once for this to work.

From the repo `web` directory:

```
npm run start
```

This will start a vite development server listening on port `3000`, serving the current state of `web`, with hot reload. Requests to the API (but not requests for client resources) will be forwarded to port `8000`.

Set `INFUMAP_LLM_LOG=1` before starting the server to write each chat run's requests, responses and full tool results
to `/tmp/llm.txt`. The file starts over for every message sent. The run's first request holds the whole conversation;
later requests show messages already logged as `<messages 0–N unchanged since request K>`.
