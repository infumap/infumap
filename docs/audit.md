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
Before vetting, `sync-publisher-trust.py` generates per-crate trust records for both projects from the shared
`trusted-publishers.toml`. Only locked crates.io versions with a matching publisher account ID and publication
date qualify. Unknown publishers and failed lookups receive no generated trust; cargo-vet reports remaining gaps.

The Rust audit requires Python 3.11+ as well as the Cargo tools below:

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

For an AI-assisted source-review batch, ask the coding agent:

> Follow DEPENDENCY_REVIEW.md and review the next 3 suggested cargo-vet diffs.

You can paste specific suggestions instead. The [review instructions](../DEPENDENCY_REVIEW.md) require
dated reports in `dependency-reviews/` and `Codex (AI reviewer)` attribution with substantive notes in the
projects' `supply-chain/audits.toml` files. Concerning or incomplete reviews remain uncertified. Inspect the
report and working-tree changes, then rerun `./audit-rust.sh` as usual. No commit is made automatically.

**Advisory.** Update to the fixed version (`cargo update -p <crate> --precise <version>`), or widen the range in
`Cargo.toml` if the fix is outside it. If no fix exists and the advisory doesn't apply, add it to `ignore` in
`deny.toml` with a reason, and remove it once a fix ships.

**Unvetted crate.** Run in the failing crate's directory:

```sh
cargo vet suggest                        # what needs review, smallest diffs first
cargo vet diff <crate> <old> <new> --mode=local
cargo vet certify <crate> <old> <new> --criteria safe-to-run
cargo vet inspect <crate> <version> --mode=local
cargo vet certify <crate> <version> --criteria safe-to-run
```

Publisher trust is inherited automatically from the sources listed in `trusted-publishers.toml`:

```toml
[inherit]
sources = ["mozilla"]
end = "2027-11-10"
```

Mozilla is enabled. Add `"bytecode-alliance"` to the list to also trust its publishers. Each audit refreshes
the selected sources' publisher account IDs and regenerates trust for both projects. You do not need to
select publishers individually. New and removed upstream endorsements take effect automatically, while
`end` remains fixed. Optional individual entries retain their own dates and criteria.

Run `python3 sync-publisher-trust.py --dry-run` to preview the inherited accounts, or omit `--dry-run` to
regenerate records directly. This accepts publishers across crates as your own trust decision; it does not
mean the sources reviewed each version you use. A feed lookup failure stops generation and the audit.

The `safe-to-run` review focuses on unexpected file/credential access, network connections, process launches,
downloaded code, installation, and resource misuse. Inspect `build.rs`, proc-macros, generated/native code,
and any use of `std::net`, `std::fs`, `std::process` or `std::env` inconsistent with the crate's purpose.
Build-time code matters even for dependencies that are never deployed. Malicious behavior does not need
`unsafe` code; reviewing memory safety alone does not establish this criterion.

Baseline exemptions have been removed, so existing dependencies require the same review evidence as updates.
Audits published by Mozilla, Google, Bytecode Alliance, ISRG, and Zcash are imported (`[imports]` in
`supply-chain/config.toml`); these include source reviews and wildcard attestations about release processes.
Publisher trust from the shared allowlist accepts releases without individual source reviews. Edit
`trusted-publishers.toml` to select sources, revoke individual trust, or change dates and criteria.
Dates are never extended automatically.
Do not edit generated `[[trusted.<crate>]]` records or add exemptions just to clear remaining failures.
The commands above are alternatives for a diff or a full review; certify only after completing the
corresponding inspection. A diff needs an accepted review of its base version. `cargo vet trust` accepts a
publisher's releases over a date range, including future releases, instead of recording your inspection.
Both projects require `safe-to-run` and default new certifications to it. Stronger `safe-to-deploy` reviews
also qualify, but the policy does not require production exploit-resistance reviews. Advisory scans continue
to check known vulnerabilities separately. Rerun `cargo vet` for the live list after each review. See
[the vetting process](security.md#vetting-rust-dependencies) for criteria, review notes, and public audit sources.

**Toolchain behind.** The Rust version is pinned in `rust-toolchain.toml` so every machine builds and resolves
`Cargo.lock` with the same compiler. An old pin quietly holds back crate updates, because the resolver skips versions
that need a newer rustc. To bump it, edit `channel`, run `rustup install` from the repository root, build and test
both crates, then run `cargo update` and the audit, since newer crate versions may now be allowed.

**Crate too new.** Re-run the audit once the crate is 7 days old; there is no override. Most malicious releases are
found and removed within days, so avoid deploying a build that includes it before then.
