#!/usr/bin/env python3
"""
Check that all crates.io dependencies in the given Cargo.lock files were
published at least MIN_AGE_DAYS ago. Uses the crates.io HTTP API with
parallel requests.
"""

import json
import sys
import tomllib
import urllib.request
import urllib.error
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone, timedelta
from pathlib import Path

MIN_AGE_DAYS = 7
MAX_WORKERS = 10
REQUEST_TIMEOUT = 15
# crates.io requires a descriptive User-Agent for automated requests.
USER_AGENT = "infumap/audit (supply-chain age check; https://github.com/infumap/infumap)"
CRATES_IO_API = "https://crates.io/api/v1/crates"


def fetch_published_date(
    name: str, version: str
) -> tuple[str, str, datetime | None, str | None]:
    url = f"{CRATES_IO_API}/{name}/{version}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            data = json.loads(resp.read())
            created_at = data["version"]["created_at"]
            dt = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
            return name, version, dt, None
    except urllib.error.HTTPError as e:
        return name, version, None, f"HTTP {e.code}"
    except Exception as e:
        return name, version, None, str(e)


def load_crates(lock_path: Path) -> set[tuple[str, str]]:
    with open(lock_path, "rb") as f:
        lock = tomllib.load(f)
    result = set()
    for pkg in lock.get("package", []):
        source = pkg.get("source", "")
        if "crates.io" not in source:
            continue  # skip local workspace members and git deps
        result.add((pkg["name"], pkg["version"]))
    return result


def print_error_summary(errors: list[tuple[str, str, str]]) -> None:
    error_counts = Counter(err for _, _, err in errors)

    if len(error_counts) == 1 and len(errors) > 10:
        err, count = error_counts.most_common(1)[0]
        samples = ", ".join(
            f"{name} {version}" for name, version, _ in sorted(errors)[:5]
        )
        print(
            f"\nWarning: could not fetch publish dates for {count} crate(s)"
            f" because crates.io was unreachable: {err}"
        )
        print(f"Sample affected crates: {samples}")
        return

    print(f"\nWarning: could not fetch publish date for {len(errors)} crate(s):")
    for name, version, err in sorted(errors):
        print(f"  {name} {version}: {err}")


def main() -> int:
    lock_paths = [Path(p) for p in sys.argv[1:]]
    if not lock_paths:
        print(
            "Usage: check-crate-ages.py <Cargo.lock> [<Cargo.lock> ...]",
            file=sys.stderr,
        )
        return 1

    crates: set[tuple[str, str]] = set()
    for path in lock_paths:
        if not path.exists():
            print(f"Error: {path} not found", file=sys.stderr)
            return 1
        found = load_crates(path)
        crates |= found

    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=MIN_AGE_DAYS)

    print(
        f"Checking publish dates for {len(crates)} crates"
        f" ({MAX_WORKERS} parallel requests, min age: {MIN_AGE_DAYS} days)..."
    )

    too_new: list[tuple[str, str, datetime, int]] = []
    errors: list[tuple[str, str, str]] = []

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = {
            executor.submit(fetch_published_date, name, ver): (name, ver)
            for name, ver in crates
        }
        for future in as_completed(futures):
            name, version, dt, err = future.result()
            if err:
                errors.append((name, version, err))
            elif dt is not None and dt > cutoff:
                age_days = (now - dt).days
                too_new.append((name, version, dt, age_days))

    if errors:
        print_error_summary(errors)

    if too_new:
        too_new.sort(key=lambda x: x[3])  # sort by age ascending (newest first)
        print(
            f"\nFound {len(too_new)} crate(s) published within the last {MIN_AGE_DAYS} days:"
        )
        for name, version, dt, age_days in too_new:
            age_str = "today" if age_days == 0 else f"{age_days} day(s) ago"
            print(f"  {name} {version}: published {age_str} ({dt.strftime('%Y-%m-%d')})")
        print()
        print(
            f"Recently published crates may not have had time for the community to"
            f" identify issues."
        )
        print(
            f"Review the crates above. If they are expected upgrades, re-run"
            f" ./audit.sh once {MIN_AGE_DAYS} days have passed."
        )
        return 1

    if errors:
        print(f"\nAge check complete ({len(errors)} crate(s) could not be verified).")
    else:
        print(f"All {len(crates)} crates are at least {MIN_AGE_DAYS} days old.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
