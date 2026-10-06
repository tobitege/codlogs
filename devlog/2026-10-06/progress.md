# Progress

- Read repository instructions and verified native PowerShell 7.
- Audited direct dependencies, all locked dependencies, and workflow tooling.
- Updated the Bun package manager pin and workflow Bun/Node pins.
- Regenerated the lockfile with the existing seven-day minimum and preserved the previous lockfile in a temporary backup.
- Updated four transitive package versions and removed the older nested picomatch resolution.
- Verified frozen installation, typecheck, all 55 tests, and the web build with portable Bun 1.4.2.
- Rechecked every final locked package publication date; all 93 package/version pairs qualify.
- No portable Bun processes remain. The user requested an English commit explanation and a push to origin after validation.
- Committed the dependency updates as 1e9c61f and pushed main to origin.
- Increased the package and desktop app versions from 1.4.0 to 1.4.1. Added the README changelog entry for changes since v1.4.0.
