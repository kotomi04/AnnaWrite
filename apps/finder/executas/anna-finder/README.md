# anna-finder Executa

Sandboxed file-browser tool that powers the Finder Anna App.

- **Manifest tool method**: `fs` (single dispatcher; `action` selects the operation)
- **Sandbox root**: `~/.anna/`
- **Protocol**: JSON-RPC 2.0 over stdio (`describe` / `invoke` / `health`)

## Actions

| `action`         | Required args             | Returns                                     |
| ---------------- | ------------------------- | ------------------------------------------- |
| `list_apps`      | —                         | Top-level entries under `~/.anna/` + sizes  |
| `list_dir`       | `path`                    | Children of a folder + parent path          |
| `read_file`      | `path` *(`max_bytes?`)*   | Text or base64 preview                      |
| `stat`           | `path`                    | Single entry stat                           |
| `delete`         | `path` *(`recursive?`)*   | `{deleted}`                                 |
| `rename`         | `path`, `new_path`        | `{from, to, entry}`                         |
| `create_folder`  | `path`                    | `{created, entry}`                          |
| `stats`          | —                         | Per-app + grand totals                      |

Every path argument is resolved with symlinks and rejected if it lives outside `~/.anna/`. Path traversal (`..`), absolute paths to other roots, and deleting the sandbox root itself all return an `InvokeResult` with `success=false`.

## Local dev

```bash
cd executas/anna-finder
uv venv
uv pip install -e ".[dev]"

# Smoke-test describe:
echo '{"jsonrpc":"2.0","id":1,"method":"describe"}' | python anna_finder_plugin.py

# Smoke-test list_apps:
echo '{"jsonrpc":"2.0","id":2,"method":"invoke","params":{"tool":"fs","arguments":{"action":"list_apps"}}}' \
  | python anna_finder_plugin.py
```

## Tool ID

Finder lives under matrix-nexus's reserved first-party namespace, so the tool_id is fixed: **`tool-anna-finder`**. The platform's `first_party_executas_seeder` owns this ID, and the public mint endpoint rejects any user attempt to claim a `tool-anna-*` slug. Do NOT replace it.

The ID appears in **four** source-of-truth files — keep them in sync if you ever rename the executa:

- `pyproject.toml` (`name`, `[project.scripts]` key)
- `anna_finder_plugin.py` (`MANIFEST["name"]`)
- `../../manifest.json` (`required_executas[].tool_id`, `ui.host_api.tools`)
- `../../bundle/app.js` (`TOOL_ID`)

## Distribution

`anna-finder` is shipped as a **prebuilt single-file binary** (PyInstaller `--onefile`), not a uv/pip package. The matrix Agent downloads the right archive for its OS+arch, extracts it under `~/.anna/executa/bin/`, clears macOS quarantine, and speaks JSON-RPC over stdio.

Binaries are hosted on **Cloudflare R2** (bucket `anna-preset-apps`, public-read via the `bin.anna.partners` custom domain) so the same artifact infrastructure serves preset app bundles and executa binaries.

The platform binding lives in [`pyproject.toml`](pyproject.toml):

```toml
[tool.anna.executa]
distribution = "binary"

[tool.anna.executa.binary_urls]
"darwin-arm64"   = "https://bin.anna.partners/production/executas/tool-anna-finder/<version>/darwin-arm64.tar.gz"
# … one entry per platform
```

`first_party_executas_seeder` reads this dict verbatim into the `executas.binary_urls` column on every server start.

### Supported platforms

| Platform key      | Runner used in CI    | R2 asset key                                      |
| ----------------- | -------------------- | ------------------------------------------------- |
| `darwin-arm64`    | `macos-14`           | `<env>/executas/tool-anna-finder/<v>/darwin-arm64.tar.gz`   |
| `darwin-x86_64`   | `macos-13`           | `<env>/executas/tool-anna-finder/<v>/darwin-x86_64.tar.gz`  |
| `linux-x86_64`    | `ubuntu-latest`      | `<env>/executas/tool-anna-finder/<v>/linux-x86_64.tar.gz`   |
| `linux-aarch64`   | `ubuntu-24.04-arm`   | `<env>/executas/tool-anna-finder/<v>/linux-aarch64.tar.gz`  |
| `windows-x86_64`  | `windows-latest`     | `<env>/executas/tool-anna-finder/<v>/windows-x86_64.zip`    |

Each tarball/zip is accompanied by a `<asset>.sha256` sidecar in the same key prefix.

### Release flow

CI: [`.github/workflows/release-anna-finder.yml`](../../../../.github/workflows/release-anna-finder.yml)

1. Bump `[project].version` in `pyproject.toml` AND `MANIFEST["version"]` in `anna_finder_plugin.py`.
2. Update every URL in `[tool.anna.executa.binary_urls]` to the new version — e.g. `.../tool-anna-finder/1.3.0/darwin-arm64.tar.gz`.
3. Commit, then tag and push:
   ```bash
   git tag tool-anna-finder-v1.3.0
   git push origin tool-anna-finder-v1.3.0
   ```
4. The workflow derives the version from the tag, builds 5 platforms in parallel, smoke-tests `describe`, packages each as `.tar.gz`/`.zip` (with a `.sha256` sidecar), and uploads to `s3://anna-preset-apps/production/executas/tool-anna-finder/<version>/` on R2.
5. For dry-runs or re-publishes, use **Run workflow** with `target_env=staging` (or `production`) and pass `version` explicitly.
6. On the next matrix-nexus startup, the seeder picks up the new `[tool.anna.executa.binary_urls]` and `executas.binary_urls` is updated in place. Existing matrix Agents will re-download on their next install/upgrade probe.

> **⚠️ Version + URL coupling**: the seeder does NOT auto-rewrite URLs from `[project].version`. If you bump the version but forget to update the `binary_urls` strings (or vice versa), every fresh install will silently keep using the older binary. Keep them in lockstep.
>
> **⚠️ Immutability**: once a `<tool_id>/<version>/<platform>` object is uploaded, do NOT overwrite it with different bytes — matrix Agents cache by URL. To re-cut a release, bump the version.

### Local build

```bash
cd executas/anna-finder
./build_binary.sh           # → dist/tool-anna-finder + dist/tool-anna-finder-<platform>.tar.gz
./build_binary.sh --clean   # wipe build/ dist/ first
```

The script auto-detects your platform key, runs PyInstaller with the same flags as CI, and reproduces the exact archive name CI would publish.
