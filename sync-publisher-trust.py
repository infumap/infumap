#!/usr/bin/env python3
"""Generate cargo-vet trust records from the shared publisher policy (Python 3.11+)."""

import argparse
import json
import re
import sys
import tempfile
import tomllib
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent
PROJECTS = (ROOT / "infumap", ROOT / "infusdk")
POLICY = ROOT / "trusted-publishers.toml"
CRATES_IO_SOURCES = {
    "registry+https://github.com/rust-lang/crates.io-index",
    "sparse+https://index.crates.io/",
}
USER_AGENT = "infumap/audit (publisher trust; https://github.com/infumap/infumap)"


def read_toml(path: Path) -> dict:
    return tomllib.loads(path.read_text(encoding="utf-8"))


def parse_date(value) -> date:
    if type(value) is date:
        return value
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ValueError(f"Expected YYYY-MM-DD date, got {value!r}")
    return date.fromisoformat(value)


def load_policy(text: str | None = None) -> dict[int, dict]:
    data = read_toml(POLICY) if text is None else tomllib.loads(text)
    if (not data or set(data) - {"publishers", "inherit"}
            or not isinstance(data.get("publishers", []), list)):
        raise ValueError(f"{POLICY}: expected [inherit] and/or [[publishers]] entries")
    inheritance_policy(data)
    publishers = {}
    for entry in data.get("publishers", []):
        required = {"user-id", "name", "criteria", "start", "end", "notes"}
        if not isinstance(entry, dict) or set(entry) != required:
            raise ValueError(f"Each publisher must contain exactly {sorted(required)}")
        user_id = entry["user-id"]
        if type(user_id) is not int or user_id <= 0 or user_id in publishers:
            raise ValueError(f"Invalid or duplicate crates.io user-id: {user_id!r}")
        if any(not isinstance(entry[key], str) or not entry[key].strip()
               for key in ("name", "notes")):
            raise ValueError(f"Publisher {user_id}: name and notes must be nonempty strings")
        criteria = entry["criteria"]
        if isinstance(criteria, str):
            criteria = [criteria]
        if (not isinstance(criteria, list) or not criteria
                or any(c not in ("safe-to-run", "safe-to-deploy") for c in criteria)):
            raise ValueError(f"Publisher {user_id}: use safe-to-run and/or safe-to-deploy criteria")
        start, end = parse_date(entry["start"]), parse_date(entry["end"])
        if start >= end:
            raise ValueError(f"Publisher {user_id}: start must precede end")
        publishers[user_id] = dict(entry, criteria=criteria, start=start, end=end)
    return publishers


def inheritance_policy(data: dict) -> tuple[list[str], date | None]:
    if "inherit" not in data:
        return [], None
    policy = data["inherit"]
    if not isinstance(policy, dict) or set(policy) != {"sources", "end"}:
        raise ValueError("[inherit] requires sources and an explicit end date")
    sources = policy["sources"]
    if (not isinstance(sources, list)
            or any(not isinstance(name, str) or not name.strip() for name in sources)
            or len(set(sources)) != len(sources)):
        raise ValueError("inherit.sources must be a list of unique audit source names")
    return sources, parse_date(policy["end"])


def download(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=15) as response:
        return response.read()


def endorsement_sources(selected: list[str] | None = None) -> list[tuple[str, str, dict]]:
    imports = [read_toml(project / "supply-chain/config.toml").get("imports", {})
               for project in PROJECTS]
    # The allowlist applies to both projects, so use sources configured in both.
    shared = set.intersection(*(set(config) for config in imports))
    if selected is not None:
        unknown = set(selected) - shared
        if unknown:
            raise ValueError(f"Audit sources not configured in both projects: {', '.join(sorted(unknown))}")
        shared = set(selected)
    sources = []
    for name in sorted(shared):
        urls = {config[name]["url"] for config in imports}
        if len(urls) != 1:
            raise ValueError(f"Audit source {name!r} has different URLs in the two projects")
        url = urls.pop()
        sources.append((name, url))
    if not sources:
        raise ValueError("No audit sources are configured in both projects")

    def fetch(source):
        name, url = source
        try:
            return name, url, tomllib.loads(download(url).decode("utf-8"))
        except (OSError, ValueError) as error:
            raise ValueError(f"Could not read {name}'s audit feed: {error}") from error

    with ThreadPoolExecutor(max_workers=4) as executor:
        return list(executor.map(fetch, sources))


def inherit_publishers(text: str, publishers: dict[int, dict]) -> dict[int, dict]:
    selected, end = inheritance_policy(tomllib.loads(text))
    if not selected:
        return publishers
    inherited = {}
    for name, url, audits in endorsement_sources(selected):
        count = 0
        for records in audits.get("trusted", {}).values():
            for record in records:
                user_id = record.get("user-id")
                if type(user_id) is not int or user_id <= 0:
                    continue  # This policy matches crates.io accounts, not CI publisher signatures.
                criteria = record.get("criteria", [])
                if isinstance(criteria, str):
                    criteria = [criteria]
                if not any(c in ("safe-to-run", "safe-to-deploy") for c in criteria):
                    continue
                start = parse_date(record["start"])
                if start >= parse_date(record["end"]) or start >= end:
                    continue
                # Selecting a source delegates publisher selection, not just its
                # per-crate reviews. Old upstream end dates do not renew or shorten
                # our explicitly saved publication cutoff. Never persist inherited
                # accounts as manual entries: upstream removals must take effect.
                entry = inherited.setdefault(user_id, {"start": start, "sources": set()})
                entry["start"] = min(entry["start"], start)
                entry["sources"].add(f"{name} ({url})")
                count += 1
        print(f"{name}: loaded {count} publisher-trust endorsements", flush=True)
    result = dict(publishers)
    for user_id, entry in sorted(inherited.items()):
        if user_id in result:
            continue  # Explicit account decisions retain their dates and criteria.
        result[user_id] = {
            "user-id": user_id,
            "name": f"crates.io account {user_id}",
            "criteria": ["safe-to-run"],
            "start": entry["start"],
            "end": end,
            "notes": "Automatically inherited publisher-wide from "
                     + ", ".join(sorted(entry["sources"]))
                     + "; no independent source review.",
        }
    print(f"Inherited {len(inherited)} publisher accounts; "
          f"{len(result)} accounts including explicit selections. End: {end} (exclusive).", flush=True)
    return result


def add_publishers(logins: list[str], end: date | None) -> tuple[str, dict[int, dict]]:
    text = POLICY.read_text(encoding="utf-8")
    publishers = load_policy(text)
    sources = None
    today = datetime.now(timezone.utc).date()
    end = end or today + timedelta(days=365)
    if end > today + timedelta(days=365):
        raise ValueError("--end must be at most 365 days from today")
    for login in dict.fromkeys(logins):
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", login):
            raise ValueError(f"Use a crates.io account login, such as BurntSushi, not {login!r}")
        try:
            user = json.loads(download(f"https://crates.io/api/v1/users/{quote(login, safe='')}"))["user"]
        except urllib.error.HTTPError as error:
            if error.code == 404:
                source_names = {
                    name.casefold()
                    for project in PROJECTS
                    for name in read_toml(project / "supply-chain/config.toml").get("imports", {})
                }
                reason = (f"{login!r} is a configured audit source, not a crates.io account"
                          if login.casefold() in source_names
                          else f"No crates.io account was found for {login!r}")
                raise ValueError(
                    f"{reason}. --trust needs the publisher login in cargo-vet's suggestion. "
                    "To automatically trust a source's publishers, add its name to "
                    "[inherit] sources in trusted-publishers.toml, then run this script without --trust."
                ) from error
            raise ValueError(f"Could not resolve crates.io account {login!r}: {error}") from error
        except (OSError, ValueError, KeyError, TypeError) as error:
            raise ValueError(f"Could not resolve crates.io account {login!r}: {error}") from error
        if (not isinstance(user, dict) or type(user.get("id")) is not int or user["id"] <= 0
                or not isinstance(user.get("login"), str)
                or user["login"].casefold() != login.casefold()):
            raise ValueError(f"crates.io did not return a matching account for {login!r}")
        user_id = user["id"]
        if user_id in publishers:
            existing = publishers[user_id]
            print(f"{login} ({user_id}) is already listed; keeping dates "
                  f"{existing['start']} to {existing['end']} and existing criteria.", flush=True)
            continue
        if sources is None:
            sources = endorsement_sources()
        endorsements = []
        for name, url, audits in sources:
            for records in audits.get("trusted", {}).values():
                for record in records:
                    criteria = record.get("criteria", [])
                    if isinstance(criteria, str):
                        criteria = [criteria]
                    if (record.get("user-id") == user_id
                            and any(c in ("safe-to-run", "safe-to-deploy") for c in criteria)):
                        start = parse_date(record["start"])
                        if start < parse_date(record["end"]):
                            endorsements.append((name, url, start))
        if not endorsements:
            raise ValueError(f"No shared audit source has safe-to-run/safe-to-deploy publisher "
                             f"trust for {login} ({user_id}); allowlist unchanged")
        start = min(entry[2] for entry in endorsements)
        if start >= end:
            raise ValueError(f"{login}: end {end} must follow endorsement start {start}")
        names = ", ".join(sorted({entry[0] for entry in endorsements}))
        urls = ", ".join(sorted({entry[1] for entry in endorsements}))
        display_name = f"{user['name']} ({user['login']})" if user.get("name") else user["login"]
        # cargo-vet's suggestions cite per-crate endorsements, sometimes with old
        # end dates. Choosing --trust is our own publisher-wide decision, not a
        # copy of their scope or an assertion that their endorsements are current.
        # Save the new end once; ordinary audits and repeated --trust never renew it.
        notes = (f"Selected via --trust {user['login']} on {today} based on publisher-trust "
                 f"records from {names}. Applied publisher-wide as our own trust decision; "
                 f"no independent source review. Sources: {urls}")
        block = (
            f"\n[[publishers]]\nuser-id = {user_id}\n"
            f"name = {json.dumps(display_name, ensure_ascii=False)}\n"
            f"criteria = \"safe-to-run\"\nstart = \"{start}\"\nend = \"{end}\"\n"
            f"notes = {json.dumps(notes, ensure_ascii=False)}\n"
        )
        # An empty allowlist is represented as publishers = []; replace that root
        # assignment before adding array-of-table entries, retaining its comments.
        if not publishers and "publishers" in tomllib.loads(text):
            # Keep [inherit] and its date limit when adding the first manual account.
            replacement = re.sub(r"(?m)^publishers\s*=\s*\[\s*\]\s*(?:#[^\n]*)?", "", text)
            expected = dict(tomllib.loads(text))
            del expected["publishers"]
            if tomllib.loads(replacement) != expected:
                raise ValueError("Cannot replace empty publishers list; use publishers = [] on one line")
            text = replacement
        text = text.rstrip() + "\n" + block
        publishers = load_policy(text)
        print(f"Add {display_name} (crates.io ID {user_id}); endorsed by {names}.\n"
              f"  safe-to-run, UTC publication dates [{start}, {end}).", flush=True)
    return text, publishers


def locked_crates(project: Path) -> set[tuple[str, str]]:
    return {
        (package["name"], package["version"])
        for package in read_toml(project / "Cargo.lock")["package"]
        if package.get("source") in CRATES_IO_SOURCES
    }


def audit_versions(project: Path, dependencies: set[tuple[str, str]]) -> set[tuple[str, str]]:
    """Include published audit bases connected to locked releases by existing deltas."""
    store = project / "supply-chain"
    audit_sets = [read_toml(store / "audits.toml")]
    imports = store / "imports.lock"
    if imports.exists():
        audit_sets.extend(read_toml(imports).get("audits", {}).values())
    names = {name for name, _ in dependencies}
    predecessors = {}
    published_version = r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?"
    for audits in audit_sets:
        for name, records in audits.get("audits", {}).items():
            if name not in names:
                continue
            for record in records:
                criteria = record.get("criteria", [])
                if isinstance(criteria, str):
                    criteria = [criteria]
                if not any(c in ("safe-to-run", "safe-to-deploy") for c in criteria):
                    continue
                delta = record.get("delta")
                if delta is None:
                    continue
                old, new = (version.strip() for version in delta.split("->"))
                # Git audit versions are not published crates.io releases.
                if not all(re.fullmatch(published_version, version) for version in (old, new)):
                    continue
                predecessors.setdefault((name, new), set()).add((name, old))

    # Walk backward through whole delta chains, not just the last update. A
    # trusted old publisher can anchor reviews of later releases by other users
    # or CI, without adding those publishers or changing the locked versions.
    versions = set(dependencies)
    pending = list(dependencies)
    while pending:
        for predecessor in predecessors.get(pending.pop(), ()):
            if predecessor not in versions:
                versions.add(predecessor)
                pending.append(predecessor)
    return versions


def fetch_publisher(crate: tuple[str, str]) -> tuple[int | None, date | None, str | None]:
    """Raise on lookup errors; allow fetched releases without a numeric publisher."""
    name, version = crate
    url = f"https://crates.io/api/v1/crates/{quote(name, safe='')}/{quote(version, safe='')}"
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            release = json.load(response)["version"]
        if release["crate"] != name or release["num"] != version:
            raise ValueError("registry response does not match the locked crate/version")
        published = datetime.fromisoformat(release["created_at"].replace("Z", "+00:00"))
        if published.tzinfo is None:
            raise ValueError("publication timestamp has no timezone")
        # Current owners and historical publisher lists cannot establish who published
        # this version. In particular, cargo vet trust --all skips mixed publishers.
        publisher = release.get("published_by")
        if not isinstance(publisher, dict) or type(publisher.get("id")) is not int:
            return None, None, "missing crates.io publisher account ID"
        return publisher["id"], published.astimezone(timezone.utc).date(), None
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        raise ValueError(f"Could not look up publisher for {name} {version}: {error}") from error


def without_trust(text: str) -> str:
    """Preserve other TOML sections verbatim, including source reviews and criteria."""
    original = tomllib.loads(text)
    headers = []
    for match in re.finditer(r"(?m)^[ \t]*\[.*$", text):
        # A line resembling a header can be inside multiline review notes or an
        # array. Only a complete, parseable prefix establishes a table boundary.
        try:
            tomllib.loads(text[:match.start()])
        except tomllib.TOMLDecodeError:
            continue
        headers.append(match)
    chunks = []
    previous = 0
    for index, header in enumerate(headers):
        end = headers[index + 1].start() if index + 1 < len(headers) else len(text)
        if re.match(r"\[\[?\s*trusted\s*(?:\.|\])", header.group().lstrip()):
            chunks.append(text[previous:header.start()])
            previous = end
    chunks.append(text[previous:])
    preserved = "".join(chunks)
    # Refuse unusual layouts (e.g. quoted/dotted trust keys) instead of risking
    # deletion of a source review or silently retaining revoked publisher trust.
    expected = {key: value for key, value in original.items() if key != "trusted"}
    if tomllib.loads(preserved) != expected:
        raise ValueError("Cannot safely replace trusted tables; run cargo vet fmt first")
    return preserved.rstrip() + "\n"


def render_trust(base: str, entries: dict[str, list[dict]]) -> str:
    text = base
    for name, publishers in sorted(entries.items()):
        for publisher in sorted(publishers, key=lambda p: p["user-id"]):
            notes = ("Generated from trusted-publishers.toml by sync-publisher-trust.py. "
                     f"{publisher['name']}: {publisher['notes']}")
            text += (
                f"\n[[trusted.{json.dumps(name)}]]\n"
                f"criteria = {json.dumps(publisher['criteria'])}\n"
                f"user-id = {publisher['user-id']}\n"
                f"start = \"{publisher['start'].isoformat()}\"\n"
                f"end = \"{publisher['end'].isoformat()}\"\n"
                f"notes = {json.dumps(notes, ensure_ascii=False)}\n"
            )
    tomllib.loads(text)
    return text


def render_project_trust(
    base: str,
    dependencies: set[tuple[str, str]],
    versions: set[tuple[str, str]],
    publishers: dict[int, dict],
    metadata: dict,
) -> tuple[str, int]:
    if not publishers:
        return render_trust(base, {}), 0
    entries = {}
    matched = set()
    historical_bases = {}
    for name, version in sorted(versions):
        user_id, published, _ = metadata[(name, version)]
        policy = publishers.get(user_id)
        # A release without a numeric publisher cannot match numeric cargo-vet
        # trust. It must not suppress a verified sibling or historical base that
        # can connect to it through accepted deltas; CI itself remains untrusted.
        # cargo-vet 0.10.3 uses UTC dates with an exclusive end bound.
        if policy and published is not None and policy["start"] <= published < policy["end"]:
            key = (name, user_id)
            if key not in matched:
                entries.setdefault(name, []).append(dict(policy))
                matched.add(key)
            if (name, version) not in dependencies:
                historical_bases.setdefault(key, []).append(version)
    for name, records in entries.items():
        for record in records:
            bases = historical_bases.get((name, record["user-id"]))
            if bases:
                record["notes"] += (
                    " Verified audit-base releases for this crate: " + ", ".join(bases)
                    + ". Existing delta audits determine coverage of the locked releases."
                )
    return render_trust(base, entries), len(matched)


def write_atomic(path: Path, text: str) -> None:
    if path.read_text(encoding="utf-8") == text:
        return
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         delete=False) as output:
            temporary = Path(output.name)
            output.write(text)
        temporary.chmod(path.stat().st_mode & 0o777)
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__,
        epilog='For automatic source trust, set [inherit] sources = ["mozilla"] in '
               'trusted-publishers.toml. Run without options to sync, or with --dry-run to preview.',
    )
    parser.add_argument("--trust", metavar="LOGIN", nargs="+", action="extend", default=[],
                        help="add publisher logins (e.g. BurntSushi, not the audit source mozilla), then sync")
    parser.add_argument("--end", type=parse_date, metavar="YYYY-MM-DD",
                        help="publication end date for NEW publishers (exclusive; default: today + 365 days)")
    parser.add_argument("--dry-run", action="store_true",
                        help="show selected/inherited publishers without changing files or syncing")
    args = parser.parse_args()
    if args.end and not args.trust:
        parser.error("--end requires --trust; edit inherit.end for inherited publishers")
    policy_text = None
    if args.trust:
        policy_text, publishers = add_publishers(args.trust, args.end)
    else:
        publishers = load_policy()
    publishers = inherit_publishers(
        policy_text if policy_text is not None else POLICY.read_text(encoding="utf-8"), publishers)
    if args.dry_run:
        for user_id, entry in sorted(publishers.items()):
            print(f"  {user_id}: {entry['name']}; {entry['criteria']}; "
                  f"[{entry['start']}, {entry['end']})")
        print("Preview only; no files changed.")
        return 0
    projects = {project: locked_crates(project) for project in PROJECTS}
    # Validate both stores before looking up releases or writing any policy changes.
    bases = {project: without_trust((project / "supply-chain/audits.toml").read_text(
        encoding="utf-8")) for project in projects}
    versions = {project: audit_versions(project, dependencies) if publishers else dependencies
                for project, dependencies in projects.items()}
    crates = sorted(set().union(*versions.values())) if publishers else []
    print(f"Looking up publishers for {len(crates)} locked and audit-base crates.io versions...", flush=True)
    metadata = {}
    with ThreadPoolExecutor(max_workers=4) as executor:
        pending = {executor.submit(fetch_publisher, crate): crate for crate in crates}
        try:
            for future in as_completed(pending):
                metadata[pending[future]] = future.result()
                if len(metadata) % 100 == 0:
                    print(f"  Looked up {len(metadata)}/{len(crates)} versions", flush=True)
        except Exception:
            # Rate limits previously turned failed lookups into an empty trust
            # snapshot. Cancel queued requests and abort before any policy or
            # audit files are written; partial registry data cannot replace trust.
            for future in pending:
                future.cancel()
            raise
    for (name, version), (_, _, error) in sorted(metadata.items()):
        if error:
            print(f"Warning: {name} {version}: {error}; no trust from this release", file=sys.stderr)

    updates = {}
    for project, dependencies in projects.items():
        text, count = render_project_trust(
            bases[project], dependencies, versions[project], publishers, metadata)
        updates[project / "supply-chain/audits.toml"] = text
        print(f"{project.name}: {count} per-crate publisher trust records")
    # Rebuild, don't append: removing an account or narrowing its dates/criteria
    # must revoke the generated policy on the very next audit invocation.
    if policy_text is not None:
        write_atomic(POLICY, policy_text)
    for path, text in updates.items():
        write_atomic(path, text)
    if policy_text is not None:
        print("Publisher selection saved and synchronized. Rerun ./audit-rust.sh for remaining gaps.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)
