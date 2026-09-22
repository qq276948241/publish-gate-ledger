# @date-fns/publish-gate

Release-chain tooling for split `@date-fns/tz` builds. It owns four stages and
stops the release (non-zero exit) whenever a stage does not line up:

1. **Split build** (`src/config/coarse.json`, `src/config/fine.json`) —
   functional modules are grouped into independently installable packages; the
   main `@date-fns/tz` package only aggregates. Cross-package imports stay as
   package subpaths, shared code is never duplicated, and cyclic package
   graphs are rejected at config load.
2. **Tree-shaking gate** (`src/gates/treeshake.mjs`) — every package must
   carry `sideEffects: false`; representative consumer bundles are produced
   with tree shaking on, dead code must disappear (no empty re-export shells),
   and the shaken bundle must behave identically to the unshaken entry.
3. **Declaration gate** (`src/gates/types.mjs`) — every shipped `.js`/`.cjs`
   has matching `.d.ts`/`.d.cts`; declaration versions must equal the release
   version; relative type imports must resolve; the declared export surface is
   diffed against the real CJS runtime surface (extra or missing exports
   fail). A downstream `tsgo --noEmit` project consumes the packages exactly
   as a business repo would.
4. **Release script** (`src/lib/release.mjs`, `src/cli.mjs`) — one command
   bumps every package to the same version, writes matching CHANGELOG entries,
   reruns every gate, hashes every artifact into `release-manifest.json`, and
   records what was checked into `work/release-ledger.json` for later audit.

## Commands

```sh
pnpm --filter @date-fns/publish-gate build:split          # both layouts
pnpm --filter @date-fns/publish-gate gate:all             # every gate, both layouts
pnpm --filter @date-fns/publish-gate verify fine          # build + full gate run
pnpm --filter @date-fns/publish-gate release fine --dry-run
pnpm --filter @date-fns/publish-gate release fine --version 1.7.0 --note "..."
pnpm --filter @date-fns/publish-gate report fine
pnpm --filter @date-fns/publish-gate selftest            # mutation probes
```

`release --check-existing` gates the on-disk artifacts without rebuilding,
which is how CI rejects a tampered or stale build before publish.
