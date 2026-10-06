# Dependency updates

- Check all direct and locked npm dependencies against registry publication dates.
- Update versions only after seven complete days; preserve transitive dependency ranges.
- Check GitHub Actions and pinned Bun/Node tooling versions.
- Run the documented typecheck, regression tests, and web build sequentially.

Status: Complete. Updated eligible tooling and transitive packages; all checks passed.
