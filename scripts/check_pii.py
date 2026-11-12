#!/usr/bin/env python3
"""Scan tracked or staged files for PII and secret-like data.

The checks are deliberately generic so this script never needs to contain the
private values it protects. Add project-specific terms to a *private* denylist
(one case-insensitive literal per line):

    PII_DENYLIST=/path/to/private-denylist.txt scripts/check-pii.sh
    # or ~/.config/potaeto-pii-denylist.txt
    # or .pii-denylist (gitignored)

Never commit the denylist. The scanner prints only the file, line, and category
so findings do not copy the sensitive value into logs.

Allow directives:
    # pii-scan: allow-private-ip        on a line: skip all checks for that line
    # pii-scan: allow-private-ip-file   in the first 20 lines: skip private-IP
                                        checks for that file (SSRF fixtures)
"""

from __future__ import annotations

import argparse
import ipaddress
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

EMAIL_RE = re.compile(
    r"(?<![\w.+-])([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})(?![\w.-])"
)
IPV4_RE = re.compile(r"(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.]|/\d)")
IPV6_RE = re.compile(r"(?<![\w:])((?:[0-9A-Fa-f]{0,4}:){2,}[0-9A-Fa-f]{0,4})(?![\w:]|/\d)")
HOME_RE = re.compile(r"(?<![\w.-])/home/([A-Za-z0-9._-]+)")
WINDOWS_HOME_RE = re.compile(r"[A-Za-z]:\\Users\\([A-Za-z0-9._ -]+)")

ALLOWED_EMAIL_DOMAINS = {
    "example.com",
    "example.org",
    "example.net",
    "localhost",
    "github.com",
    "users.noreply.github.com",
    "noreply.github.com",
}
ALLOWED_HOME_NAMES = {
    "operator",
    "user",
    "example",
    "potaeto",
    "runner",
    "linuxbrew",
}
ALLOWED_WINDOWS_HOME_NAMES = {
    "public",
    "default",
    "default user",
    "all users",
    "runner",
    "user",
    "example",
}
ALLOWED_IPS = {
    ipaddress.ip_address("127.0.0.1"),
    ipaddress.ip_address("0.0.0.0"),
    ipaddress.ip_address("::1"),
}
ALLOWED_NETWORKS = [
    ipaddress.ip_network("192.0.2.0/24"),  # RFC 5737 documentation
    ipaddress.ip_network("198.51.100.0/24"),
    ipaddress.ip_network("203.0.113.0/24"),
    ipaddress.ip_network("2001:db8::/32"),  # RFC 3849 documentation
]

SECRET_PATTERNS = [
    re.compile(r"oc_sk_[A-Za-z0-9]{20,}"),
    re.compile(r"\bsk-[A-Za-z0-9]{20,}"),
    re.compile(r"\bghp_[A-Za-z0-9]{20,}"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}"),
    re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b"),
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(r"\b\d{8,10}:[A-Za-z0-9_-]{35}\b"),
    re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"),
]

SKIP_NAMES = {
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "npm-shrinkwrap.json",
}


def git_files(staged: bool) -> list[str]:
    if staged:
        args = [
            "git",
            "-C",
            str(ROOT),
            "diff",
            "--cached",
            "--name-only",
            "--diff-filter=ACMR",
            "-z",
        ]
    else:
        args = ["git", "-C", str(ROOT), "ls-files", "-z"]
    output = subprocess.check_output(args)
    return [path for path in output.decode("utf-8", "replace").split("\0") if path]


def read_file(path: str, staged: bool) -> bytes | None:
    try:
        if staged:
            return subprocess.check_output(
                ["git", "-C", str(ROOT), "show", f":{path}"], stderr=subprocess.DEVNULL
            )
        return (ROOT / path).read_bytes()
    except (OSError, subprocess.CalledProcessError):
        return None


def is_sensitive_ip(value: str) -> bool:
    try:
        ip = ipaddress.ip_address(value)
    except ValueError:
        return False
    if ip in ALLOWED_IPS:
        return False
    for network in ALLOWED_NETWORKS:
        if ip.version == network.version and ip in network:
            return False
    if ip.version == 6 and ip.ipv4_mapped is not None:
        if ip.ipv4_mapped in ALLOWED_IPS:
            return False
    return ip.is_private or ip.is_link_local or ip.is_loopback or ip.is_unspecified


def load_denylist() -> list[str]:
    candidates = []
    if os.environ.get("PII_DENYLIST"):
        candidates.append(Path(os.environ["PII_DENYLIST"]))
    candidates.append(ROOT / ".pii-denylist")
    candidates.append(Path.home() / ".config" / "potaeto-pii-denylist.txt")
    for candidate in candidates:
        try:
            if not candidate.is_file():
                continue
            terms = []
            for line in candidate.read_text(encoding="utf-8", errors="replace").splitlines():
                line = line.strip()
                if line and not line.startswith("#"):
                    terms.append(line.casefold())
            if terms:
                return terms
        except OSError:
            continue
    return []


def scan_line(
    line: str,
    *,
    file_allows_private_ip: bool,
    denylist: list[str],
) -> set[str]:
    categories: set[str] = set()
    if "pii-scan: allow" in line:
        return categories

    for match in EMAIL_RE.finditer(line):
        domain = match.group(1).rsplit("@", 1)[1].lower()
        if domain not in ALLOWED_EMAIL_DOMAINS:
            categories.add("email")

    if not file_allows_private_ip:
        for match in IPV4_RE.finditer(line):
            if is_sensitive_ip(match.group(0)):
                categories.add("private-ip")
        for match in IPV6_RE.finditer(line):
            if is_sensitive_ip(match.group(1)):
                categories.add("private-ip")

    for match in HOME_RE.finditer(line):
        if match.group(1).lower() not in ALLOWED_HOME_NAMES:
            categories.add("home-path")
    for match in WINDOWS_HOME_RE.finditer(line):
        if match.group(1).strip().lower() not in ALLOWED_WINDOWS_HOME_NAMES:
            categories.add("home-path")

    if any(pattern.search(line) for pattern in SECRET_PATTERNS):
        categories.add("secret")

    lowered = line.casefold()
    if any(term in lowered for term in denylist):
        categories.add("denylist")

    return categories


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--staged",
        action="store_true",
        help="scan the git index instead of the working tree (for pre-commit)",
    )
    args = parser.parse_args()

    denylist = load_denylist()
    files = git_files(args.staged)
    findings: list[tuple[str, int, str]] = []
    scanned = 0

    for path in files:
        name = Path(path).name
        if name in SKIP_NAMES or name.endswith((".lock", ".min.js", ".min.css", ".map")):
            continue
        raw = read_file(path, args.staged)
        if raw is None or b"\0" in raw[:8192]:
            continue
        text = raw.decode("utf-8", "replace")
        lines = text.splitlines()
        header = "\n".join(lines[:20])
        file_allows_private_ip = "pii-scan: allow-private-ip-file" in header
        scanned += 1
        for number, line in enumerate(lines, 1):
            categories = scan_line(
                line,
                file_allows_private_ip=file_allows_private_ip,
                denylist=denylist,
            )
            for category in sorted(categories):
                findings.append((path, number, category))

    mode = "staged" if args.staged else "working tree"
    if findings:
        print(f"PII scan ({mode}): {len(findings)} finding(s)")
        for path, number, category in findings:
            print(f"  {path}:{number}: {category}")
        print(
            "Replace the value with a neutral placeholder; see docs/PII_POLICY.md. "
            "Values are intentionally not printed."
        )
        return 1

    suffix = f", {len(denylist)} private denylist term(s)" if denylist else ""
    print(f"PII scan ({mode}): clean ({scanned} file(s){suffix})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
