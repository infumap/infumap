#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import shlex
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Resolve a shared GPU model alias.")
    parser.add_argument("--registry", required=True, help="Path to tools/gpu/model_aliases.json")
    parser.add_argument("--tool", required=True, help="Tool key, for example image_tagging")
    parser.add_argument("--alias", help="Short model alias to resolve. Defaults to the tool's configured default alias.")
    return parser.parse_args()


def fail(message: str) -> int:
    print(message, file=sys.stderr)
    return 1


def main() -> int:
    args = parse_args()
    registry_path = Path(args.registry)
    if not registry_path.is_file():
        return fail(f"Alias registry file not found: {registry_path}")

    try:
        registry = json.loads(registry_path.read_text(encoding="utf-8"))
    except Exception as exc:
        return fail(f"Could not read alias registry {registry_path}: {exc}")

    aliases = registry.get("aliases")
    if not isinstance(aliases, dict):
        return fail(f"Registry {registry_path} is missing a top-level 'aliases' object")

    tools = registry.get("tools")
    if not isinstance(tools, dict):
        return fail(f"Registry {registry_path} is missing a top-level 'tools' object")

    tool_config = tools.get(args.tool)
    if not isinstance(tool_config, dict):
        return fail(f"Tool {args.tool!r} is not defined in {registry_path}")

    default_alias = tool_config.get("default_alias")
    if not isinstance(default_alias, str) or not default_alias.strip():
        return fail(f"Tool {args.tool!r} is missing a valid default_alias in {registry_path}")

    alias = args.alias.strip() if isinstance(args.alias, str) and args.alias.strip() else default_alias

    allowed_aliases = tool_config.get("allowed_aliases")
    if allowed_aliases is not None:
        if not isinstance(allowed_aliases, list) or not all(isinstance(value, str) for value in allowed_aliases):
            return fail(f"Tool {args.tool!r} has an invalid allowed_aliases list in {registry_path}")
        if alias not in allowed_aliases:
            supported = ", ".join(sorted(allowed_aliases)) or "<none>"
            return fail(f"Unsupported alias {alias!r} for tool {args.tool!r}. Supported aliases: {supported}")

    resolved = aliases.get(alias)
    if not isinstance(resolved, dict):
        supported = ", ".join(sorted(aliases)) or "<none>"
        return fail(f"Alias {alias!r} is not defined in {registry_path}. Known aliases: {supported}")

    print(f"RESOLVED_ALIAS={shlex.quote(alias)}")
    print(f"RESOLVED_TOOL={shlex.quote(args.tool)}")
    print(f"RESOLVED_DEFAULT_ALIAS={shlex.quote(default_alias)}")
    for key, value in resolved.items():
        env_key = f"RESOLVED_{key.upper()}"
        if isinstance(value, list):
            rendered_value = ",".join(str(item) for item in value)
        else:
            rendered_value = str(value)
        print(f"{env_key}={shlex.quote(rendered_value)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
