#!/usr/bin/env python3
"""Release automation helper for AltPan."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST_PATH = ROOT / "manifest.json"
POPUP_HTML_PATH = ROOT / "popup" / "popup.html"

FIELD_SEP = "\x1f"
RECORD_SEP = "\x1e"


def parse_semver(version: str) -> tuple[int, int, int]:
    """Parse a semver string like '1.1.0' or 'v1.1.0' into (major, minor, patch)."""
    cleaned = version.strip().lstrip("v")
    match = re.match(r"^(\d+)\.(\d+)\.(\d+)$", cleaned)
    if not match:
        raise ValueError(f"Invalid semver string: {version!r}")
    return int(match.group(1)), int(match.group(2)), int(match.group(3))


def read_manifest_version(manifest_path: Path = MANIFEST_PATH) -> str:
    """Read the current version string from manifest.json."""
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    return str(data.get("version", "1.0.0")).strip().lstrip("v")


def get_latest_tag(cwd: Path = ROOT) -> tuple[str | None, str]:
    """Return (latest_tag_name, normalized_version), falling back to manifest.json if untagged."""
    try:
        proc = subprocess.run(
            ["git", "tag", "-l"],
            cwd=cwd,
            capture_output=True,
            text=True,
            check=True,
        )
        tags = [t.strip() for t in proc.stdout.splitlines() if t.strip()]
    except Exception:
        tags = []

    parsed_tags: list[tuple[tuple[int, int, int], str, str]] = []
    for tag in tags:
        try:
            semver = parse_semver(tag)
            parsed_tags.append((semver, tag, tag.lstrip("v")))
        except ValueError:
            continue

    if not parsed_tags:
        return None, read_manifest_version(cwd / "manifest.json")

    parsed_tags.sort(key=lambda item: item[0])
    _, tag_name, version = parsed_tags[-1]
    return tag_name, version


def bump_version(current: str, bump_type: str = "patch") -> str:
    """Increment major, minor, or patch component of a semver string."""
    major, minor, patch = parse_semver(current)
    kind = bump_type.strip().lower()
    if kind == "major":
        return f"{major + 1}.0.0"
    if kind == "minor":
        return f"{major}.{minor + 1}.0"
    return f"{major}.{minor}.{patch + 1}"


def get_commits_since(tag: str | None, cwd: Path = ROOT) -> list[dict[str, str]]:
    """Return non-bot commits since tag (or all commits if tag is None)."""
    rev_range = f"{tag}..HEAD" if tag else "HEAD"
    fmt = f"%h{FIELD_SEP}%s{FIELD_SEP}%b{RECORD_SEP}"

    proc = subprocess.run(
        ["git", "log", rev_range, f"--format={fmt}"],
        cwd=cwd,
        capture_output=True,
        text=True,
        check=True,
    )

    commits: list[dict[str, str]] = []
    for raw_record in proc.stdout.split(RECORD_SEP):
        record = raw_record.strip()
        if not record:
            continue
        parts = record.split(FIELD_SEP, 2)
        if len(parts) < 2:
            continue
        short_hash = parts[0].strip()
        subject = parts[1].strip()
        body = parts[2].strip() if len(parts) > 2 else ""

        if "[skip ci]" in subject or subject.lower().startswith("chore(release):"):
            continue

        commits.append({"hash": short_hash, "subject": subject, "body": body})

    return commits


def determine_bump(commits: list[dict[str, str]]) -> str:
    """Determine highest Conventional Commits bump level ('major', 'minor', or 'patch')."""
    bump = "patch"
    breaking_header = re.compile(r"^[a-z]+(\([^)]+\))?!\s*:", re.IGNORECASE)
    feat_header = re.compile(r"^feat(\([^)]+\))?\s*:", re.IGNORECASE)

    for commit in commits:
        subject = commit["subject"]
        body = commit["body"]

        if breaking_header.match(subject) or "BREAKING CHANGE" in body:
            return "major"
        if feat_header.match(subject):
            bump = "minor"

    return bump


def resolve_version(
    event_name: str,
    input_version: str,
    commits: list[dict[str, str]],
    base_version: str,
) -> str:
    """Resolve target release version from dispatch input or Conventional Commits."""
    spec = (input_version or "").strip()
    if event_name == "workflow_dispatch" and spec:
        lower = spec.lower()
        if lower in ("patch", "minor", "major"):
            return bump_version(base_version, lower)
        parse_semver(spec)
        return spec.lstrip("v")

    bump = determine_bump(commits)
    return bump_version(base_version, bump)


def format_release_notes(commits: list[dict[str, str]]) -> str:
    """Format commit messages into markdown release notes."""
    if not commits:
        proc = subprocess.run(
            ["git", "log", "-1", "--format=%h %s"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=True,
        )
        return f"## Changes\n\n- {proc.stdout.strip()}\n"

    lines = ["## Changes", ""]
    for commit in commits:
        lines.append(f"- `{commit['hash']}` {commit['subject']}")
        if commit["body"]:
            for body_line in commit["body"].splitlines():
                stripped = body_line.rstrip()
                if stripped:
                    lines.append(f"  {stripped}")
    return "\n".join(lines) + "\n"


def sync_version(
    new_version: str,
    manifest_path: Path = MANIFEST_PATH,
    popup_html_path: Path = POPUP_HTML_PATH,
) -> list[Path]:
    """Update version strings in manifest.json and popup/popup.html."""
    updated: list[Path] = []

    if manifest_path.is_file():
        original = manifest_path.read_text(encoding="utf-8")
        replaced = re.sub(
            r'("version"\s*:\s*")([^"]*)(")',
            rf"\g<1>{new_version}\g<3>",
            original,
            count=1,
        )
        if replaced != original:
            manifest_path.write_text(replaced, encoding="utf-8")
            updated.append(manifest_path)

    if popup_html_path.is_file():
        original = popup_html_path.read_text(encoding="utf-8")
        replaced = re.sub(
            r'(<span class="version-tag">)([^<]*)(</span>)',
            rf"\g<1>v{new_version}\g<3>",
            original,
            count=1,
        )
        if replaced != original:
            popup_html_path.write_text(replaced, encoding="utf-8")
            updated.append(popup_html_path)

    return updated


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="AltPan release helper")
    subparsers = parser.add_subparsers(dest="command", required=True)

    p_prep = subparsers.add_parser("prepare", help="Resolve version and write release notes")
    p_prep.add_argument("--event", default="push")
    p_prep.add_argument("--input-version", default="")
    p_prep.add_argument("--notes-out", default="release_notes.md")
    p_prep.add_argument("--github-output", default="")

    p_sync = subparsers.add_parser("sync-version", help="Sync version in manifest.json and popup.html")
    p_sync.add_argument("--version", required=True)

    args = parser.parse_args(argv)

    if args.command == "prepare":
        latest_tag, base_version = get_latest_tag()
        commits = get_commits_since(latest_tag)
        new_version = resolve_version(args.event, args.input_version, commits, base_version)
        notes = format_release_notes(commits)

        Path(args.notes_out).write_text(notes, encoding="utf-8")

        if args.github_output:
            with open(args.github_output, "a", encoding="utf-8") as fh:
                fh.write(f"version={new_version}\n")
                fh.write(f"previous_tag={latest_tag or ''}\n")

        print(f"Resolved version: {new_version} (base: {base_version}, prev tag: {latest_tag})")
        return 0

    if args.command == "sync-version":
        parse_semver(args.version)
        updated = sync_version(args.version)
        for path in updated:
            print(f"Updated version in {path}")
        return 0

    return 1


if __name__ == "__main__":
    sys.exit(main())
