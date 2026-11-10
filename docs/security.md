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
  local records and imported audits from Bytecode Alliance, Google, ISRG, and Mozilla. Baseline exemptions have
  been removed: existing versions are not automatically accepted. Full/delta audits record specific source
  reviews; imported wildcard audits vouch for an organization's release process. Local publisher-trust entries
  accept a publisher's releases without individual reviews. A passing check means the configured review/trust
  policy is satisfied, not that every version was inspected or that the code is guaranteed safe.
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

## Vetting Rust dependencies

The live list of missing reviews comes from cargo-vet; no separate backlog file is maintained. In `infumap/`,
then separately in `infusdk/`, run:

```sh
cargo vet
cargo vet suggest
```

`cargo vet` fetches the configured public audit feeds and checks review coverage. A missing `safe-to-deploy`
review is a gap in accepted evidence, not a discovered vulnerability. `suggest` recommends full reviews or
smaller diffs. Its success status means suggestions were produced, not that the dependencies passed vetting.
The graph includes enabled features, build dependencies, proc-macros, and dependencies for other platforms;
some listed crates do not run on your host. Baseline exemptions are absent, so existing versions are checked too.

### Reuse public reviews

Both projects import public audit records from Mozilla, Google, Bytecode Alliance, and ISRG, as configured in
their `supply-chain/config.toml`. Records can cover an exact version, a chain of reviewed changes, or an
organization's attestation about its release process. They do not mean someone reviewed Infumap's use of the crate.

`cargo vet suggest` can identify further feeds that would reduce the work. Consider the organization and its
review practices before adding one, for example `cargo vet import <source-name>` in each project that needs it.
The [public registry](https://github.com/mozilla/cargo-vet/blob/main/registry.toml) lists candidates. A hint that
another organization trusts a publisher is different from an available source review; it does not automatically
add that publisher to our trusted set.

### Review and certify one package

Use the command recommended by cargo-vet, adding `--mode=local` to inspect the published crate contents locally.
For a suggested diff, the workflow is:

```sh
cargo vet diff equivalent 1.0.2 1.0.3 --mode=local
# After completing the review:
cargo vet certify equivalent 1.0.2 1.0.3 --criteria safe-to-deploy
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
cargo vet certify <crate> <version> --criteria safe-to-deploy
cargo vet
```

If local inspection opens a nested shell, exit it when finished. Add `--notes "<your review notes>"` to the
certification command to record what you examined, assumptions, and any remaining concerns. `diff` and
`inspect` only show source; `certify` records your judgment. None performs the security review for you.

Review the package manifest, dependency changes, build scripts, proc-macros, unsafe/FFI code, and filesystem,
network, environment, and process access. Reason about attacker-controlled input reaching those operations;
searching for suspicious keywords alone is insufficient. Prioritize exposed parsers, native code, credentials,
and cryptography as well as code running during builds. Estimated review size is effort, not security priority.

Actual review records belong in `supply-chain/audits.toml`, as `[[audits.<crate>]]` entries with an exact version
or a `delta`. If both projects need the same review, reuse the inspection and record it in both stores. Repeat
until `cargo vet` passes in both directories, then run `./audit.sh --server` from the repository root. Recheck
after dependency updates; the advisory, review, and seven-day age checks serve different purposes.

### Choose the criterion and distinguish publisher trust

| Criterion | What the reviewer assesses |
|---|---|
| `safe-to-run` | Building and running the crate on a workstation or in controlled automation does not have surprising harmful effects. This does not establish safety against hostile production input. |
| `safe-to-deploy` | Also assesses serious production security risks from untrusted input, including unsafe code, powerful system access, and code generated for deployment. It includes `safe-to-run`. |

Use the criterion cargo-vet requires. Infumap's deployed dependency graph requires `safe-to-deploy`; reducing a
review to `safe-to-run` does not satisfy that requirement. Development-only dependencies may require only
`safe-to-run`. Build scripts and proc-macros can generate deployed code, so they are not automatically limited
to `safe-to-run`. See the [criterion definitions](https://mozilla.github.io/cargo-vet/built-in-criteria.html).

`cargo vet trust equivalent` creates a `[[trusted.equivalent]]` entry. It accepts releases of that crate by the
specified publisher published on or after `start` and before `end`, including future releases in that range.
The end date limits publication dates; it does not make an already covered version become untrusted
when that date passes. This is a broader publisher/release-process judgment, not a record of the diff you read.
Changing its criterion to `safe-to-run` changes the promised standard but still does not record a source review.

Publisher trust can be an intentional policy decision, but it bypasses individual version reviews and remains
exposed to publisher mistakes or account compromise. For a version-by-version review process, use `certify`
instead. If a trust entry was added unintentionally, remove that `[[trusted.<crate>]]` block from the relevant
`audits.toml`, run `cargo vet fmt`, then `cargo vet` to see the missing reviews again. Do not replace it with
an audit entry until that review has actually been completed. See [publisher trust](https://mozilla.github.io/cargo-vet/trusting-publishers.html).

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
