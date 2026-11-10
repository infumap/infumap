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
| Vetting | `audit-rust.sh` (cargo-vet, `<crate>/supply-chain/`) | Missing accepted review evidence for Rust crate versions; it does not scan source code |
| Crate age | `check-crate-ages.py` | Rust crates published in the last 7 days |
| Toolchain | `audit-rust.sh` | `rust-toolchain.toml` pinned two or more releases behind stable (warning only) |
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
cargo vet diff <crate> <old> <new> --mode=local
cargo vet certify <crate> <old> <new> --criteria safe-to-deploy
cargo vet inspect <crate> <version> --mode=local
cargo vet certify <crate> <version> --criteria safe-to-deploy
```

When reviewing, look first for `build.rs`, proc-macros, `unsafe`, FFI, and any use of `std::net`, `std::fs`,
`std::process` or `std::env` in a crate that has no reason to need them. Build scripts and proc-macros run on the
build machine at compile time (rust-analyzer runs them when the project is opened), so they matter even for
dependencies that are never deployed.

Baseline exemptions have been removed, so existing dependencies require the same review evidence as updates.
Audits published by Mozilla, Google, Bytecode Alliance and ISRG are imported (`[imports]` in
`supply-chain/config.toml`); these include source reviews and wildcard attestations about release processes.
Publisher trust and exemptions do not establish that source was reviewed and should not be used to clear the
backlog. The commands above are alternatives for a diff or a full review; certify only after completing the
corresponding inspection. A diff needs an accepted review of its base version. `cargo vet trust` accepts a
publisher's releases over a date range, including future releases, instead of recording your inspection.
`safe-to-deploy` includes `safe-to-run` and is required for deployed dependencies; `safe-to-run` alone covers
workstation/build safety. Rerun `cargo vet` for the live list after each review. See
[the vetting process](security.md#vetting-rust-dependencies) for criteria, review notes, and public audit sources.

**Toolchain behind.** The Rust version is pinned in `rust-toolchain.toml` so every machine builds and resolves
`Cargo.lock` with the same compiler. An old pin quietly holds back crate updates, because the resolver skips versions
that need a newer rustc. To bump it, edit `channel`, run `rustup install` from the repository root, build and test
both crates, then run `cargo update` and the audit, since newer crate versions may now be allowed.

**Crate too new.** Re-run the audit once the crate is 7 days old; there is no override. Most malicious releases are
found and removed within days, so avoid deploying a build that includes it before then.
