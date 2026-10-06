# Findings

Audit cutoff: 2026-09-29T03:59:25Z (seven days before the audit).

- All ten direct npm dependencies already use the newest eligible stable version.
- Excluded newer versions: Electrobun 2.0.2 (2026-09-29T22:16:20Z), Vite 8.3.2 (2026-10-01T10:17:44Z), and @vitejs/plugin-react 6.1.2 (2026-10-05T10:08:27Z).
- Checked all 93 unique locked package/version pairs. No existing locked version is younger than seven days. Some transitive updates remain constrained by their parent package ranges.
- Bun 1.4.2 was released on 2026-09-05. Node 22.23.3 was released on 2026-09-23 and is the newest eligible release in the existing Node 22 LTS line.
- The six GitHub Actions already reference the newest eligible major: checkout v7, setup-node v7, setup-bun v2, upload-artifact v7, download-artifact v8, and action-gh-release v3.
- Existing bunfig.toml enforces minimumReleaseAge = 604800 seconds.

Sources: npm registry package metadata, Node.js distribution index, and the upstream GitHub release APIs.

## Final changes

| Dependency | Before | After | New version published |
| --- | --- | --- | --- |
| Bun package manager and workflow pin | 1.3.13 | 1.4.2 | 2026-09-05 |
| Node 22 workflow pin | 22.22.2 | 22.23.3 | 2026-09-23 |
| @types/node | 17.0.45 | 26.6.3 | 2026-09-25 |
| ansi-regex | 6.2.2 | 6.4.0 | 2026-09-27 |
| get-east-asian-width | 1.6.0 | 1.7.0 | 2026-09-17 |
| nanoid | 3.3.18 | 3.3.19 | 2026-09-10 |

- The nested picomatch 4.0.4 entry now uses the existing 4.0.7 resolution.
- @types/node adds undici-types 8.9.0, published on 2026-07-24.
- Newer transitive majors or exact parent pins remain constrained by the packages that depend on them. No overrides were introduced.
- Final npm publication audit checked all 93 locked package/version pairs; every version is at least seven days old.

## Verification

Used an upstream portable Bun 1.4.2 Windows executable, verified against the GitHub release asset SHA-256. The globally installed Bun was not changed.

- bun install --frozen-lockfile: passed; no changes.
- bun run typecheck: passed.
- bun run test: 55 passed, 0 failed.
- bun run build:web: passed.

The full desktop packaging build was not run. Complete command output is in the ignored log files beside this document.
