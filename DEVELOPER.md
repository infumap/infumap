# Building

Execute the build script in the repo root:

```
./build.sh
```

### Additional Information

The `build.sh` script generates the various client side artifacts as well as Rust code for route handlers to serve them (using the `web/generate_dist_handlers.py` script) before building the server executable `./infumap/target/release/infumap`. This executable is fully self contained - to deploy Infumap, you simply need to copy this one file.

The `build.sh` script takes an optional argument which is the rust platform target. See the [Platform Support](https://doc.rust-lang.org/rustc/platform-support.html) page for a discussion of the supported platorms.

There is an additional script `build-all.sh` in the repo which builds Infumap on all platforms that we do a binary release for (`x86_64-apple-darwin`, `aarch64-apple-darwin`, `x86_64-unknown-linux-gnu` and `x86_64-unknown-linux-musl`). Generally, you will need to install additional dependencies on your system for this script to successfully complete.

If you are developing on Apple Silicon, install the standard libraries:

```
rustup target add x86_64-apple-darwin
rustup target add x86_64-unknown-linux-gnu
rustup target add x86_64-unknown-linux-musl
```

Then install the linux linkers:

```
brew install SergioBenitez/osxct/x86_64-unknown-linux-gnu
brew install FiloSottile/musl-cross/musl-cross
```

Then configure cargo to use them by adding the following to `~/.cargo/config.toml`:

```
[target.x86_64-unknown-linux-gnu]
linker = "x86_64-unknown-linux-gnu-gcc"

[target.x86_64-unknown-linux-musl]
linker = "x86_64-linux-musl-gcc"
```

### `x86_64-unknown-linux-gnu` (glibc) vs `x86_64-unknown-linux-musl`

I'm unsure which is better, I need to do more research.

Notes:
- The glibc version has a dynamic dependency on glibc and will not work on platforms that don't use this (e.g. Alpine).
- The musl version statically links the runtime, so will work on pretty much any modern linux distro.
- The glibc target is a 'tier 1' supported Rust target, the musl target is not. However, the probability of problems seems very low.
- There are conflicting reports on the relative performance.
- The musl implementation is "leaner" and "cleaner".

For now, if you are on a platform that uses glibc (e.g. Ubuntu, Debian), I suggest that using the glibc build is a better bet. If not, use the musl build. I doubt it matters much.

# Iterative Development

From the repo `infumap` directory:

```
cargo run
```

This will start a server listening on port `8000` that handles API requests and serves embedded resources from the previous build. Note that you need to have run the `build.sh` (or `build-all.sh`) script at least once for this to work.

From the repo `web` directory:

```
npm run start
```

This will start a vite development server listening on port `3000`, serving the current state of `web`, with hot reload. Requests to the API (but not requests for client resources) will be forwarded to port `8000`.
