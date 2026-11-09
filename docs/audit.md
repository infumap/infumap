# Dependency Audit

Infumap's dependencies are checked by `audit.sh`, run from the repository root:

```sh
./audit.sh --server   # Rust + npm, on the machine that builds infumap
./audit.sh --gpu      # Python, on the GPU/ML host
```

A clean run records a timestamp (`.last-audit-server` / `.last-audit-gpu`). `build.sh` warns if the server audit is
missing or more than a week old.

## What is checked

| Check | Script | Catches |
|---|---|---|
| Advisories | `audit-rust.sh` (cargo-deny, else cargo-audit) | Known vulnerable, yanked or unmaintained Rust crates |
| Sources | `audit-rust.sh` (cargo-deny, `deny.toml`) | Crates from anywhere other than crates.io; wildcard versions |
| Vetting | `audit-rust.sh` (cargo-vet, `<crate>/supply-chain/`) | Rust crate versions nobody has reviewed, e.g. a malicious new release |
| Crate age | `check-crate-ages.py` | Rust crates published in the last 7 days |
| npm | `audit-npm.sh` | Known vulnerable packages in `web/` |
| Python | `audit-python.sh` (pip-audit) | Known vulnerable packages in `tools/gpu/*/requirements.txt` |

Rust checks run separately for `infumap/` and `infusdk/`, each against its own `Cargo.lock`.

Required tools:

```sh
cargo install cargo-deny --locked
cargo install cargo-vet --locked
pipx install pip-audit          # GPU host only
```

## Updating dependencies

1. Update: `cargo update` (whole tree) or `cargo update -p <crate>` (one crate and what it needs). This only
   changes `Cargo.lock`; `Cargo.toml` holds version ranges, not pins.
2. Run `./audit.sh --server` and resolve any failures as below.
3. Commit `Cargo.lock` together with any `supply-chain/` changes.

## Resolving failures

**Advisory.** Update to the fixed version (`cargo update -p <crate> --precise <version>`), or widen the range in
`Cargo.toml` if the fix is outside it. If no fix exists and the advisory doesn't apply, add it to `ignore` in
`deny.toml` with a reason, and remove it once a fix ships.

**Unvetted crate.** Run in the failing crate's directory:

```sh
cargo vet suggest                        # what needs review, smallest diffs first
cargo vet diff <crate> <old> <new>       # review the change since the last vetted version
cargo vet certify <crate> <old> <new>    # record that you reviewed it
cargo vet inspect <crate> <version>      # review a crate with no vetted earlier version
cargo vet certify <crate> <version>
```

When reviewing, look first for `build.rs`, proc-macros, `unsafe`, FFI, and any use of `std::net`, `std::fs`,
`std::process` or `std::env` in a crate that has no reason to need them. Build scripts and proc-macros run on the
build machine at compile time (rust-analyzer runs them when the project is opened), so they matter even for
dependencies that are never deployed.

Alternatives to a review:

- `cargo vet trust <crate> <publisher>` accepts all future releases of a crate by that publisher.
- `cargo vet add-exemption <crate> <version>` accepts a version without review. Use it sparingly; exemptions are the
  unreviewed baseline that cargo-vet started from.

Audits published by Mozilla, Google, Bytecode Alliance and ISRG are imported (`[imports]` in
`supply-chain/config.toml`) and count as reviews.

**Crate too new.** Re-run the audit once the crate is 7 days old; there is no override. Most malicious releases are
found and removed within days, so avoid deploying a build that includes it before then.
