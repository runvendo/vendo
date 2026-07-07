#!/usr/bin/env python3
"""One-shot normalization of Batch B expected.json labels to the documented
route-scan labeling convention (corpus/expectations/README.md):

- Route-scan-derived tools are always labeled readOrWrite "write", even GET.
- Annotations mirror the fail-closed policy: mutating true for every
  route-scan tool; dangerous for DELETE or destructive-word names;
  idempotent true for PUT/DELETE.

Batch A labels already follow this convention (zero GET-read labels across
all five repos); Batch B labels were written with semantic read/write and
violated the guide. This script re-normalizes them. Tool name/method/path
inventories are left untouched.
"""
import json
import re
import sys
from pathlib import Path

REPOS = ["cal-com", "dub", "formbricks", "inbox-zero", "openstatus", "teable", "vercel-commerce"]

DESTRUCTIVE_WORDS = {
    "delete", "remove", "destroy", "cancel", "close", "reset", "revoke", "purge", "wipe",
    "archive", "unpause", "transfer", "send", "invite",
}


def words(name: str) -> list[str]:
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", name)
    s = re.sub(r"[^A-Za-z0-9]+", "_", s).lower()
    return [w for w in s.split("_") if w]


def dangerous(method: str, name: str) -> bool:
    return method.upper() == "DELETE" or any(w in DESTRUCTIVE_WORDS for w in words(name))


def normalize(repo_dir: Path) -> dict:
    path = repo_dir / "expected.json"
    data = json.loads(path.read_text())
    flips = 0
    for tool in data["tools"]:
        if tool["readOrWrite"] != "write":
            tool["readOrWrite"] = "write"
            flips += 1
    annotations = []
    by_name = {t["name"]: t for t in data["tools"]}
    for tool in data["tools"]:
        ann = {
            "name": tool["name"],
            "mutating": True,
            "dangerous": dangerous(tool["method"], tool["name"]),
        }
        if tool["method"].upper() in ("PUT", "DELETE"):
            ann["idempotent"] = True
        annotations.append(ann)
    data["annotations"] = annotations
    path.write_text(json.dumps(data, indent=2) + "\n")
    return {"repo": repo_dir.name, "flips": flips, "tools": len(data["tools"])}


def main() -> None:
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("corpus/expectations")
    for repo in REPOS:
        print(normalize(root / repo))


if __name__ == "__main__":
    main()
