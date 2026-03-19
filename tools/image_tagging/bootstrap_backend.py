from __future__ import annotations

import argparse
import ast
import importlib.util
import re
import shlex
import subprocess
import sys
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

BASE_REQUIREMENTS = [
    "torch",
    "torchvision",
    "fastapi",
    "uvicorn",
    "python-multipart",
    "Pillow",
]
DEFAULT_TRANSFORMERS_VERSION = ""
QWEN_BACKEND_SPECS = {"qwen35", "qwen35-35b"}
DEFAULT_FLORENCE_TRANSFORMERS_VERSION = "4.49.0"
DEFAULT_QWEN_TRANSFORMERS_VERSION = "5.3.0"


def resolve_backend_file_path(path_text: str) -> Path:
    path = Path(path_text).expanduser()
    if path.is_absolute():
        return path
    return (Path(__file__).resolve().parent / path).resolve()


def parse_literal_pip_requirements(source_path: Path) -> list[str]:
    module = ast.parse(source_path.read_text(encoding="utf-8"), filename=str(source_path))
    for node in module.body:
        value = None
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == "PIP_REQUIREMENTS":
                    value = node.value
                    break
        elif isinstance(node, ast.AnnAssign):
            if isinstance(node.target, ast.Name) and node.target.id == "PIP_REQUIREMENTS":
                value = node.value

        if value is None:
            continue

        parsed = ast.literal_eval(value)
        if not isinstance(parsed, (list, tuple)) or not all(isinstance(item, str) for item in parsed):
            raise ValueError(f"{source_path}: PIP_REQUIREMENTS must be a literal list of strings.")
        return list(parsed)
    return []


def resolve_module_source_path(module_name: str) -> Path | None:
    spec = importlib.util.find_spec(module_name)
    if spec is None or spec.origin is None:
        return None
    origin = Path(spec.origin)
    if origin.is_file():
        return origin
    return None


def resolve_backend_specific_requirements(backend_spec: str, transformers_version: str) -> list[str]:
    if backend_spec == "florence":
        resolved_version = transformers_version or DEFAULT_FLORENCE_TRANSFORMERS_VERSION
        return [
            f"transformers=={resolved_version}",
            "timm",
            "einops",
        ]

    if backend_spec in QWEN_BACKEND_SPECS:
        resolved_version = transformers_version or DEFAULT_QWEN_TRANSFORMERS_VERSION
        return [
            f"transformers=={resolved_version}",
            "accelerate",
            "bitsandbytes",
        ]

    if backend_spec.startswith("file:"):
        source_path = resolve_backend_file_path(backend_spec[len("file:") :])
        return parse_literal_pip_requirements(source_path)

    if backend_spec.startswith("module:"):
        source_path = resolve_module_source_path(backend_spec[len("module:") :])
        if source_path is None:
            raise ValueError(
                f"Could not resolve module backend '{backend_spec}'. "
                "Use IMAGE_TAGGING_EXTRA_PIP_PACKAGES or a file: backend if bootstrap-time dependency discovery is needed."
            )
        return parse_literal_pip_requirements(source_path)

    raise ValueError(
        "Unsupported IMAGE_TAGGING_BACKEND value. Use 'qwen35-35b', 'qwen35', 'florence', 'module:<python.import.path>', or 'file:<path.py>'."
    )


def resolve_all_requirements(backend_spec: str, transformers_version: str, extra_packages: str) -> list[str]:
    requirements = list(BASE_REQUIREMENTS)
    requirements.extend(resolve_backend_specific_requirements(backend_spec, transformers_version))
    requirements.extend(shlex.split(extra_packages))

    seen: set[str] = set()
    deduped: list[str] = []
    for requirement in requirements:
        normalized = requirement.strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        deduped.append(normalized)
    return deduped


def parse_requirement(requirement: str) -> tuple[str, str | None] | None:
    match = re.fullmatch(r"\s*([A-Za-z0-9_.-]+)(?:\[[^\]]+\])?(?:==([^;]+))?\s*", requirement)
    if match is None:
        return None
    return match.group(1), match.group(2)


def requirement_is_satisfied(requirement: str) -> bool:
    parsed = parse_requirement(requirement)
    if parsed is None:
        return False

    package_name, exact_version = parsed
    try:
        installed_version = version(package_name)
    except PackageNotFoundError:
        return False
    return exact_version is None or installed_version == exact_version


def sync_requirements(backend_spec: str, transformers_version: str, extra_packages: str) -> int:
    requirements = resolve_all_requirements(backend_spec, transformers_version, extra_packages)
    unsatisfied = [requirement for requirement in requirements if not requirement_is_satisfied(requirement)]

    if not unsatisfied:
        print(f"Image tagging backend requirements already satisfied for backend '{backend_spec}'.")
        return 0

    print(f"Installing image tagging backend requirements for backend '{backend_spec}':")
    for requirement in requirements:
        marker = "*" if requirement in unsatisfied else "-"
        print(f"  {marker} {requirement}")

    subprocess.check_call([sys.executable, "-m", "pip", "install", "--upgrade", *requirements])
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Resolve and install image-tagging backend requirements.")
    parser.add_argument("--backend", required=True)
    parser.add_argument("--transformers-version", default=DEFAULT_TRANSFORMERS_VERSION)
    parser.add_argument("--extra-packages", default="")
    parser.add_argument(
        "--mode",
        choices=["sync", "list"],
        default="sync",
        help="sync installs missing requirements; list prints the resolved requirements.",
    )
    args = parser.parse_args()

    if args.mode == "list":
        for requirement in resolve_all_requirements(args.backend, args.transformers_version, args.extra_packages):
            print(requirement)
        return 0

    return sync_requirements(args.backend, args.transformers_version, args.extra_packages)


if __name__ == "__main__":
    raise SystemExit(main())
