# Security checks

The audit scripts check dependencies for known vulnerabilities and enforce some supply-chain policies. They do
not audit Infumap's application code, host configuration, or model files, and a passing result is not proof that
dependencies are safe.

## Running audits

Run from the repository root, after dependency changes and before building or deploying:

```sh
./audit.sh --server   # Rust + npm, on the machine that builds Infumap
./audit.sh --gpu      # Python, on the GPU/ML host
```

On the build host, use the Node.js version in `.nvmrc`, the npm version in `web/package.json`, and the Rust
toolchain in `rust-toolchain.toml`; see [developer setup](developer.md). Install the Rust audit tools:

```sh
cargo install cargo-deny --locked
cargo install cargo-vet --locked
```

The Rust age check also needs Python 3.11+ (`tomllib`); the toolchain check uses `curl`. On a fresh checkout,
install the web dependencies with `npm ci` in `web/` before auditing: the signature check needs the installed
packages. Unlike the build script, `audit-npm.sh` uses the `npm` on `PATH` without bootstrapping the pinned version.

On the GPU host, install `pip-audit` using either `pipx install pip-audit` or `uv tool install pip-audit`.
Run with network access for advisory services, registry metadata, and imported Rust reviews.

Fix reported issues and rerun the appropriate wrapper. Only a run with no failed or tool-skipped audits touches
`.last-audit-server` or `.last-audit-gpu`. These files are ignored by Git. `build.sh` warns when the server stamp
is missing or at least a week old; it neither runs the audit nor blocks the build. A stamp records time only,
so rerun after dependency changes even if it is recent.

**Read the output as well as the exit status.** Individual scripts return `2` when a required audit tool is
missing. The wrapper still runs the other audits and returns `0` if none failed, but leaves the stamp unchanged
when any returned `2`. Failures return `1` from the wrapper. Warning-only omissions described below can still
allow a stamp to be written. Running an individual script directly does not update the stamps.

## What the scripts do

| Script | Actual checks |
|---|---|
| `audit.sh` | Requires exactly one host role; runs both Rust and npm checks for `--server`, or Python checks for `--gpu`, then records completion as above. |
| `audit-rust.sh` | Checks `infumap/` and `infusdk/` separately, requiring both `Cargo.lock` files. Runs advisory/source policy checks, then cargo-vet, then toolchain and crate-age checks. A failure in an earlier stage prevents later stages. |
| `audit-npm.sh` | Runs `npm audit` in `web/` for known vulnerabilities, including development dependencies, then `npm audit signatures` to verify registry signatures and available provenance attestations for installed packages. Both must pass. It requires `web/package-lock.json` and does not install dependencies. |
| `audit-python.sh` | Runs `pip-audit -r` separately for gateway, image_extract, and pdf_extract `requirements.txt` files, including resolved transitive dependencies. Continues through all three and fails if any audit fails. |
| `check-crate-ages.py` | Deduplicates crates.io name/version pairs across the supplied lockfiles, queries publication dates, and fails if any verified version is less than seven days old. Skips local and Git dependencies. Called automatically by the Rust script. |

### Rust policies and limits

- **cargo-deny is preferred.** It runs `advisories bans sources` with all features enabled, using the root
  `deny.toml`. Yanked releases, wildcard dependency requirements, and sources outside the allowed crates.io
  registries are denied. Advisory exceptions are listed with reasons. Duplicate versions are explicitly
  allowed, and the license check is not run.
- **cargo-audit is a narrower fallback.** If cargo-deny is unavailable, cargo-audit checks each committed
  lockfile for advisories. It does not enforce `deny.toml` source or wildcard policies, or use its ignore list.
- **Advisory data can be stale.** cargo-deny uses `.audit-cache/cargo`, initially copying an existing advisory
  database from the normal Cargo home. Once the local advisory database directory exists, the script passes
  `--disable-fetch`; rerunning alone does not refresh it. Check its freshness before relying on the result.
- **cargo-vet checks recorded acceptance, not source automatically.** Each crate's `supply-chain/` contains
  local records, imported audits from Bytecode Alliance, Google, ISRG, and Mozilla, and exemptions. An exemption
  accepts a version without review; passing does not mean every dependency was reviewed.
- **Toolchain age is advisory.** The script warns when the numeric Rust pin is two or more minor releases behind
  stable. An unparseable pin or failed version fetch only warns.
- **Crate age has incomplete-data cases.** Missing Python skips the check with a warning; publication-date
  lookup failures also only warn. Neither prevents a stamp if all other checks pass. A verified release under
  seven days old fails; there is no script option to override the threshold.

`web/.npmrc` separately disables dependency lifecycle scripts (`ignore-scripts=true`) and configures a seven-day
minimum release age (`min-release-age=7`). These are npm installation policies, not additional audit stages.

### GPU coverage gaps

The Python script audits requirements resolution, rather than inspecting each service's installed virtualenv.
Unpinned requirements can therefore resolve differently from the running service. A missing requirements file
only warns and is skipped without failing the audit. Packages reported with a skip reason remain unverified.

The separate Docling environment is **not included** in `audit-python.sh`. Audit it explicitly on the GPU host:

```sh
pip-audit -r tools/gpu/pdf_extract/requirements-docling.txt
```

## Resolving findings

**Rust advisory or policy failure:** update the affected crate in each relevant crate directory:

```sh
cargo update -p <crate> --precise <fixed-version>
```

Widen the `Cargo.toml` requirement if necessary. If an advisory needs a temporary exception, record the reason
beside its entry in `deny.toml` and remove it when resolved. Source and wildcard failures require dependency
declaration changes. For a crate younger than seven days, wait until it meets the threshold and rerun.

**Unvetted Rust version:** run in the failing crate's directory:

```sh
cargo vet suggest
cargo vet diff <crate> <old> <new>    # inspect changes from an accepted version
cargo vet certify <crate> <old> <new> # record a review after completing it
```

For a full review, use `cargo vet inspect <crate> <version>`, then `cargo vet certify <crate> <version>`.
Pay particular attention to build scripts, proc-macros, unsafe/FFI code, and unexpected filesystem, network,
environment, or process access. `cargo vet trust` accepts releases by a publisher; `cargo vet add-exemption`
accepts a version without review. Neither substitutes for inspecting the source.

**npm finding:** use `npm audit` in `web/` to identify the dependency path, then update the dependency or apply
and review `npm audit fix`. Review any proposed major-version change separately. An `overrides` entry selects
a replacement dependency version; it does not suppress an advisory or make a vulnerable version safe. Investigate
signature failures before using the affected package.

**Python finding:** update the direct requirement or constrain the vulnerable transitive dependency to a fixed,
compatible version. Explicitly reinstall the affected service's requirements in its virtualenv, then restart
and rerun the audit; the gateway and image extractor launchers do not necessarily reinstall on restart.

Review changed manifests, lockfiles, and `supply-chain/` records together, then rerun the role audit before using
the updated dependencies. For an old Rust toolchain pin, update `rust-toolchain.toml` and install it with
`rustup install`; resolving dependencies again may then permit newer fixes.
