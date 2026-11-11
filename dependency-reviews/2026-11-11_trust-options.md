# Rust dependency trust options — 2026-11-11

Prepared by Codex (AI), as trust-policy research only. No dependency source review, certification, trust-policy edit, dependency update, build, or test was performed. This file is a proposal, not audit evidence.

## Recommendation and measured effect

Import Embark and Ariel OS, keep the existing Mozilla/Bytecode Alliance inheritance, repair historical publisher/base handling, and deliberately accept selected established upstream release authorities. Adding more inheritance sources alone provides no matching new publisher identities for this backlog.

| Hypothetical policy/evidence | Infumap uncovered versions | Infusdk uncovered versions |
|---|---:|---:|
| Current policy, refreshed existing feeds and complete cached publisher metadata | 223 | 14 |
| Also import Embark and Ariel OS | 222 | 12 |
| Also apply already-inherited identities to the three historical review bases | 219 | 12 |
| Broader recommended upstream account/pipeline set described below | 113 | 2 |

The broader scenario replaces about 4,459,260 of the pasted 5,305,884 estimated Infumap review lines (84%). Remaining estimate from the pasted tasks: 846,624 lines. These are cargo-vet workload estimates, not time predictions or risk measures. The recommendation adds 17 account identities and 15 CI identities, alongside three already-inherited accounts applied to historical bases. It does not accept transitive dependencies merely because their parent is trusted.

## What each mechanism trusts

- Audit imports accept the named source's exact audit/delta/wildcard evidence and its stated built-in criteria. Source imports are not recursive; accepting a source does not import its own peers automatically. [Cargo-vet importing](https://mozilla.github.io/cargo-vet/importing-audits.html).
- Native `trusted` entries accept releases of a particular crate from a named publisher within publication dates. They are a heuristic; the publisher may not have personally authored or reviewed everything. [Publisher trust](https://mozilla.github.io/cargo-vet/trusting-publishers.html).
- This repository's `[inherit]` is broader: it extracts numeric account identities from sources' `trusted` entries and applies them across matching locked crates. It uses the earliest upstream start and this repository's own end, disregarding upstream end cutoffs. Newly endorsed accounts arrive automatically on synchronization. It does not inspect source or import custom criteria.
- `[[publishers]]` is also account-wide under the current generator. It cannot express CI signatures or a restricted crate list. Account/repository control, code contributions accepted by maintainers, publishing credentials/workflows, packaging, and build scripts become part of the trust decision.
- Depending on a crate is not the same as auditing it. Repository/profile and packaged manifest evidence below supports upstream affiliation and a reputation-based choice, not an assertion of an independent review.

## Audit-source choices

| Source | Import choice | Additional inherit value for this backlog | Evidence and trust scope |
|---|---|---|---|
| Mozilla | Keep existing import/inheritance | Already selected | Mozilla's audits plus locally widened publisher endorsements. |
| Bytecode Alliance | Keep existing import/inheritance | Already selected | Wasmtime/Bytecode Alliance audits and locally widened publisher endorsements. |
| Google | Keep import; use canonical rust-crate-audits URL when convenient | None: no `trusted` records in fetched feed | Aggregates Chromium, ChromiumOS, Fuchsia and Google manual sources. It is already the broad Google source; an extra ChromeOS import is redundant for this task. [Description](https://github.com/google/rust-crate-audits/blob/main/README.md). |
| ISRG | Keep import | None: its account set is a subset of existing inherited accounts | Divvi Up/libprio review records. |
| Zcash | Keep import | Seven additional accounts, none matching pasted targets | Adds Zcash ecosystem release accounts, mostly unrelated here. No backlog reason to widen inheritance. |
| Embark Studios | Add import | Its sole account is already inherited | Clears ident_case 1.0.1; async-recursion review becomes a 1,057-line delta and convert_case a 2,373-line delta. Embark maintains Rust tooling including cargo-deny, and Wasmtime, ISRG and Zcash explicitly import its feed. [Feed](https://github.com/EmbarkStudios/rust-ecosystem/blob/main/audits.toml). |
| Ariel OS | Add import | Three additional accounts, none matching pasted targets | Clears SDK futures-task/util 0.3.32 and reduces Infumap log to the pasted 190-line residual delta. Named embedded-OS reviewers, including INRIA-affiliated audit identity; smaller reputation basis than Google/Mozilla. [Feed](https://github.com/ariel-os/ariel-os/blob/main/supply-chain/audits.toml). |
| Fermyon / Spin | Optional import, no immediate gain found | None: no `trusted` entries | Established Wasm runtime project. Wasmtime now imports spinframework/spin. Fetched old/new Spin endpoints had equivalent seven-audit content. |
| Actix | No need for this backlog | None: no `trusted` entries | Feed contains Actix first-party wildcard audits, with no matching gap here. Registry membership is discovery, not endorsement. |

Add the following to both projects' `supply-chain/config.toml` if choosing these imports. They do not need to be added to `[inherit].sources`:

```toml
[imports.embark-studios]
url = "https://raw.githubusercontent.com/EmbarkStudios/rust-ecosystem/main/audits.toml"

[imports.ariel-os]
url = "https://raw.githubusercontent.com/ariel-os/ariel-os/main/supply-chain/audits.toml"
```

Keep `[inherit].sources = ["mozilla", "bytecode-alliance"]` for now. Inheritance also requires that a source be configured with the same URL in both projects.

## Existing trust that is not reaching historical review bases

| Already accepted identity | Suggested base | Locked version that becomes covered |
|---|---|---|
| carllerche, account 10 | tower-layer 0.1.0 | tower-layer 0.3.3 |
| cuviper, account 539 | find-msvc-tools 0.1.0 | find-msvc-tools 0.1.15 |
| ctz, account 2751 | ring 0.17.11 | ring 0.17.14 |

The generator only emits a crate/account pair if the locked release itself matches. It therefore misses already-trusted older releases that can connect through existing audited deltas. These three additions reuse an existing identity decision and clear three locked-version gaps without trusting a new account. Preserve the existing account publication ranges when implementing this; the projection used complete historical cached metadata to demonstrate the paths.

## Recommended explicit account choices

These are discretionary upstream-maintainer trust decisions, not newly discovered third-party audits. The exact current gaps and numeric crates.io IDs are listed in the complete inventory below. Prefer named-crate scope if the generator is extended to support it.

| Account | Why this is a reasonable practical choice and what it trusts |
|---|---|
| `justsmth` (156764) | AWS Cryptography release maintainer. The actual AWS-LC releases are published by this account; trust AWS's native library, Rust wrapper, packaging and build process. Largest single saving. [AWS releases](https://github.com/aws/aws-lc-rs/releases), [maintainer](https://github.com/justsmth). |
| `fulmicoton` (4674) | Paul Masurel, Tantivy author; accept the upstream search engine and its helper crates rather than independently auditing them. [Tantivy](https://github.com/quickwit-oss/tantivy). |
| `PSeitz` (6354) | Pascal Seitz, Tantivy maintainer and lz4_flex author. Includes the Tantivy FST fork: this is trust in its current publisher, not inherited trust in the original FST author. [Profile](https://github.com/PSeitz). |
| `danielrh` (4185) | Daniel Reiter Horn, author of the Dropbox Rust Brotli and allocator crates. Accept that release process and bundled implementation. [Dropbox Brotli](https://github.com/dropbox/rust-brotli). |
| `lu-zero` (4718) | Luca Barbato, upstream rav1e/rust-av publisher and author of the named macro/helper crates. Accept Xiph/rust-av maintenance and packaging. [rav1e](https://github.com/xiph/rav1e). |
| `shssoichiro` (3357) | Josh Holmer, publisher of the rav1e scene-change/grain helpers. Separate release authority from lu-zero; trusting rav1e alone does not certify these dependencies. [Scene change](https://github.com/rust-av/av-scenechange). |
| `tarcieri` (267) | Tony Arcieri, RustCrypto maintainer. Accept the RustCrypto implementation and releases for the named crates; this does not assert a fresh independent cryptographic audit. [RustCrypto members](https://github.com/orgs/RustCrypto/people). |
| `newpavlov` (5059) | Artyom Pavlov, RustCrypto maintainer. Separate actual release account for the named crates. [RustCrypto members](https://github.com/orgs/RustCrypto/people). |
| `taiki-e` (33035) | Taiki Endo, established Rust concurrency/tooling maintainer. Covers Crossbeam/fastrand and the SDK's futures releases; pin-project-lite now uses a separate CI identity. [Profile](https://github.com/taiki-e). |
| `sffc` (128408) | Shane F. Carr, ICU4X maintainer and actual publisher of these six internationalization crates. Manishearth endorsements do not automatically cover this account. [ICU4X](https://github.com/unicode-org/icu4x), [profile](https://github.com/sffc). |
| `hsivonen` (4484) | Henri Sivonen, upstream IDNA/encoding developer. Direct trust for the actual idna_adapter publisher. [Profile](https://github.com/hsivonen). |
| `197g` (11453) | Actual publisher for five canonical image-rs releases. Accept the image-rs maintenance/release process; a dependency on this code is not itself an independent audit. [image-rs](https://github.com/image-rs/image). |
| `kornelski` (988) | Kornel Lesinski, established Rust imaging and platform-integration maintainer; actual publisher of these eight crates. Prefer explicit crate scope if adding that capability. [Profile](https://github.com/kornelski). |
| `KodrAus` (3204) | Ashley Mannix, established bitflags/UUID maintainer and actual publisher. Covers separate UUID versions in both projects. [Profile](https://github.com/KodrAus). |
| `gyscos` (3203) | Alexandre Bury, zstd-rs author/maintainer. Accept the Rust wrapper, native zstd packaging and build behavior. [zstd-rs](https://github.com/gyscos/zstd-rs). |
| `jhpratt` (15682) | Time ecosystem maintainer and actual powerfmt publisher. Time and deranged themselves now have separate CI publisher identities. [Time](https://github.com/time-rs/time). |
| `joshlf` (7178) | Joshua Liebow-Feeser, zerocopy maintainer and SDK release publisher. The newer Infumap releases use the google/zerocopy CI identity, requiring its own decision. [zerocopy](https://github.com/google/zerocopy). |

## Recommended explicit CI release identities

These identify specific repository publishing authorities, not every repository in the organization. Add a durable signature-aware policy capability before using them: current `trusted-publishers.toml` and the generator accept only numeric account IDs. Cargo-vet 0.10.3 itself supports `trusted-publisher = "github:owner/repo"`.

| Identity | Trust being granted |
|---|---|
| `github:wasm-bindgen/wasm-bindgen` | Canonical wasm-bindgen CI/release authority, including generated JS/Web API bindings. Not Alex Crichton's personal account. |
| `github:google/zerocopy` | Canonical Google zerocopy CI/release authority. Does not imply that Google's audit feed reviewed these exact newer releases. |
| `github:rust-lang/libc` | Canonical libc release repository and its maintainers/workflows. |
| `github:rust-lang/cc-rs` | Canonical cc-rs release repository, including current find-msvc-tools. Existing cuviper trust is not the CI identity. |
| `github:rust-lang/log` | Canonical Rust log release repository. Ariel reduces the review delta but does not cover the newest release. |
| `github:rust-lang/flate2-rs` | Canonical flate2 release repository. Historical Alex Crichton/Byron trust does not identify these releases. |
| `github:rust-lang/ar_archive_writer` | Specific upstream archive-writer repository and build process; this is not blanket trust in every rust-lang repository. |
| `github:rust-random/rand` | Canonical Rand release repository; covers the two Rand branches in the graph. |
| `github:taiki-e/pin-project-lite` | Canonical pin-project-lite release pipeline, separate from Taiki's account-published crates. |
| `github:RustCrypto/hashes` | RustCrypto hashes release pipeline for the newer SHA-1 crate; separate from tarcieri/newpavlov account releases. |
| `github:time-rs/time` | Canonical Time release pipeline for time/time-macros. |
| `github:jhpratt/deranged` | Time maintainer's canonical deranged release pipeline. |
| `github:srijs/rust-crc32fast` | Canonical crc32fast release pipeline. |
| `github:Nullus157/async-compression` | Canonical async-compression release pipeline, including codec/core crates. |
| `github:pest-parser/pest` | Canonical Pest parser and macro/generator release pipeline. |

## Other candidates for additional reductions

These were not included in the 113/2 projection. They vary in reputation/evidence strength, and should not be read as one blanket endorsement. These are plausible scoped upstream-release choices to weigh against manual review; no additional configured-source publisher endorsement was established for them in this research.

| Account / pipeline | Reason to consider it; limits |
|---|---|
| `dvdhrm` | Canonical r-efi release maintainer. Scoped trust would resolve the remaining UEFI gap in both projects; this is upstream-author trust, not a new outside audit. |
| `4lDO2` | Actual Redox libredox/syscall publisher. Verify the Redox maintainer relationship and accept these specific releases if comfortable. Resolves the remaining SDK Redox gap. |
| `jackpot51` | Jeremy Soller, Redox maintainer; actual redox_users publisher. A separate identity from 4lDO2. |
| `GuillaumeGomez` | Established Rust contributor and sysinfo maintainer. Stronger practical candidate than manually reading all platform backends for this threat model. |
| `madsmtm` | Canonical objc2 ecosystem maintainer; the large I/O Kit crate contains extensive Apple bindings. Accept upstream generation and packaging if this matches your trust model. |
| `awxkee` | Author/publisher of moxcms and pxfm. Large savings, but the evidence established here is upstream authorship and image-rs usage, not an independent third-party code review. A more discretionary choice. |
| `etemesi254` | Zune codec author/publisher. Consider scoped trust for the three named imaging crates; dependency use by image-rs is not an audit. |
| `johannesvollmer` | EXR/lebe author/publisher. Consider scoped acceptance of that codec implementation. |
| `fintelia` | Image ecosystem publisher for byteorder-lite and image-webp. Consider these specific crates rather than an unrestricted future account decision. |
| `TedDriggs` | Established darling proc-macro ecosystem author. Scope to darling/darling_core/darling_macro; ident_case is already handled by Embark. Accept build-time macro execution. |
| `tkaitchuck` | AHash/const-random ecosystem author. Accept both hashing implementation and build-time random-generation macros if selecting this group. |
| `Lokathor` | Established bytemuck maintainer. Direct acceptance of bytemuck releases; a full unsafe-code soundness audit is a different assurance claim. |
| `bluss` | Established Rust collections/numerical maintainer. Small arrayvec delta remains an inexpensive manual alternative. |
| `vorner` | Established arc-swap maintainer. Scoped direct trust is a practical option for this concurrency primitive. |
| `nagisa` | Stacker/PSM runtime maintainer. Trust includes assembly/native build integration, not merely the high-level wrapper. |
| `SergioBenitez` | Rocket ecosystem author and actual cookie/version_check publisher. Consider scoped direct trust. |
| `ehuss` | Rust/Cargo maintainer and actual home publisher. Small delta also makes manual review inexpensive. |
| `Noratrieb` | Rust contributor and actual rustc-hash publisher. Small delta is another inexpensive manual alternative. |
| `jamesmunns` | Established embedded Rust maintainer and aligned publisher. Prefer crate scope. |
| `phil-opp` | Established systems Rust author and bit_field publisher; tiny delta remains a low-cost manual option. |
| `mystor` | Established Rust/Mozilla contributor and synstructure author/publisher. Includes proc-macro build-time behavior. |
| `hds` | Actual current tracing publisher. Tokio repository association supports investigating this release authority; do not substitute trust in a different historical tracing maintainer. |
| `paholg` | Typenum release publisher. Generated/type-level source volume overstates the amount of distinct behavior, but no fresh outside full audit was established here. |
| `Storyyeller` | Stable-deref-trait publisher. The delta is small enough that manual review may cost less than another enduring trust decision. |
| `de-vri-es` | Actual memmap2 maintainer/publisher. Consider scoped trust in this memory-mapping implementation. |
| `adamreichold` | Actual roxmltree maintainer/publisher. Consider scoped trust in the canonical XML parser. |
| `breezewish` | Rust Prometheus client publisher. Consider that upstream implementation/release process; no fresh third-party full audit established here. |
| `MattiasBuelens` | Wasm-streams author/publisher. Separate project/release authority from wasm-bindgen. |
| `tuffy` | Bitstream-io author/publisher. Consider scoped trust for this established format primitive. |
| `conradkleinespel` | Rpassword/rtoolbox author/publisher. Acceptance includes intentional terminal/password interaction and platform implementation. |
| `jdm` | Established Servo/platform contributor and core-foundation publisher. Small delta is a cheap manual alternative. |
| `steffengy` | Schannel publisher. Consider scoped acceptance of its Windows TLS integration. |
| `aclysma` | Profiling/profiling-procmacros author/publisher. One decision spans runtime helpers and build-time macros. |
| `soc` | Dirs/dirs-sys publisher. Choose based on willingness to accept this upstream platform-directory implementation. |
| `github:elastio/bon` | Canonical Bon builder-macro release pipeline. An additional project-specific trust decision; not covered by trusting other proc-macro authors. |

## Cases to leave for manual review or further provenance work

- UNKNOWN: winapi-i686-pc-windows-gnu 0.4.0, winapi-x86_64-pc-windows-gnu 0.4.0, htmlescape 0.3.1. No known publisher identity to trust in cached/pasted metadata. Resolve provenance or review the artifacts; do not invent an account ID.
- HarpeLm / Heifer, Xuanwo/frostem, tisonkun/datasketches and the remaining unclassified publishers below: no sufficient independent vetting or reputation assessment was established here to recommend automatic acceptance. This is an evidence limit, not a finding of maliciousness. In particular, trusting Tantivy does not automatically vet Frostem/Datasketches.
- Do not mechanically trust whichever historical person cargo-vet names in a NOTE. Manishearth does not cover sffc, Alex Crichton does not cover the wasm-bindgen CI identity, mbrubeck does not cover alejandro-vaz, rnijveld does not cover folkertdev, and djc does not cover kyren.
- Do not map custom criteria such as `does-not-implement-crypto` to `safe-to-run` merely to manufacture coverage. Keep source-audit import claims and publisher acceptance separate.

## Implementation implications

1. Add the two audit imports in both stores and refresh evidence once. Do not add inheritance sources just because they have a recognizable organization name.
2. Add numeric explicit account choices through `[[publishers]]`. The `--trust` convenience command refuses accounts unless a configured source has a matching `trusted` record; it is not a general mechanism for the newly recommended maintainers.
3. Extend the generator/policy to handle exact CI publisher signatures and, preferably, crate scopes and historical audited-base publishers. The current `published_by`-only registry lookup does not handle CI releases with `published_by = null` and `trustpub_data` set.
4. The synchronizer owns and replaces every local `[[trusted.*]]` table. Direct `cargo vet trust` edits in the working stores would be erased on the next synchronization, so they are not a durable workaround.
5. Make new publisher decisions with an explicit publication start and fixed future cutoff, e.g. 2027-11-10 for a roughly annual reconsideration. Broad inheritance currently uses 2028-11-10 and may extend an upstream endorsement beyond its own cutoff; retaining that is a separate operator choice.
6. If unwanted image codecs/features can be removed, that can eliminate rav1e/scene-change or other large subgraphs. This changes supported functionality and needs a separate explicit decision. Do not hide target-specific crates by filtering the vet graph while continuing to ship/support those builds.

Example for a deliberate account-wide AWS publisher decision, supported by the current schema (proposal only):

```toml
[[publishers]]
user-id = 156764
name = "Justin W Smith (justsmth)"
criteria = "safe-to-run"
start = "2022-11-09"
end = "2027-11-10"
notes = "Operator accepts AWS Cryptography maintainer releases, including AWS-LC native code and build/packaging behavior. Publisher-wide trust; no independent source review."
```

This example accepts other crates published by that account if later added to the graph. It cannot currently restrict acceptance to aws-lc-rs/aws-lc-sys. No signature example is presented as valid top-level policy because that schema does not yet exist.

## Complete publisher inventory for the uncovered locked versions

This table uses the locked version, not cargo-vet's sometimes older suggested review base. Shared versions are listed per requesting project. The inventory covers all 223 Infumap and 14 SDK failures. “Review/provenance” means insufficient basis established to suggest automatic acceptance; it is not an adverse security finding.

| Publisher and crates.io account ID | Position | Exact currently uncovered versions by project |
|---|---|---|
| `fulmicoton` / 4674 | Recommended explicit upstream trust | **infumap**: `bitpacking 0.9.3`, `census 0.4.2`, `fastdivide 0.4.2`, `levenshtein_automata 0.2.1`, `murmurhash32 0.4.0`, `tantivy 0.27.0`, `tantivy-bitpacker 0.27.0`, `tantivy-columnar 0.27.0`, `tantivy-common 0.27.0`, `tantivy-query-grammar 0.27.0`, `tantivy-sstable 0.27.0`, `tantivy-stacker 0.27.0` |
| `github:wasm-bindgen/wasm-bindgen` | Recommended explicit upstream trust | **infumap**: `js-sys 0.3.107`, `wasm-bindgen 0.2.130`, `wasm-bindgen-futures 0.4.80`, `wasm-bindgen-macro 0.2.130`, `wasm-bindgen-macro-support 0.2.130`, `wasm-bindgen-shared 0.2.130`, `web-sys 0.3.107`<br>**infusdk**: `js-sys 0.3.98`, `wasm-bindgen 0.2.121`, `wasm-bindgen-macro 0.2.121`, `wasm-bindgen-macro-support 0.2.121`, `wasm-bindgen-shared 0.2.121` |
| `tarcieri` / 267 | Recommended explicit upstream trust | **infumap**: `aead 0.5.2`, `aes 0.8.4`, `aes-gcm 0.10.3`, `argon2 0.5.3`, `base64ct 1.8.3`, `digest 0.10.7`, `ghash 0.5.1`, `password-hash 0.5.0`, `polyval 0.6.2` |
| `danielrh` / 4185 | Recommended explicit upstream trust | **infumap**: `alloc-no-stdlib 2.0.4`, `alloc-no-stdlib 3.0.0`, `alloc-stdlib 0.2.4`, `alloc-stdlib 0.3.0`, `brotli 6.0.0`, `brotli 9.1.1`, `brotli-decompressor 4.0.3`, `brotli-decompressor 6.3.0` |
| `kornelski` / 988 | Recommended explicit upstream trust | **infumap**: `avif-serialize 0.8.9`, `imgref 1.12.3`, `loop9 0.1.5`, `ravif 0.13.0`, `rgb 0.8.53`, `security-framework 3.7.0`, `security-framework-sys 2.17.0`, `urlencoding 2.1.3` |
| `taiki-e` / 33035 | Recommended explicit upstream trust | **infumap**: `crossbeam-deque 0.8.8`, `crossbeam-epoch 0.9.21`, `crossbeam-utils 0.8.23`, `fastrand 2.5.0`<br>**infusdk**: `futures-channel 0.3.32`, `futures-task 0.3.32`, `futures-util 0.3.32` |
| `lu-zero` / 4718 | Recommended explicit upstream trust | **infumap**: `arg_enum_proc_macro 0.3.4`, `interpolate_name 0.2.4`, `noop_proc_macro 0.3.0`, `rav1e 0.8.1`, `simd_helpers 0.1.0`, `v_frame 0.3.9` |
| `sffc` / 128408 | Recommended explicit upstream trust | **infumap**: `litemap 0.8.3`, `potential_utf 0.1.6`, `writeable 0.6.4`, `zerofrom 0.1.8`, `zerofrom-derive 0.1.8`, `zerotrie 0.2.5` |
| `197g` / 11453 | Recommended explicit upstream trust | **infumap**: `gif 0.14.2`, `image 0.25.10`, `png 0.18.1`, `tiff 0.11.3`, `weezl 0.1.12` |
| `PSeitz` / 6354 | Recommended explicit upstream trust | **infumap**: `lz4_flex 0.14.0`, `measure_time 0.9.0`, `ownedbytes 0.9.0`, `tantivy-fst 0.5.0`, `tantivy-tokenizer-api 0.7.0` |
| `TedDriggs` / 6324 | Optional scoped upstream trust | **infumap**: `darling 0.24.1`, `darling_core 0.24.1`, `darling_macro 0.24.1`, `ident_case 1.0.1` |
| `github:pest-parser/pest` | Recommended explicit upstream trust | **infumap**: `pest 2.9.5`, `pest_derive 2.9.5`, `pest_generator 2.9.5`, `pest_meta 2.9.5` |
| `4lDO2` / 42742 | Optional scoped upstream trust | **infumap**: `libredox 0.1.25`, `redox_syscall 0.5.18`<br>**infusdk**: `redox_syscall 0.5.18` |
| `HarpeLm` / 443671 | Review/provenance | **infumap**: `heifer 0.4.0`, `heifer-hevc-dec 0.4.0`, `heifer-isobmff 0.4.0` |
| `KodrAus` / 3204 | Recommended explicit upstream trust | **infumap**: `bitflags 2.13.2`, `uuid 1.29.1`<br>**infusdk**: `uuid 1.23.1` |
| `UNKNOWN` | Review/provenance | **infumap**: `htmlescape 0.3.1`, `winapi-i686-pc-windows-gnu 0.4.0`, `winapi-x86_64-pc-windows-gnu 0.4.0` |
| `durch` / 4441 | Review/provenance | **infumap**: `aws-creds 0.40.0`, `aws-region 0.29.0`, `rust-s3 0.38.0` |
| `dvdhrm` / 12177 | Optional scoped upstream trust | **infumap**: `r-efi 5.3.0`, `r-efi 6.0.0`<br>**infusdk**: `r-efi 6.0.0` |
| `etemesi254` / 159371 | Optional scoped upstream trust | **infumap**: `zune-core 0.5.3`, `zune-inflate 0.2.54`, `zune-jpeg 0.5.15` |
| `github:Nullus157/async-compression` | Recommended explicit upstream trust | **infumap**: `async-compression 0.4.52`, `compression-codecs 0.4.47`, `compression-core 0.4.34` |
| `gyscos` / 3203 | Recommended explicit upstream trust | **infumap**: `zstd 0.13.4`, `zstd-safe 7.4.0`, `zstd-sys 2.1.2+zstd.1.5.7` |
| `newpavlov` / 5059 | Recommended explicit upstream trust | **infumap**: `blake2 0.10.6`, `crypto-common 0.1.7`, `ctr 0.9.2` |
| `sarah-quinones` / 152358 | Review/provenance | **infumap**: `aligned-vec 0.6.4`, `equator 0.4.2`, `equator-macro 0.4.2` |
| `tkaitchuck` / 25353 | Optional scoped upstream trust | **infumap**: `ahash 0.8.12`, `const-random 0.1.18`, `const-random-macro 0.1.16` |
| `SergioBenitez` / 3864 | Optional scoped upstream trust | **infumap**: `cookie 0.18.2`, `version_check 0.9.5` |
| `aclysma` / 54231 | Optional scoped upstream trust | **infumap**: `profiling 1.0.18`, `profiling-procmacros 1.0.18` |
| `awxkee` / 266802 | Optional scoped upstream trust | **infumap**: `moxcms 0.8.1`, `pxfm 0.1.30` |
| `conradkleinespel` / 53 | Optional scoped upstream trust | **infumap**: `rpassword 7.5.4`, `rtoolbox 0.0.6` |
| `constantoine` / 85540 | Review/provenance | **infumap**: `qrcodegen-image 1.5.2`, `totp-rs 5.7.2` |
| `fintelia` / 5862 | Optional scoped upstream trust | **infumap**: `byteorder-lite 0.1.0`, `image-webp 0.2.4` |
| `github:elastio/bon` | Optional scoped upstream trust | **infumap**: `bon 3.10.3`, `bon-macros 3.10.3` |
| `github:google/zerocopy` | Recommended explicit upstream trust | **infumap**: `zerocopy 0.8.63`, `zerocopy-derive 0.8.63` |
| `github:rust-lang/cc-rs` | Recommended explicit upstream trust | **infumap**: `cc 1.11.1`, `find-msvc-tools 0.1.15` |
| `github:rust-random/rand` | Recommended explicit upstream trust | **infumap**: `rand 0.8.8`, `rand 0.9.5` |
| `github:taiki-e/pin-project-lite` | Recommended explicit upstream trust | **infumap**: `pin-project-lite 0.2.17`<br>**infusdk**: `pin-project-lite 0.2.17` |
| `github:time-rs/time` | Recommended explicit upstream trust | **infumap**: `time 0.3.55`, `time-macros 0.2.32` |
| `johannesvollmer` / 24596 | Optional scoped upstream trust | **infumap**: `exr 1.74.3`, `lebe 0.5.3` |
| `joshlf` / 7178 | Recommended explicit upstream trust | **infusdk**: `zerocopy 0.8.48`, `zerocopy-derive 0.8.48` |
| `justsmth` / 156764 | Recommended explicit upstream trust | **infumap**: `aws-lc-rs 1.19.0`, `aws-lc-sys 0.47.0` |
| `kamadak` / 5577 | Review/provenance | **infumap**: `kamadak-exif 0.5.5`, `mutate_once 0.1.2` |
| `nagisa` / 726 | Optional scoped upstream trust | **infumap**: `psm 0.1.32`, `stacker 0.1.25` |
| `sgodwincs` / 6933 | Review/provenance | **infumap**: `dlv-list 0.5.2`, `ordered-multimap 0.7.3` |
| `shssoichiro` / 3357 | Recommended explicit upstream trust | **infumap**: `av-scenechange 0.14.1`, `av1-grain 0.2.5` |
| `soc` / 2022 | Optional scoped upstream trust | **infumap**: `dirs 5.0.1`, `dirs-sys 0.4.1` |
| `zonyitoo` / 917 | Review/provenance | **infumap**: `rust-ini 0.20.0`, `rust-ini 0.21.3` |
| `AS1100K` / 261504 | Review/provenance | **infumap**: `pastey 0.1.1` |
| `Alexhuszagh` / 31684 | Review/provenance | **infumap**: `minimal-lexical 0.2.1` |
| `Ethiraric` / 250563 | Review/provenance | **infumap**: `yaml-rust2 0.8.1` |
| `GuillaumeGomez` / 111 | Optional scoped upstream trust | **infumap**: `sysinfo 0.37.2` |
| `IvanUkhov` / 62 | Review/provenance | **infumap**: `md5 0.8.1` |
| `Kagami` / 1882 | Review/provenance | **infumap**: `y4m 0.8.0` |
| `Lokathor` / 7211 | Optional scoped upstream trust | **infumap**: `bytemuck 1.25.2` |
| `LucioFranco` / 3959 | Historical-base fix avoids another identity | **infumap**: `tower-layer 0.3.3` |
| `MSxDOS` / 27926 | Review/provenance | **infumap**: `ntapi 0.4.3` |
| `MattiasBuelens` / 64142 | Optional scoped upstream trust | **infumap**: `wasm-streams 0.4.2` |
| `Noratrieb` / 130181 | Optional scoped upstream trust | **infumap**: `rustc-hash 2.1.3` |
| `Storyyeller` / 4492 | Optional scoped upstream trust | **infumap**: `stable_deref_trait 1.2.1` |
| `VoidStarKat` / 3416 | Review/provenance | **infumap**: `half 2.7.1` |
| `abonander` / 127 | Review/provenance | **infumap**: `mime_guess 2.0.5` |
| `adamreichold` / 17210 | Optional scoped upstream trust | **infumap**: `roxmltree 0.21.2` |
| `al8n` / 119762 | Review/provenance | **infumap**: `fs4 0.13.1` |
| `aldanor` / 3199 | Review/provenance | **infumap**: `qoi 0.4.1` |
| `alejandro-vaz` / 373789 | Review/provenance | **infumap**: `smallvec 1.16.5` |
| `andreasots` / 92 | Review/provenance | **infumap**: `base32 0.5.1` |
| `bluss` / 356 | Optional scoped upstream trust | **infumap**: `arrayvec 0.7.8` |
| `bojand` / 41437 | Review/provenance | **infumap**: `infer 0.19.0` |
| `breezewish` / 19336 | Optional scoped upstream trust | **infumap**: `prometheus 0.14.0` |
| `briansmith` / 2342 | Historical-base fix avoids another identity | **infumap**: `ring 0.17.14` |
| `calebzulawski` / 60168 | Review/provenance | **infumap**: `multiversion-macros 0.8.1` |
| `callum-oakley` / 23874 | Review/provenance | **infumap**: `json5 0.4.1` |
| `dcchut` / 55174 | Review/provenance | **infumap**: `async-recursion 1.2.0` |
| `de-vri-es` / 35980 | Optional scoped upstream trust | **infumap**: `memmap2 0.9.12` |
| `debris` / 2998 | Review/provenance | **infumap**: `tiny-keccak 2.0.2` |
| `ehuss` / 6202 | Optional scoped upstream trust | **infumap**: `home 0.5.12` |
| `fMeow` / 28057 | Review/provenance | **infumap**: `maybe-async 0.2.11` |
| `flier` / 3738 | Review/provenance | **infumap**: `mime-sniffer 0.1.3` |
| `folkertdev` / 256011 | Review/provenance | **infumap**: `zlib-rs 0.6.8` |
| `github:RustCrypto/hashes` | Recommended explicit upstream trust | **infumap**: `sha1 0.10.7` |
| `github:Xuanwo/frostem` | Review/provenance | **infumap**: `frostem 1.20260821.8` |
| `github:jhpratt/deranged` | Recommended explicit upstream trust | **infumap**: `deranged 0.5.9` |
| `github:rust-lang/ar_archive_writer` | Recommended explicit upstream trust | **infumap**: `ar_archive_writer 0.5.3` |
| `github:rust-lang/flate2-rs` | Recommended explicit upstream trust | **infumap**: `flate2 1.1.11` |
| `github:rust-lang/libc` | Recommended explicit upstream trust | **infumap**: `libc 0.2.191` |
| `github:rust-lang/log` | Recommended explicit upstream trust | **infumap**: `log 0.4.35` |
| `github:srijs/rust-crc32fast` | Recommended explicit upstream trust | **infumap**: `crc32fast 1.5.4` |
| `hds` / 172786 | Optional scoped upstream trust | **infumap**: `tracing 0.1.44` |
| `hsivonen` / 4484 | Recommended explicit upstream trust | **infumap**: `idna_adapter 1.2.2` |
| `jackpot51` / 2668 | Optional scoped upstream trust | **infumap**: `redox_users 0.4.6` |
| `jamesmunns` / 4956 | Optional scoped upstream trust | **infumap**: `aligned 0.4.3` |
| `jdm` / 2396 | Optional scoped upstream trust | **infumap**: `core-foundation 0.10.1` |
| `jeromefroe` / 4747 | Review/provenance | **infumap**: `lru 0.18.5` |
| `jhpratt` / 15682 | Recommended explicit upstream trust | **infumap**: `powerfmt 0.2.1` |
| `juntyr` / 133457 | Review/provenance | **infumap**: `ron 0.8.1` |
| `krisprice` / 8197 | Review/provenance | **infumap**: `ipnet 2.12.2` |
| `kyren` / 6715 | Review/provenance | **infumap**: `hashlink 0.8.4` |
| `lukaslueg` / 2816 | Review/provenance | **infumap**: `built 0.8.1` |
| `madsmtm` / 36629 | Optional scoped upstream trust | **infumap**: `objc2-io-kit 0.3.2` |
| `marcianx` / 3135 | Review/provenance | **infumap**: `downcast-rs 2.0.2` |
| `mcountryman` / 100904 | Review/provenance | **infumap**: `simd-adler32 0.3.10` |
| `mdsteele` / 4099 | Review/provenance | **infumap**: `cfb 0.7.3` |
| `mheffner` / 61119 | Review/provenance | **infumap**: `sketches-ddsketch 0.4.2` |
| `mkroening` / 91569 | Review/provenance | **infumap**: `hermit-abi 0.5.3` |
| `mystor` / 1947 | Optional scoped upstream trust | **infumap**: `synstructure 0.14.0` |
| `mzabaluev` / 919 | Review/provenance | **infumap**: `unwrap-infallible 1.0.0` |
| `nayuki` / 9317 | Review/provenance | **infumap**: `qrcodegen 1.8.0` |
| `paholg` / 243 | Optional scoped upstream trust | **infumap**: `typenum 1.20.1` |
| `phil-opp` / 880 | Optional scoped upstream trust | **infumap**: `bit_field 0.10.3` |
| `rutrum` / 85906 | Review/provenance | **infumap**: `convert_case 0.6.0` |
| `s3bk` / 43402 | Review/provenance | **infumap**: `fax 0.2.7` |
| `sbstp` / 2806 | Review/provenance | **infumap**: `attohttpc 0.30.1` |
| `steffengy` / 2728 | Optional scoped upstream trust | **infumap**: `schannel 0.1.30` |
| `tailhook` / 892 | Review/provenance | **infumap**: `quick-error 2.0.1` |
| `tisonkun` / 27442 | Review/provenance | **infumap**: `datasketches 0.5.0` |
| `tomtau` / 95892 | Review/provenance | **infumap**: `pest_stack_guard 1.0.1` |
| `tuffy` / 5955 | Optional scoped upstream trust | **infumap**: `bitstream-io 4.10.0` |
| `vorner` / 5906 | Optional scoped upstream trust | **infumap**: `arc-swap 1.9.4` |
| `wcampbell0x2a` / 74355 | Review/provenance | **infumap**: `no_std_io2 0.9.4` |
| `webdesus` / 5882 | Review/provenance | **infumap**: `fs_extra 1.3.0` |

## Evidence and projection limits

Compared all nine feeds in the public [cargo-vet registry](https://github.com/mozilla/cargo-vet/blob/main/registry.toml), plus ChromeOS and Spin after following existing source import configurations. Source URLs used are listed below. No exhaustive search of every possible unregistered personal audit set was attempted.

Projection used cargo-vet 0.10.3 with the checked-in manifests/lockfiles/local audit records and generated trust, complete publisher metadata reconstructed from the existing cargo-vet cache, and the freshly fetched feeds. Built-in safe-to-run/safe-to-deploy evidence was retained; unmapped custom criteria were ignored. Temporary stores were formatted and checked with `--locked --frozen --no-registry-suggestions --no-minimize-exemptions --output-format json`. Original stores were not edited. The unaugmented checked-in imports.lock lacks metadata for some current generated trust, so it is not alone a complete frozen copy of the pasted live result; the reconstructed baseline matched 223/14.

Hypothetical new records used publication dates 2000-01-01 inclusive through 2027-11-10 exclusive, for already-cached historical versions from selected publishers. An implementation should choose deliberate starts and preserve upstream-derived starts for existing identities. Narrower starts can change coverage. Full historical lookup is required for the three base-path wins; numeric-only edits to the current policy cannot reproduce all these projections.

The account/pipeline recommendations rely on upstream identity, official project pages and package repository/author metadata, not a source review or investigation proving the integrity of any current publishing account, workflow or release artifact. Cached publisher metadata was not independently refreshed for every release. Counts are projections under the recorded evidence, not a claim that the full Rust audit passed.

Initial frozen checks against unformatted temporary copies stopped on formatting; an initial attempt to inject entire unsanitized feeds hit a cargo-vet custom-criteria panic. The successful comparisons used formatted copies with built-in criteria only. No failed check is treated as successful validation.

Full Rust audit not rerun; this research compared cargo-vet coverage only. No tests or builds run. No certifications or trust changes written to the working stores.

| Input | SHA-256 |
|---|---|
| `trusted-publishers.toml` | `6dea113e88a9e7053e8c72229760d624bd885ab782fc7a2be7a049a0a24c6504` |
| `sync-publisher-trust.py` | `836af09ef0f486b685d782bc30a7503217d7e84fdb6daa698147539f08f0c018` |
| `DEPENDENCY_REVIEW.md` | `8c39814f52852f993b6393291d03c5d006b4409a3d912dded5708eecb07966be` |
| `infumap/Cargo.toml` | `51d2d6e985b8d298119f200297c01f3cffa836cc407cacacb59b6ff53d359816` |
| `infumap/Cargo.lock` | `d1d92878e669e7b61d3377c2c2ed4dc4bf3c8dfaa5b22fe4b02eae2909f8006e` |
| `infumap/supply-chain/config.toml` | `9b536b4c5cd2522399f8530b94e7d8984f94d289980b6523e2e456e19329cb3b` |
| `infumap/supply-chain/audits.toml` | `c23b57902856875b371ec0c8a3e4c0de94bd2f615bf909567f31c206947fc8e8` |
| `infumap/supply-chain/imports.lock` | `501af34b7b3e9d5b6a4594cdd74b48d1a7ac52d98383320e69f9d12d6cff3bd1` |
| `infusdk/Cargo.toml` | `be8b353903c39f4bf0c508eec878073d8c9903f4fe1cf4b14477f84e770343bd` |
| `infusdk/Cargo.lock` | `94e7355a9751118b3704ee03d282b8e32ce892f7c2ab6723a487dbe00f291632` |
| `infusdk/supply-chain/config.toml` | `701f6fa81a02581f0e57528357c404f17d662436080bd682c3d1441a55685dd0` |
| `infusdk/supply-chain/audits.toml` | `ffc627c0bd1cf4d4fd3bf57c492862dd9f07dfcb43737f0f6cdc3005f8c17f4e` |
| `infusdk/supply-chain/imports.lock` | `20789d5c6af25a599edb49f7cc0c6c969a5cff05da2a1cd2bc42db09cb4e4cfe` |

| Fetched public feed | Snapshot SHA-256 |
|---|---|
| [actix](https://raw.githubusercontent.com/actix/supply-chain/main/audits.toml) | `38f9b9a5bbcfa1829248920276ebe641d3aa4b87fb0c031d8e28a1befec0dd83` |
| [ariel-os](https://raw.githubusercontent.com/ariel-os/ariel-os/main/supply-chain/audits.toml) | `27b0bfc16e0891cc41e33da42cf3fd9e6da49aac1a78817a28c3496c0794898f` |
| [bytecode-alliance](https://raw.githubusercontent.com/bytecodealliance/wasmtime/main/supply-chain/audits.toml) | `d593efbdf3ac3475cca6bb8d2406389476a1ee9388c8a90df38cc9d22054ac36` |
| [embark-studios](https://raw.githubusercontent.com/EmbarkStudios/rust-ecosystem/main/audits.toml) | `c8d3cd352b3b8528e131054be3701357ec26495b1db7148896503a1c42ab9418` |
| [fermyon](https://raw.githubusercontent.com/fermyon/spin/main/supply-chain/audits.toml) | `68ff32b3e44588892c92fd71ca995238cb1136c7289754da73b31e6010d3c0b4` |
| [google](https://raw.githubusercontent.com/google/supply-chain/main/audits.toml) | `3d933832eb671c4c470ccead30df5ab4321a62f7848115206adf282a50ddb0ea` |
| [isrg](https://raw.githubusercontent.com/divviup/libprio-rs/main/supply-chain/audits.toml) | `c57a1843c5b22c0a1ab12eb25944e3c2a4b5f98beecb529ed3c6fd3f0bd40fc9` |
| [mozilla](https://raw.githubusercontent.com/mozilla/supply-chain/main/audits.toml) | `690fe6d4754035225b019c5060aecc81ff4cea5565497568a3cd066e6c21071e` |
| [zcash](https://raw.githubusercontent.com/zcash/rust-ecosystem/main/supply-chain/audits.toml) | `f7e0db3983d4553588d1c96d95b59f4eb9acf04d076ceb1a31eaa543e3afa6c6` |

Successful machine-readable projection outputs and scratch comparison scripts are in `/tmp/infumap-trust-research/` for this session. No temporary records are operative repository trust decisions.

## Implementation update — 2026-11-11

The operator subsequently approved the 17 accounts under "Recommended explicit
account choices". They are now recorded in `trusted-publishers.toml` with
`safe-to-run`, a fixed exclusive publication cutoff of 2027-11-10, and individual
notes explaining upstream affiliation, motivating dependencies, sources and
publisher-wide acceptance without independent source review. Each start is the
earliest currently locked release from that account, verified against crates.io;
all 17 account IDs were also verified against its user API. These starts are
narrower than the hypothetical 2000-01-01 projection above.

Synchronization generated 96 explicit-account records for Infumap and 10 for
Infusdk, including the policy rationale in each record's persistent `notes`.
Existing non-trust audit records were preserved. Refreshed approved-source audits
and publisher metadata were retained in both `imports.lock` files so locked
checks can use the new trust. The inherited source selection remains Mozilla and
Bytecode Alliance. No CI publisher identities or historical-base handling changes
were added; those remain separate proposals.

Final `cargo vet --locked --frozen --no-minimize-exemptions
--no-registry-suggestions --output-format json` checks reported 145 Infumap gaps
and 8 Infusdk gaps, all for `safe-to-run`. Both checks therefore still fail vetting
because other dependencies remain uncovered. These are the actual results for
the implemented account selection, rather than the broader 113/2 projection.
The input hashes above describe the earlier research baseline, not this updated
policy. Full Rust audit not rerun; this update validated cargo-vet records only.
No tests or builds were run, and no source-review certifications were added.
