# Releases and versioning

## Versioning

[Semantic Versioning](https://semver.org/spec/v2.0.0.html), with the pre-1.0
caveat spelled out because it matters here:

**While the version starts with `0.`, breaking changes may land in a minor
release.** That is what pre-1.0 means in SemVer, and this project genuinely uses
it — the tool registry, the database schema, and the confirmation strings are
all still free to move. Pin an exact version if that matters to you.

`1.0.0` is reserved for the point where the public surface has held still long
enough that other people are relying on it.

All eight workspace manifests share one version. Nothing is published to a
package registry, so there is no per-package release cadence to coordinate.

## What counts as breaking

- Removing or renaming an MCP tool, resource, or prompt.
- Changing a tool's input or output schema in a way an existing caller would
  notice.
- Changing any confirmation string (`ENABLE`, `APPROVE`, `REJECT`, `REVISE`,
  `PUBLISH`, or a purge phrase).
- Changing the data-home layout, or a migration that an older build cannot open.
- Raising the minimum Node version or dropping a supported MCP client.

Documentation, tests, internal refactors, and new optional tools are not
breaking.

## Cadence

There is none. Releases happen when there is something worth releasing. A
changelog entry is written for every release; see [../CHANGELOG.md](../CHANGELOG.md).

## Upgrading

```powershell
git pull
npm ci
npm run build
```

Then restart any MCP client that has the server configured. Pending migrations
apply automatically on the next start
(`linkedin-mcp-server/src/bootstrap.ts:32`).

## Downgrading — not supported

**Migrations are forward-only.** There are no down-migrations, and there will
not be: a schema rollback that silently discards rows written by a newer build
is a data-loss bug wearing a helpful name.

To go back to an earlier version, restore a backup taken while that version was
running:

Backups are created and inspected through the `linkedin_backup_run` MCP tool
(modes `backup`, `list`, `verify`, `export_bundle`) or the dashboard's **System**
area. There is no `backup` subcommand on the control CLI, and the tool takes no
path: backups only ever land inside the managed data home.

Restore that backup, then check out the matching tag. A backup is verified
before it is trusted, and a verified backup never contains anything under
`secrets/` (`packages/domain/src/backupService.ts:294-295`), so credentials are
re-entered after a restore rather than travelling with it.

**Take a backup before upgrading** if the data matters. It is the only rollback
path that exists.

## Release artifacts

A release is a Git tag plus a GitHub Release carrying:

- the source archive,
- `SHA256SUMS`,
- `THIRD-PARTY-NOTICES.md` (regenerate with `npm run notices`),
- an SBOM.

Nothing is published to npm. If that ever changes, the internal `"*"`
dependency ranges between workspaces must become explicit version ranges first,
and the packages that currently expose raw TypeScript through `exports` need
real build output — see [architecture.md](architecture.md).
