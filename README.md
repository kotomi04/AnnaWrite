# Anna Apps

First-party Anna Apps, organized as a [pnpm workspaces](https://pnpm.io/workspaces) monorepo.

Each app under `apps/<slug>/` is a self-contained Anna App bundle (`manifest.json` + `app.json` + `bundle/` + `executas/`) that you can develop, validate and publish independently with [`@anna-ai/cli`](https://www.npmjs.com/package/@anna-ai/cli).

## Apps

| Slug | What it does |
| --- | --- |
| [`finder`](apps/finder) | Browse, preview, and manage the on-disk data of every Anna App under `~/.anna/`. Inspired by macOS Finder + iOS Files. |
| [`anna-visual-brand-mvp`](apps/anna-visual-brand-mvp) | Reusable brand profiles, brand-bound designers, visual prompt packages, and Anna image generation. |
| [`anna-write-mvp`](apps/anna-write-mvp) | Reusable author styles, Anna LLM drafting, sentence-level revision, and publish-ready export. |

## Why a monorepo?

Like Apple's first-party apps (Finder, Notes, Mail, …) live in a single source tree, Anna's first-party apps share:

- One `@anna-ai/cli` version → consistent harness / validate / publish behaviour
- One copy of cross-app conventions (`packages/` is reserved for future shared UI / helpers)
- A single CI target — one PR fixes a protocol regression across every app

Third-party / community apps should still live in their own repos.

## Layout

```
anna-apps/
├── package.json            # pnpm workspaces root
├── pnpm-workspace.yaml
├── apps/
│   └── finder/             # the first app
│       ├── manifest.json   # Anna App manifest (schema v2)
│       ├── app.json        # Marketplace metadata
│       ├── bundle/         # Static SPA loaded into the iframe
│       └── executas/       # Stdio Executa plugins (Python)
└── packages/               # Reserved for shared UI / helpers
```

## Quick start

```bash
# From the monorepo root
pnpm install

# Doctor — verify uv / matrix-nexus / dev key
pnpm doctor

# Run a specific app's local harness
pnpm --filter @anna-apps/finder dev

# Validate everything
pnpm validate
```

## Adding a new app

```bash
cd apps
pnpm dlx @anna-ai/cli init my-new-app --slug my-new-app --template minimal
```

Then add it to the table above and to `pnpm-workspace.yaml` if you used a different folder.

## Publishing the preset registry (matrix-nexus)

Apps under `apps/<slug>/` are distributed to matrix-nexus servers via a
private Cloudflare R2 bucket (`anna-preset-apps`). The pipeline is fully
automated by [`.github/workflows/publish-preset-registry.yml`](.github/workflows/publish-preset-registry.yml):

| Trigger | Target env |
| --- | --- |
| `push` to `main` | `staging` |
| GitHub release published (e.g. `v1.4.0`) | `production` |
| `workflow_dispatch` | operator chooses |

Each run:

1. `pnpm -r --filter "./apps/*" validate` (anna-app-cli, strict mode).
2. `scripts/build_preset_registry.py` packs every app into
   `<slug>/<version>/app.tar.gz` and writes a deterministic `registry.json`.
3. `scripts/validate_preset_registry.py` re-checks the registry against the
   same schema matrix-nexus enforces at startup.
4. Tarballs are uploaded first, then `registry.json`, then a timestamped
   `_history/registry.<ts>.json` snapshot is archived.

### Per-app overrides — `apps/<slug>/preset.json`

Optional file consumed by `build_preset_registry.py`:

```jsonc
{
  "system": true,                  // mark as a system app on nexus
  "min_nexus_version": "0.18.0",   // skip if nexus is older
  "deprecated": false              // soft-remove (kept on disk, not refreshed)
}
```

Version is taken from `manifest.json:version`, falling back to
`app.json:version` (matches matrix-nexus seeder).

### Local dry-run

```bash
python scripts/build_preset_registry.py \
  --apps-dir apps --env staging --source-sha local --output-dir /tmp/reg
python scripts/validate_preset_registry.py /tmp/reg/registry.json --expect-env staging
```

### Publishing to a *local* R2 prefix (developer workflow)

A locally running `matrix-nexus` with `DEPLOY_ENV=local` looks for
`s3://anna-preset-apps/local/registry.json`. The GitHub workflow above only
publishes `staging` / `production`, so seeding the `local/` prefix is a
one-shot script:

```bash
# Reads R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY from
# ../matrix-nexus/.env (override with --env-file).
pnpm preset:publish:local

# Or invoke directly with custom creds / bucket:
python scripts/publish_preset_registry_local.py \
  --prefix local --bucket anna-preset-apps \
  --env-file ../matrix-nexus/.env
```

The script builds tarballs + `registry.json` into a temp dir, uploads the
tarballs first and `registry.json` last (so nexus never reads a manifest
referencing a not-yet-uploaded object), then exits. Restart nexus to pick
up the new registry.

Use `pnpm preset:build:local` (or `--dry-run`) to inspect the payload
without touching R2.

Design doc (the source of truth): `matrix-nexus/docs/design/preset-apps-remote-registry.md`.

## Publishing executa binaries

Each `apps/<slug>/executas/<tool>/` whose `pyproject.toml` declares
`[tool.anna.binary_urls]` ships as prebuilt single-file binaries on the
same R2 bucket, served via the custom domain `bin.anna.partners`:

```
https://bin.anna.partners/<env>/executas/<tool_id>/<version>/<platform>.<ext>
                                                              + .sha256
```

`<env>` is `production` / `staging` / `local`; `<platform>` is one of
`darwin-arm64`, `darwin-x86_64`, `linux-x86_64`, `linux-aarch64`,
`windows-x86_64`; `<ext>` is `tar.gz` (or `zip` on Windows). Versions are
**immutable** — bump the `version` in the executa's `pyproject.toml` to
re-cut.

Per-executa release workflow — one generic
[`release-executa.yml`](.github/workflows/release-executa.yml) serves
every executa under `apps/*/executas/*/`:

| Trigger | Target env |
| --- | --- |
| Tag push `<tool_id>-v<version>` (e.g. `tool-anna-finder-v1.2.0`) | `production` |
| `workflow_dispatch` | operator picks tool_id + version + env |

Each run runs `build_binary.sh` on a 5-platform matrix (PyInstaller
`--onefile`), shapes the asset as flat `<platform>.<ext>` + `.sha256`, and
uploads to R2 with `Cache-Control: public, max-age=31536000, immutable`.
No GitHub Release object is created.

### Cross-workflow gate

`publish-preset-registry.yml` runs
[`scripts/check_executa_assets.py --sidecar`](scripts/check_executa_assets.py)
right after schema validation. It walks every executa's `pyproject.toml`,
extracts the canonical `bin.anna.partners` URLs and `HEAD`s each object
(plus the `.sha256` sidecar) on R2. The registry publish fails if any
binary is missing, so it's impossible to ship a `registry.json` that
references a binary that hasn't been built yet.

```bash
# Local sanity check — lists every expected R2 key without creds:
python scripts/check_executa_assets.py --dry-run
```

### Publishing to a *local* R2 prefix (developer workflow)

Mirror of the preset-registry local flow, but for the binary itself:

```bash
# Builds current platform via build_binary.sh + uploads to
# s3://anna-preset-apps/local/executas/<tool_id>/<version>/
python scripts/publish_executa_binary_local.py ./apps/finder/executas/anna-finder
```

Pairs with matrix-nexus' default `DEPLOY_ENV=local`: the first-party
seeder auto-rewrites the pyproject's `production` URLs to whatever
`DEPLOY_ENV` is set to on any non-prod env, so the Agent fetches the
binary you just pushed to `local/`. Restart nexus to pick it up.

Refuses `--prefix staging|production` — those prefixes are CI-owned.

## License

MIT — see [LICENSE](LICENSE) (mirrors the policy of `anna-executa-examples`).
