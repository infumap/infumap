# Compatible dependency downgrades — 2026-11-11

Prepared by Codex (AI). This records dependency selection and audit-evidence checks, not a new dependency source review or certification.

The operator explicitly authorized applying manifest-compatible downgrades, including changed behavior and omitted newer fixes. Both Cargo.toml files and the shared trust/advisory policies are unchanged. Changes are left in the working tree; no commit or push.

Recorded at: 2026-11-11T09:43:57+07:00. Baseline commit: `345eeca1ddd0f9b16cbc1b041ee676bd8fa5eb2c`; the working tree was clean before this task.

## Result

| Project | Previously uncovered versions | Finally uncovered versions | Net reduction | Lockfile package-count reduction |
|---|---:|---:|---:|---:|
| Infumap | 145 | 107 | 38 | 5 |
| Infusdk | 8 | 1 | 7 | 34 |

The remaining SDK gap is `redox_syscall 0.5.18`. All versions newly introduced by this task have accepted safe-to-run paths in the final stores. Some paths are third-party audits, others use existing approved publisher trust. No publisher identity, trust date, exemption, criterion mapping, or advisory exception was added or widened.

## Principal decisions

- Infumap libc 0.2.189, log 0.4.34, time 0.3.51 and zerocopy 0.8.56 are releases accepted under existing publisher choices. They avoid the newer CI-published versions without introducing CI publisher trust.
- The coordinated Pest 2.7.0 rollback stays within json5's requirements and uses existing Google audit evidence. It removes pest_stack_guard, stacker, psm, ar_archive_writer and object. This also removes the newer parser stack-guard behavior; deeply nested JSON5 configuration can behave differently. It is an explicitly accepted downgrade tradeoff, not a hardening improvement.
- flate2 1.1.5 satisfies compression-codecs' ^1.1.4 requirement and is accepted through the already-inherited Byron publisher identity. Its selected feature graph avoids the newer runtime-detection path, zlib-rs and the extra miniz_oxide 0.9 branch. That permits audited simd-adler32 0.3.7.
- AHash 0.8.11 introduces zerocopy's 0.7 branch. Allowing its newest 0.7.35 would create two uncovered versions, so the branch is held at audited zerocopy/zerocopy-derive 0.7.34. The independent 0.8 branch remains at 0.8.56.
- SDK UUID 1.8.0 is the manifest floor and has an accepted Google audit chain. The SDK only calls Uuid::new_v4().to_string() in infusdk/src/util/uid.rs; that API exists in 1.8.0. This rollback removes the newer getrandom branch and the wasm-bindgen/WASI dependency branches from its lockfile. An intermediate attempt to downgrade wasm-bindgen separately became unnecessary and is absent from the final lockfile.
- The SDK's sole pin-project-lite downgrade and the Infumap patch/minor selections below are accepted by Cargo's resolver under all existing manifests and transitive constraints. These are lockfile selections, not new restrictive version requirements; a future cargo update can reopen vet gaps.

## Final version changes

The tables describe final lockfile differences, including coordinated transitive changes. No package was built or tested.

### infumap

| Crate | Before | After |
|---|---|---|
| `ahash` | `0.8.12` | `0.8.11` |
| `arrayvec` | `0.7.8` | `0.7.6` |
| `bit_field` | `0.10.3` | `0.10.2` |
| `bytemuck` | `1.25.2` | `1.22.0` |
| `core-foundation` | `0.10.1` | `0.10.0` |
| `crc32fast` | `1.5.4` | `1.4.2` |
| `deranged` | `0.5.9` | `0.5.8` |
| `flate2` | `1.1.11` | `1.1.5` |
| `half` | `2.7.1` | `2.5.0` |
| `hermit-abi` | `0.5.3` | `0.5.2` |
| `home` | `0.5.12` | `0.5.11` |
| `libc` | `0.2.191` | `0.2.189` |
| `log` | `0.4.35` | `0.4.34` |
| `maybe-async` | `0.2.11` | `0.2.10` |
| `memmap2` | `0.9.12` | `0.9.11` |
| `pest` | `2.9.5` | `2.7.0` |
| `pest_derive` | `2.9.5` | `2.7.0` |
| `pest_generator` | `2.9.5` | `2.7.0` |
| `pest_meta` | `2.9.5` | `2.7.0` |
| `pin-project-lite` | `0.2.17` | `0.2.16` |
| `rand` | `0.8.8, 0.9.5` | `0.8.6, 0.9.4` |
| `rustc-hash` | `2.1.3` | `2.1.1` |
| `sha1` | `0.10.7` | `0.10.6` |
| `simd-adler32` | `0.3.10` | `0.3.7` |
| `smallvec` | `1.16.5` | `1.15.2` |
| `stable_deref_trait` | `1.2.1` | `1.2.0` |
| `time` | `0.3.55` | `0.3.51` |
| `time-macros` | `0.2.32` | `0.2.30` |
| `tracing` | `0.1.44` | `0.1.41` |
| `version_check` | `0.9.5` | `0.9.4` |
| `zerocopy` | `0.8.63` | `0.7.34, 0.8.56` |
| `zerocopy-derive` | `0.8.63` | `0.7.34, 0.8.56` |

Removed entirely: `ar_archive_writer 0.5.3`, `object 0.39.1`, `pest_stack_guard 1.0.1`, `psm 0.1.32`, `stacker 0.1.25`, `zlib-rs 0.6.8`.

### infusdk

| Crate | Before | After |
|---|---|---|
| `pin-project-lite` | `0.2.17` | `0.2.16` |
| `uuid` | `1.23.1` | `1.8.0` |

Removed entirely: `anyhow 1.0.104`, `bumpalo 3.20.2`, `equivalent 1.0.2`, `foldhash 0.1.5`, `hashbrown 0.15.5`, `hashbrown 0.17.1`, `heck 0.5.0`, `id-arena 2.3.0`, `indexmap 2.14.0`, `js-sys 0.3.98`, `leb128fmt 0.1.0`, `once_cell 1.21.4`, `prettyplease 0.2.37`, `r-efi 6.0.0`, `rustversion 1.0.22`, `semver 1.0.28`, `unicode-xid 0.2.6`, `wasip2 1.0.3+wasi-0.2.9`, `wasip3 0.4.0+wasi-0.3.0-rc-2026-01-06`, `wasm-bindgen 0.2.121`, `wasm-bindgen-macro 0.2.121`, `wasm-bindgen-macro-support 0.2.121`, `wasm-bindgen-shared 0.2.121`, `wasm-encoder 0.244.0`, `wasm-metadata 0.244.0`, `wasmparser 0.244.0`, `wit-bindgen 0.51.0`, `wit-bindgen 0.57.1`, `wit-bindgen-core 0.51.0`, `wit-bindgen-rust 0.51.0`, `wit-bindgen-rust-macro 0.51.0`, `wit-component 0.244.0`, `wit-parser 0.244.0`.

## Security floors and candidates not selected

- Rand 0.8.6 and 0.9.4 retain the fixes for [RUSTSEC-2026-0097](https://rustsec.org/advisories/RUSTSEC-2026-0097.html). Older audited 0.8.5/0.9.2 releases were excluded by the advisory screening.
- memmap2 0.9.11 retains the fix for [RUSTSEC-2026-0186](https://rustsec.org/advisories/RUSTSEC-2026-0186.html). Older audited 0.9.3/0.9.4 releases were excluded.
- ring 0.17.11 is an older trusted-publisher release, but it predates the 0.17.12 fix for [RUSTSEC-2025-0009](https://rustsec.org/advisories/RUSTSEC-2025-0009.html). ring stays at 0.17.14.
- cc's latest cached release from an already-approved account, 1.2.34, is below aws-lc-sys' ^1.2.41 and cmake's ^1.2.46 minimums. The latest audited 1.2.5 is also too old. cc and find-msvc-tools remain at their current versions.
- Audited async-recursion 1.0.2 is below the direct manifest's ^1.1.1 minimum, and multiversion-macros 0.8.0 is below multiversion's ^0.8.1 minimum. No manifest was relaxed to select them.
- Audited tower-layer 0.3.1 is below the current tower/tower-http ^0.3.3 minimums. No broader rollback of those parents was made.
- Infumap's oldest cached already-trusted js-sys release is 0.3.76, below reqwest/getrandom's ^0.3.77 minimum. Its wasm-bindgen family remains at the current versions.

## Verification and accepted paths

Cargo resolution used conservative `cargo update -p <name>@<old> --precise <target>` operations; `--offline` was used where cached manifests allowed it. Final `cargo metadata --locked --all-features --format-version 1` succeeded for each project, so no manifest or lockfile changes were required to resolve the selected final graph. Missing manifests were downloaded without compiling dependencies.

The RustSec database was refreshed and used at commit `28d73fc95e5972af3403225a217def57dcaba3c4`. Final cargo-audit checks on both actual lockfiles passed with zero reported vulnerabilities or warnings after the existing deny.toml exceptions were applied. Checks denied unsoundness, yanked releases and unmaintained crates; no-yanked was used only for preliminary candidate screening, not final checks.

```sh
cargo audit --file <project>/Cargo.lock --db /home/lima/.cargo/advisory-db --no-fetch \
  --deny unsound --deny yanked --deny unmaintained \
  --ignore RUSTSEC-2025-0056 --ignore RUSTSEC-2024-0436 --ignore RUSTSEC-2025-0134 --json
cargo vet --manifest-path <project>/Cargo.toml \
  --cache-dir /tmp/infumap-downgrade-work/cache --locked --frozen \
  --no-minimize-exemptions --no-registry-suggestions --output-format json
```

Both final vet checks still exit with failed-vetting status because 107/1 pre-existing gaps remain; they are not reported as a full vet pass. All newly selected dependency versions have accepted evidence. Existing non-trust audit records were compared structurally against the baseline and preserved.

| Representative final target | Actual cargo-vet explanation |
|---|---|
| `infumap: libc 0.2.189` | 1) [local] trusted entry for 0.2.189 (published by: rust-lang-owner) |
| `infumap: time 0.3.51` | 1) [local] trusted entry for 0.3.51 (published by: jhpratt) |
| `infumap: zerocopy 0.8.56` | 1) [local] trusted entry for 0.8.56 (published by: joshlf) |
| `infumap: zerocopy 0.7.34` | 1) [mozilla] full audit for 0.7.32 by Alex Franchuk <afranchuk@mozilla.com><br>2) [zcash] delta audit for 0.7.32->0.7.34 by Daira-Emma Hopwood <daira@jacaranda.org> |
| `infumap: pest 2.7.0` | 1) [google] full audit for 2.7.0 by George Burgess IV <gbiv@google.com> |
| `infumap: flate2 1.1.5` | 1) [local] trusted entry for 1.1.5 (published by: Byron) |
| `infusdk: uuid 1.8.0` | 1) [google] full audit for 1.3.0 by George Burgess IV <gbiv@google.com><br>2) [google] delta audit for 1.3.0->1.8.0 by Daniel Verkamp <dverkamp@chromium.org> |

## Publisher metadata and imported evidence

A live synchronization attempted 548 version lookups and hit crates.io HTTP 429 responses. The existing generator wrote empty trusted tables on lookup failure. Those temporary empty tables were replaced before validation; no source-review records were lost.

Final trust was regenerated with the unchanged sync-publisher-trust.py policy/rendering logic, using exact-version metadata from the existing cargo-vet caches and the previously downloaded Mozilla/Bytecode Alliance endorsement snapshots. Conflicting cache publisher identities were rejected. Every previously trusted crate remaining in the graph had cached exact-version metadata. Unknown publishers and CI identities were not treated as numeric accounts or accepted without evidence. No generator code was changed.

The final imports.lock files retain built-in audit evidence from the same seven already-configured feed snapshots used in the earlier trust research, plus cached publisher metadata. Unmapped custom criteria were not promoted. Native cargo-vet formatting and offline pruning were used; publisher metadata was then limited to locked versions or versions named in retained audit records. Final frozen checks confirmed identical coverage after that reduction. This avoids committing thousands of irrelevant historical publisher records.

The live API rate limit means this was not a successful full live publisher refresh. Until the limit clears, rerunning the existing synchronizer can again replace generated trust with empty tables. A fail-before-writing change to that generator is a separate follow-up, not part of these lockfile selections.

## Scope and remaining limits

- No tests, builds, examples or dependency build scripts were run. Resolution and advisory checks do not prove compilation or behavioral compatibility.
- Downgrades omit later changes and fixes that may not have advisories. Parser recursion/stack handling, compression implementation selection, OS support and UUID randomness/platform integration can differ.
- Browser wasm UUID randomness requires explicit feature configuration in both the original and downgraded UUID versions; the current SDK manifest requests v4 but not js. No target-specific build support was validated.
- Cargo.toml, trusted-publishers.toml, deny.toml and local source-review certifications are unchanged. No source-review safety or cryptographic certification was added.
- A future unrestricted cargo update can move these versions forward again. Full Rust audit not rerun; this task validated dependency resolution, RustSec/yanked status and cargo-vet records only.

## Recorded inputs

| File | Baseline SHA-256 | Final SHA-256 |
|---|---|---|
| `infumap/Cargo.toml` | `51d2d6e985b8d298119f200297c01f3cffa836cc407cacacb59b6ff53d359816` | `51d2d6e985b8d298119f200297c01f3cffa836cc407cacacb59b6ff53d359816` |
| `infumap/Cargo.lock` | `d1d92878e669e7b61d3377c2c2ed4dc4bf3c8dfaa5b22fe4b02eae2909f8006e` | `d21e4d4adf073b9ab6635975e331a4a4d78b592a1efdce62fa54b33032a8d9b2` |
| `infumap/supply-chain/config.toml` | `4a52c38914457493316a39f87fe909c368f6bdcfb67aa9276359cf9abf6b4c14` | `4a52c38914457493316a39f87fe909c368f6bdcfb67aa9276359cf9abf6b4c14` |
| `infumap/supply-chain/audits.toml` | `ad0e535df3ae007795499c61d0af080d07c56e4f4897c4451089ecd200a22074` | `9b8b0798fd6807fd923107b773ac5a9cfe334e688c6c75d6156a68ff62a78496` |
| `infumap/supply-chain/imports.lock` | `e1bc5bddceb7c063b5a0b64b7141bb882da39a0bc525b16a34a7e4816796ec1f` | `d4a280036f569b72cac8386075fbc1403e851b5b7452d723ec5366e98f46645c` |
| `infusdk/Cargo.toml` | `be8b353903c39f4bf0c508eec878073d8c9903f4fe1cf4b14477f84e770343bd` | `be8b353903c39f4bf0c508eec878073d8c9903f4fe1cf4b14477f84e770343bd` |
| `infusdk/Cargo.lock` | `94e7355a9751118b3704ee03d282b8e32ce892f7c2ab6723a487dbe00f291632` | `bb541d5b8aba9578046853af19a7bb2f5fccc6d0a34535b57cf2dc4e02290242` |
| `infusdk/supply-chain/config.toml` | `23cf46dbdba4753a299028944a53362919f694adcb8eda2dd3364a9a01830272` | `23cf46dbdba4753a299028944a53362919f694adcb8eda2dd3364a9a01830272` |
| `infusdk/supply-chain/audits.toml` | `23e0f7b464aa6796f4b96a572e83dfc39c1befb33347e7ac0411a10a7afe9341` | `7b01a06165c6d5d8ffd9fe7b0e80300b5f79a51eda3295be0279d393d720da5e` |
| `infusdk/supply-chain/imports.lock` | `59bab5eda0bdf2d9ac51be85619b279a737a1e93c08fc04add9f539af8c06d74` | `8f996d1166ba11858bbe191ef219d90ae3e25da79b2b3985d390491c3b964d03` |
| `trusted-publishers.toml` | `8691690fe672b3e5f7248e6f179bf683d0d5cb5838f3f597dd19c12edfbe630a` | `8691690fe672b3e5f7248e6f179bf683d0d5cb5838f3f597dd19c12edfbe630a` |
| `deny.toml` | `c1e79d119d6144fbaa8490ee7d86eaf0e5a1b423c10094470d2ea27a31968f38` | `c1e79d119d6144fbaa8490ee7d86eaf0e5a1b423c10094470d2ea27a31968f38` |

Feed snapshot hashes are recorded in `dependency-reviews/2026-11-11_trust-options.md`. Machine-readable resolution, metadata, audit and vet results for this task are retained in `/tmp/infumap-downgrade-work/` for the session.
