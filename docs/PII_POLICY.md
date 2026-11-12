# PII & OSS-Safe Policy

This repository must remain safe to publish. Treat every commit, branch, issue, and pull request as public.

## Never commit

- Real names, personal email addresses, phone numbers, postal addresses, or personal handles.
- Private or internal IPs, personal hostnames, personal domains, or home paths that expose a username.
- Personal hardware models, serial numbers, asset names, or exact device specifications.
- Cloud account, tunnel, zone, app, or project IDs; API keys, tokens, passwords, cookies, private keys, or credentials.
- Customer or user data, private repository paths, or content copied from a private context store.

Use neutral placeholders instead:

| Sensitive value | Placeholder |
|---|---|
| Personal email | `owner@example.com` |
| Public hostname | `potaeto.example.com` |
| Server IP | `192.0.2.10` |
| Development IP | `192.0.2.11` |
| Server hostname | `agent-host` |
| Development hostname | `dev-host` |
| Home directory | `~/project` or `/home/operator/...` |
| Cloud account | `<account-id>` |
| Tunnel | `<tunnel-id>` |
| Secret | `<secret>` |
| Person in a fixture | `Alex`, `owner`, or `maintainer` |

Documentation IP ranges are `192.0.2.0/24`, `198.51.100.0/24`, and `203.0.113.0/24`. Test fixtures that must use private addresses should use a generic RFC1918 address and add `# pii-scan: allow-private-ip` to that line, or `# pii-scan: allow-private-ip-file` near the top of the file.

## Sole exception: agent-memory

The private `agent-memory` store (`~/agent-memory`) may contain PII because it never leaves the machine. Never copy its contents into a tracked file, commit, pull request, issue, log, or example. Treat it as private context only.

## Automated check

```bash
scripts/check-pii.sh            # tracked working tree
scripts/check-pii.sh --staged   # staged content, used by the pre-commit hook
```

The scanner reports `file:line: category` only; it never prints the matched value. It checks for non-example emails, private/link-local IPs, home paths, secret-shaped strings, and terms from a private denylist.

Enable the pre-commit hook once per clone:

```bash
git config core.hooksPath .githooks
```

CI runs the same scan on every pull request and on pushes to `main` (`.github/workflows/pii-scan.yml`).

## Private denylist

Generic checks cannot catch a real name or a private domain by themselves. Add those to a **private, untracked** denylist:

```bash
mkdir -p ~/.config
${EDITOR:-vi} ~/.config/potaeto-pii-denylist.txt
```

One case-insensitive literal per line; lines starting with `#` are ignored. The scanner also reads `PII_DENYLIST` and `.pii-denylist` (gitignored). Never commit the denylist.

## Commit metadata

Use a GitHub noreply address for commit author and committer, never a personal email:

```bash
git config user.name "<github-username>"
git config user.email "<github-user-id>+<github-username>@users.noreply.github.com"
```

## If PII is already in history

Do not rewrite shared history without explicit owner approval. Report the finding first, then plan a coordinated rewrite (for example `git filter-repo` with a private replacement file) and force-push all affected branches and tags.
