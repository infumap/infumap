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

The Rust publisher-trust generator and age check need Python 3.11+ (`tomllib`); the toolchain check uses `curl`.
Missing Python skips the Rust audit and prevents a completion stamp. On a fresh checkout,
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
| `audit-rust.sh` | Checks `infumap/` and `infusdk/` separately, requiring both `Cargo.lock` files. Runs advisory/source policy checks, generates publisher trust, then runs cargo-vet, then toolchain and crate-age checks. A failure in an earlier stage prevents later stages. |
| `audit-npm.sh` | Runs `npm audit` in `web/` for known vulnerabilities, including development dependencies, then `npm audit signatures` to verify registry signatures and available provenance attestations for installed packages. Both must pass. It requires `web/package-lock.json` and does not install dependencies. |
| `audit-python.sh` | Runs `pip-audit -r` separately for gateway, image_extract, and pdf_extract `requirements.txt` files, including resolved transitive dependencies. Continues through all three and fails if any audit fails. |
| `check-crate-ages.py` | Deduplicates crates.io name/version pairs across the supplied lockfiles, queries publication dates, and fails if any verified version is less than seven days old. Skips local and Git dependencies. Called automatically by the Rust script. |
| `sync-publisher-trust.py` | Looks up each locked crates.io version's publisher and UTC publication date, then replaces the trusted tables in both projects' `audits.toml` files using `trusted-publishers.toml`. Preserves source audits and custom criteria. Called before cargo-vet. |

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
  local records and imported audits from Bytecode Alliance, Google, ISRG, Mozilla, and Zcash. Both projects
  require `safe-to-run` and use it as the default criterion for new certifications. Baseline exemptions have
  been removed: existing versions are not automatically accepted. Full/delta audits record specific source
  reviews; imported wildcard audits vouch for an organization's release process. Local publisher-trust entries
  accept a publisher's releases without individual reviews. A passing check means the configured review/trust
  policy is satisfied, not that every version was inspected or that the code is guaranteed safe.
- **Toolchain age is advisory.** The script warns when the numeric Rust pin is two or more minor releases behind
  stable. An unparseable pin or failed version fetch only warns.
- **Crate age has incomplete-data cases.** Publication-date lookup failures only warn and do not prevent a stamp
  if all other checks pass. A verified release under seven days old fails; there is no script option to
  override the threshold.

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

## Vetting Rust dependencies

The live list of missing reviews comes from cargo-vet; no separate backlog file is maintained. After changing
lockfiles or the publisher allowlist, run `python3 sync-publisher-trust.py` from the repository root (or run
`./audit-rust.sh`, which does this automatically before vetting). Then, in `infumap/`,
then separately in `infusdk/`, run:

```sh
cargo vet
cargo vet suggest
```

`cargo vet` fetches the configured public audit feeds and checks review coverage. A missing `safe-to-run`
review is a gap in accepted evidence, not a discovered vulnerability. `suggest` recommends full reviews or
smaller diffs. Its success status means suggestions were produced, not that the dependencies passed vetting.
The graph includes enabled features, build dependencies, proc-macros, and dependencies for other platforms;
some listed crates do not run on your host. Baseline exemptions are absent, so existing versions are checked too.

### Reuse public reviews

Both projects import public audit records from Mozilla, Google, Bytecode Alliance, ISRG, and Zcash, as configured in
their `supply-chain/config.toml`. Records can cover an exact version, a chain of reviewed changes, or an
organization's attestation about its release process. They do not mean someone reviewed Infumap's use of the crate.
Zcash's feed is [published here](https://github.com/zcash/rust-ecosystem/blob/main/supply-chain/audits.toml).
Imported `safe-to-deploy` reviews also satisfy `safe-to-run`; their stronger claims are preserved.

`cargo vet suggest` can identify further feeds that would reduce the work. Consider the organization and its
review practices before adding one, for example `cargo vet import <source-name>` in each project that needs it.
The [public registry](https://github.com/mozilla/cargo-vet/blob/main/registry.toml) lists candidates. Publisher
endorsements are different from source reviews. They are inherited automatically only from sources explicitly
selected under `[inherit]` in `trusted-publishers.toml`.

### Review and certify one package

Use the command recommended by cargo-vet, adding `--mode=local` to inspect the published crate contents locally.
For a suggested diff, the workflow is:

```sh
cargo vet diff equivalent 1.0.2 1.0.3 --mode=local
# After completing the review:
cargo vet certify equivalent 1.0.2 1.0.3 --criteria safe-to-run
cargo vet
```

This example records only the changes from 1.0.2 to 1.0.3. It establishes coverage for 1.0.3 only if there is
also an accepted review path to 1.0.2. Choosing an arbitrary diff from an unreviewed base leaves that base
unreviewed. Suggestions can point to versions other than the one installed because cargo-vet joins review
records into a chain. Follow the current suggestions rather than assuming the example versions apply.

For a package without an accepted base, review the full version:

```sh
cargo vet inspect <crate> <version> --mode=local
# After completing the review:
cargo vet certify <crate> <version> --criteria safe-to-run
cargo vet
```

If local inspection opens a nested shell, exit it when finished. Add `--notes "<your review notes>"` to the
certification command to record what you examined, assumptions, and any remaining concerns. `diff` and
`inspect` only show source; `certify` records your judgment. None performs the security review for you.

The review targets unexpected data access and transmission, installation, code execution, and resource misuse.
Inspect the package manifest and dependency changes, file/credential reads, network destinations, environment
access, process launches, downloaded code, and behavior hidden behind generated or native code. Include build
scripts and proc-macros: they can act on the build machine before Infumap is run. Unexpected behavior can be
written entirely in safe Rust; searching for `unsafe` alone is insufficient. Estimated review size is effort,
not security priority. This criterion does not require an exhaustive audit of memory-safety or production-input
bugs. Keep running advisory scans separately for known issues.

Actual review records belong in `supply-chain/audits.toml`, as `[[audits.<crate>]]` entries with an exact version
or a `delta`. If both projects need the same review, reuse the inspection and record it in both stores. Repeat
until `cargo vet` passes in both directories, then run `./audit.sh --server` from the repository root. Recheck
after dependency updates; the advisory, review, and seven-day age checks serve different purposes.

### Choose the criterion and distinguish publisher trust

| Criterion | What the reviewer assesses |
|---|---|
| `safe-to-run` | Building and running the crate on a workstation or in controlled automation does not have surprising harmful effects. This does not establish safety against hostile production input. |
| `safe-to-deploy` | Also assesses serious production security risks from untrusted input, including unsafe code, powerful system access, and code generated for deployment. It includes `safe-to-run`. |

Both projects explicitly require `safe-to-run` for their normal and development dependency graphs and set
`default-criteria = "safe-to-run"` for new certifications. The policy focuses on preventing malicious or
surprising behavior on machines handling personal data; it does not claim production exploit resistance.
`safe-to-deploy` reviews remain valid stronger evidence. Do not certify that stronger criterion unless your
review supports it. See the [criterion definitions](https://mozilla.github.io/cargo-vet/built-in-criteria.html).

A VPN restricts inbound access but does not by itself stop a dependency sending data out. Reviews provide
confidence, not enforcement of permitted file access or network destinations.

`cargo vet trust equivalent` creates a `[[trusted.equivalent]]` entry. It accepts releases of that crate by the
specified publisher published on or after `start` and before `end`, including future releases in that range.
The end date limits publication dates; it does not make an already covered version become untrusted
when that date passes. This is a broader publisher/release-process judgment, not a record of the diff you read.
Changing its criterion to `safe-to-run` changes the promised standard but still does not record a source review.

To automatically trust everyone endorsed by an audit source, edit the root `trusted-publishers.toml`:

```toml
[inherit]
sources = ["mozilla"]
end = "2027-11-10"
```

Mozilla is enabled. To inherit from either Mozilla or Bytecode Alliance, set
`sources = ["mozilla", "bytecode-alliance"]`. Source names must be configured in both projects'
`supply-chain/config.toml`; their URLs must agree. Then run from the repository root:

```sh
python3 sync-publisher-trust.py --dry-run  # show the inherited accounts without changing files
python3 sync-publisher-trust.py            # regenerate both projects' per-crate trust records
./audit-rust.sh                           # also regenerates trust before cargo-vet
```

Each audit fetches the selected sources' current `trusted` tables and inherits every crates.io account ID
endorsed for `safe-to-run` or `safe-to-deploy`. New accounts are included automatically; accounts removed
from all selected sources lose inherited trust on the next generation. Inherited accounts are not copied
into manual `[[publishers]]` entries. If a selected feed cannot be read, generation fails and the audit stops.

This delegates publisher selection to those sources and applies your own `safe-to-run` trust across their
publishers' crates. It is broader than importing the sources' individual crate reviews. The earliest
endorsement start date for each account becomes its inclusive start date; `inherit.end` is your fixed,
exclusive UTC publication cutoff. Upstream endorsements may have old end dates: this policy uses your
explicit cutoff instead. It never advances that cutoff automatically. Reconsider it before changing it.

Existing individual `[[publishers]]` entries take precedence over inherited decisions for the same account,
retaining their dates and criteria. They remain optional; you do not need to list inherited publishers by hand.
You can still add an individual account with `python3 sync-publisher-trust.py --trust BurntSushi`.
That command resolves the account ID and requires an endorsement from a shared audit source. New individual
entries use `safe-to-run`, the earliest endorsement start, and an end 365 days from today, or the date given
with `--end YYYY-MM-DD`. Existing entries are not renewed. Add `--dry-run` to preview without saving.

The generator checks each locked crates.io version's actual publisher account ID and publication date,
including crates with multiple historical publishers. It does not infer trust from ownership or cover
Git dependencies, other registries, or CI publisher signatures without account IDs. Missing publisher/date
metadata produces no generated trust for that crate. Other accepted source reviews can still cover it;
cargo-vet reports remaining gaps.

The generator owns the `[[trusted.<crate>]]` tables in both `supply-chain/audits.toml` files, preserving source
reviews and custom criteria. Edit `trusted-publishers.toml` rather than these generated tables. To disable
inherited trust, set `sources = []`; remove individual entries too if you want to remove all publisher trust.
Direct `cargo vet` commands do not regenerate the records. Review and commit policy and generated records
alongside lockfile changes.

Publisher trust bypasses individual version reviews and remains exposed to publisher mistakes or account
compromise. To revoke it, edit the allowlist, run `python3 sync-publisher-trust.py`, then run `cargo vet` in
both projects. Do not replace missing trust with an audit entry until that review has actually been completed.
See [publisher trust](https://mozilla.github.io/cargo-vet/trusting-publishers.html).

Avoid restoring blanket exemptions or running `cargo vet regenerate exemptions` to clear failures: those accept
versions without the missing review evidence. Even complete accepted coverage cannot guarantee that reviewers
found every vulnerability, or that our application uses the dependencies securely.

## Resolving vulnerability and policy findings

**Rust advisory or policy failure:** update the affected crate in each relevant crate directory:

```sh
cargo update -p <crate> --precise <fixed-version>
```

Widen the `Cargo.toml` requirement if necessary. If an advisory needs a temporary exception, record the reason
beside its entry in `deny.toml` and remove it when resolved. Source and wildcard failures require dependency
declaration changes. For a crate younger than seven days, wait until it meets the threshold and rerun.

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
