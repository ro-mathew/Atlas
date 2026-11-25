# Commit safety

Install Python 3 and Gitleaks (`brew install gitleaks` on macOS), then run
`bun run prepare` to activate the repository's Husky hooks. The pre-commit hook
blocks commits if the scanner is missing or a check fails.

The guard checks the exact staged contents, including partially staged files.
It blocks environment files, credentials, private-key bundles, local project
directories, database files and SQLite contents even when renamed. It then
scans all staged file contents with Gitleaks, with secrets redacted from output.
It does not modify or unstage files.

Keep local projects under `local-projects/`, runtime data under `tmp/`, and
machine-specific Atlas files under `.atlas/` or `.local/`. These are ignored and
blocked even if force-added. Environment examples ending in `.example`,
`.sample`, or `.template` are allowed, but must contain placeholders only.

Run `python3 script/check-commit-safety.py` before committing or add
`--all-tracked` to scan the full index. `--paths-only` checks filenames and SQLite
headers without scanning for secrets; it is a diagnostic mode, not the hook.

The Commit safety workflow repeats the full-tree check on pull requests and
pushes to `main`. Enable Actions on the fork and make `commit-safety` a required
status check for `main` once its first run succeeds. Hooks can be bypassed;
required CI and GitHub secret push protection provide additional protection.

Ignore rules do not remove files already tracked. This check covers the current
index, not earlier commits or arbitrary personal files with innocuous names.
Never add a real credential to an example or exempt a whole test directory.
Review scanner false positives individually before adding narrow exceptions.
