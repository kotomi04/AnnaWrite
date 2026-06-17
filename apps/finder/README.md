# Finder

> A calm, native-feeling browser for **Anna Persistent Storage (APS)** — the per-user, per-app key/value store every Anna App writes to. Inspired by macOS Finder and the iOS Files app.

Finder is the **first app** in the [`anna-apps`](../../README.md) monorepo. It is itself an Anna App, built from the same building blocks as the focus-flow example:

- A static SPA bundle (`bundle/`) loaded into Anna's iframe runtime.
- A single Executa stdio plugin (`executas/anna-finder/`) that wraps the APS reverse-RPC surface (`storage.list / get / set / delete`) under one method (`aps`) with an `action` discriminator, plus a `stats` aggregator for per-prefix totals.
- A SKILL (`executas/finder-curator/SKILL.md`) so Anna can answer storage / clean-up questions in chat using the same tool.

## Why this app

Anna's apps quietly accumulate state in APS — `notes/log`, `sessions/active`, app-scoped settings, draft documents, etc. There's no built-in way to **see**, **inspect**, **edit** or **clean up** those entries. Finder fixes that with a UI that feels like Finder/Files, while staying inside Anna's per-user / per-app permission model.

## Features

| Area | What it does |
| --- | --- |
| **Scope tabs** | Switch between APS scopes — `app` (default), `user`, `tool`. The host pins ownership so you only see your own entries. |
| **Prefix tree** | Sidebar lists first-segment buckets (`notes/`, `sessions/`, …) with size + key count. Click to drill in. |
| **Browse** | Two-pane Finder/Files layout with breadcrumbs, back button, and per-prefix filter (search). |
| **View** | Slide-up drawer renders the entry's JSON value, pretty-printed. |
| **Edit** | Inline JSON editor with etag-based optimistic concurrency — concurrent writes surface `STORAGE_PRECONDITION_FAILED` instead of silently clobbering. |
| **New entry** | Create a key under the current prefix with an initial JSON value. |
| **Export** | Download the entry's value as a `.json` file. |
| **Delete** | Always confirms first; passes `if_match: <etag>` to refuse stale deletes. |
| **Curator** | "Ask coach" routes a context-aware message into Anna chat; the SKILL grounds Anna's reply on the same tool. |
| **Theme** | Light / dark / system; persisted via `anna.storage` and `localStorage`. |
| **Keyboard** | `R` refresh, `Esc` closes preview, `Backspace` goes up. |

## Architecture

```
finder/
├── manifest.json                 # Anna App manifest (schema v2)
├── app.json                      # Marketplace metadata
├── bundle/
│   ├── index.html
│   ├── style.css                 # Light / dark, premium aesthetic
│   ├── app.js                    # All UI + APS plumbing
│   └── icon.svg
├── executas/
│   ├── anna-finder/              # ▶ Tool (Python stdio JSON-RPC plugin)
│   │   ├── pyproject.toml
│   │   ├── anna_finder_plugin.py # describe / invoke / health
│   │   └── README.md
│   └── finder-curator/           # ▶ Skill (declarative prompt)
│       └── SKILL.md
└── fixtures/
    └── happy-path.jsonl          # Reference harness recording
```

### RPC shape

The bundle prefers the host SDK's auto-scoped storage namespace (lower latency, scope pinned to this app):

```js
await anna.storage.list({ prefix: "notes/", limit: 200 });
await anna.storage.get({ key: "notes/2025-05-01" });
await anna.storage.set({ key: "notes/2025-05-01", value: { text: "hi" }, if_match: etag });
await anna.storage.delete({ key: "notes/2025-05-01", if_match: etag });
```

For cross-scope reads (`user`, `tool`) and the per-prefix `stats` aggregator, the bundle calls the executa with the **single-dispatcher** pattern:

```js
await anna.tools.invoke({
  tool_id: "tool-anna-finder",
  method:  "aps",
  args:    { action: "stats", scope: "app", prefix: "" },
});
```

The plugin returns `{ success: true, data: ... }` on success or `{ success: false, error: "...", code: "..." }` on failure (matching Matrix Nexus's `InvokeResult.from_dict` contract).

### Optimistic concurrency

Every `set` / `delete` carries the entry's etag in `if_match`. If a concurrent writer changed the entry, the host returns `STORAGE_PRECONDITION_FAILED` and the UI reloads the value before retrying.

## Local development

```bash
# From this directory
pnpm install --filter @anna-apps/finder...

# Set up the Python plugin
cd executas/anna-finder
uv venv
uv pip install -e ".[dev]"
cd ../..

# Validate manifest + bundle
pnpm validate

# Run the local harness (matrix-nexus will be auto-detected; or use --matrix-nexus-root)
pnpm dev
```

Then open the printed URL in a browser. The plugin auto-detects `executa_sdk`; without it, every action returns deterministic stub data so the UI stays interactive during local design work.

## Privacy

Finder reads only entries inside **this user's APS quota**. It does not phone home, has no analytics, and `manifest.json` declares only the `tools.invoke`, `chat.write_message`, `storage.read|write`, and `ui.svg` permissions. The host (Matrix Nexus) pins `owner_id` to the calling user/app so cross-tenant reads are impossible at the dispatch layer.

## Publishing checklist

Finder ships as a **first-party Anna App** under matrix-nexus's reserved namespace, so the publishing flow differs from third-party apps:

- [x] Tool IDs are fixed (`tool-anna-finder`, `skill-anna-finder-curator`) — owned by `matrix-nexus/src/services/first_party_executas_seeder.py`. Do NOT mint via `/executa`.
- [ ] Replace placeholder URLs in `app.json` (logo, screenshots, support) — though `logo_url` falls back to `bundle/icon.svg` automatically.
- [ ] Run `pnpm validate --strict` and `pnpm fixture:verify`.
