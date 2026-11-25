"""Check index contents, not working copies, before publishing them."""

import argparse
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--all-tracked", action="store_true", help="Scan the checked-out Git tree for CI")
    parser.add_argument("--paths-only", action="store_true", help="Check local-file rules without running Gitleaks")
    args = parser.parse_args()
    os.chdir(subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip())
    command = ["git", "ls-files", "-z"] if args.all_tracked else [
        "git", "diff", "--cached", "--name-only", "--diff-filter=ACMRT", "-z"
    ]
    paths = [os.fsdecode(value) for value in subprocess.check_output(command).split(b"\0") if value]
    if not paths:
        print("Commit safety: no files to scan.")
        return 0

    blocked = []
    with tempfile.TemporaryDirectory(prefix="atlas-commit-scan-") as directory:
        for name in paths:
            path = PurePosixPath(name)
            content = subprocess.check_output(["git", "show", f":{name}"])
            reason = local_file_reason(path)
            if content.startswith(b"SQLite format 3\0"):
                reason = "SQLite database contents"
            if reason:
                blocked.append(f"  {name!r}: {reason}")
                continue
            if not args.paths_only:
                target = Path(directory, *path.parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)

        if blocked:
            print("Commit safety blocked local files:\n" + "\n".join(blocked), file=sys.stderr)
            print("Unstage them and keep them outside source control. No files were changed.", file=sys.stderr)
            return 1
        if args.paths_only:
            print(f"Commit safety: {len(paths)} paths passed (secrets not scanned).")
            return 0
        if not shutil.which("gitleaks"):
            print("Commit blocked: install Gitleaks first (macOS: brew install gitleaks).", file=sys.stderr)
            return 1

        # Export only indexed blobs: unstaged edits cannot conceal staged secrets.
        # Redaction prevents a rejected key from being echoed into terminal/CI logs.
        return subprocess.run([
            "gitleaks", "dir", "--redact", "--no-banner", "--no-color",
            "--ignore-gitleaks-allow", directory,
        ]).returncode


def local_file_reason(path):
    name = path.name.lower()
    if name.startswith(".env") and (name == ".env" or name.startswith(".env.")):
        if name.rsplit(".", 1)[-1] not in {"example", "sample", "template"}:
            return "environment secrets"
    if any(part in {".atlas", ".local", ".aws", ".ssh", "local-projects", "tmp", "node_modules"} for part in path.parts):
        return "local runtime, credentials, or project directory"
    if re.search(r"\.(?:db|sqlite|sqlite3)(?:-.*)?$", name):
        return "local database or sidecar"
    if path.suffix.lower() in {".pem", ".key", ".p12", ".pfx"}:
        return "key or certificate bundle"
    if name in {"auth.json", "credentials.json", "service-local.json"}:
        return "local credentials or service state"
    return None


if __name__ == "__main__":
    sys.exit(main())
