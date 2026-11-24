# Versioning

Vizor Local uses semantic versioning (MAJOR.MINOR.PATCH).

- **Minor**: bump when a roadmap of features is finished.
- **Patch**: bump for fixes.
- **Major**: reserved for breaking changes to data or the CLI.

## Identifying a build

The commit sha always identifies the exact build. The dashboard shows
`v0.2.0 · abc1234`: the version from `package.json` and the short sha of the
install folder. A zip install has no git sha, so it shows only `v0.2.0`.

## Where the version is reported

`GET /api/state` and `GET /api/update/status` both include
`version: { version, sha, date, label }`.

## Cutting a release

1. Edit the version in `package.json` and `package-lock.json` (the top-level
   `version` and `packages[""].version`).
2. Commit.
3. Merge.
