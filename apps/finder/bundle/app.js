/**
 * Finder — Anna App bundle controller (APS browser).
 *
 * Connects to Anna via the runtime SDK, imported as an ES module from
 *   /static/anna-apps/_sdk/latest/index.js   (named export: AnnaAppRuntime)
 *
 * Storage access goes through the host's `storage.*` namespace. Default
 * scope is `app` (auto-pinned to this app's APS bucket); `scope=user`
 * is opt-in via `manifest.host_capabilities`:
 *
 *   "host_capabilities": [
 *     "aps.kv",                 // default scope=app, self-owned
 *     "aps.scope.user.read",    // read user-wide APS
 *     "aps.scope.user.write"    // write user-wide APS
 *   ]
 *
 *   anna.storage.list({ scope?, prefix, cursor?, limit? })
 *      → { items: [{key, etag, size_bytes, metadata, tags, updated_at}],
 *          next_cursor }
 *   anna.storage.get({ scope?, key })
 *      → { value, etag, generation, exists }
 *   anna.storage.set({ scope?, key, value, if_match? })
 *      → { etag, generation, size_bytes }
 *   anna.storage.delete({ scope?, key, if_match? }) → { deleted: true }
 *
 * The `anna-finder` Executa exposes the same surface as a single tool
 * (`aps`) and is still used for the `stats` aggregator (and as a fallback
 * for `scope=tool`, which has no iframe path yet).
 *
 * Cross-scope note: the host enforces both the manifest declaration AND
 * the per-executa user grant (Settings → Executas → Permissions →
 * "Read/Write user-scope APS"). If the toggle is OFF the host returns
 * `permission_denied` and the bundle falls through to the executa path.
 */

import { AnnaAppRuntime } from "/static/anna-apps/_sdk/latest/index.js";

const TOOL_ID = "tool-anna-finder";
const TOOL_METHOD = "aps";
const STORAGE_KEY_PREFIX = "finder:last-prefix";
const STORAGE_KEY_SCOPE  = "finder:scope";
const STORAGE_KEY_THEME  = "finder:theme";

const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const els = {
  body:          document.body,
  appsList:      $("#apps-list"),
  totalsLine:    $("#totals-line"),
  connStatus:    $("#conn-status"),
  themeToggle:   $("#theme-toggle"),
  scopeBtns:     $$(".scope-btn"),
  backBtn:       $("#back-btn"),
  crumbs:        $("#crumbs"),
  filterInput:   $("#filter-input"),
  refreshBtn:    $("#refresh-btn"),
  newKeyBtn:     $("#new-key-btn"),
  curatorBtn:    $("#curator-btn"),
  entriesBody:   $("#entries-body"),
  preview:       $("#preview"),
  previewTitle:  $("#preview-title"),
  previewSub:    $("#preview-sub"),
  previewBody:   $("#preview-body"),
  previewClose:  $("#preview-close"),
  exportBtn:     $("#export-btn"),
  editBtn:       $("#edit-btn"),
  saveBtn:       $("#save-btn"),
  cancelBtn:     $("#cancel-btn"),
  deleteBtn:     $("#delete-btn"),
  toast:         $("#toast"),
  modal:         $("#modal"),
  modalTitle:    $("#modal-title"),
  modalBody:     $("#modal-body"),
  modalOk:       $("#modal-ok"),
  modalCancel:   $("#modal-cancel"),
};

const state = {
  scope: "app",        // 'app' | 'user' | 'tool'
  prefix: "",          // current prefix (e.g. "notes/")
  buckets: [],         // first-segment groups for the sidebar
  totals: { size: 0, count: 0 },
  entries: [],         // current key list
  filter: "",          // search box
  selected: null,      // {key, etag, value, generation, size_bytes, updated_at}
  history: [],         // back-stack of prefixes
  editing: false,
  editor: null,        // textarea DOM
};

let anna = null;
let isCalling = false;
let toastTimer = null;

// ─────────────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────────────

async function init() {
  bindUi();
  applyStoredTheme();
  renderEntries();
  renderBuckets();

  try {
    anna = await AnnaAppRuntime.connect();
    setConn(true);
  } catch (e) {
    setConn(false);
    standaloneSeed();
    console.warn("[finder] running standalone:", e?.message || e);
    return;
  }

  // Restore last scope + prefix.
  let restoredScope = "app";
  let restoredPrefix = "";
  try {
    const r1 = await anna.storage.get({ key: STORAGE_KEY_SCOPE });
    if (r1?.value === "app" || r1?.value === "user" || r1?.value === "tool") {
      restoredScope = r1.value;
    }
  } catch { /* ignored */ }
  try {
    const r2 = await anna.storage.get({ key: STORAGE_KEY_PREFIX });
    if (typeof r2?.value === "string") restoredPrefix = r2.value;
  } catch { /* ignored */ }

  setScope(restoredScope, { persist: false });
  await navigateTo(restoredPrefix, { pushHistory: false });
}

function bindUi() {
  els.themeToggle.addEventListener("click", toggleTheme);
  els.backBtn.addEventListener("click", goBack);
  els.refreshBtn.addEventListener("click", () => refreshAll());
  els.newKeyBtn.addEventListener("click", onCreateEntry);
  els.curatorBtn.addEventListener("click", askCurator);
  els.previewClose.addEventListener("click", closePreview);
  els.exportBtn.addEventListener("click", exportSelected);
  els.editBtn.addEventListener("click", beginEdit);
  els.saveBtn.addEventListener("click", saveEdit);
  els.cancelBtn.addEventListener("click", cancelEdit);
  els.deleteBtn.addEventListener("click", deleteSelected);

  for (const btn of els.scopeBtns) {
    btn.addEventListener("click", () => setScope(btn.dataset.scope));
  }

  els.filterInput.addEventListener("input", () => {
    state.filter = els.filterInput.value.trim().toLowerCase();
    renderEntries();
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.target instanceof HTMLInputElement) return;
    if (ev.target instanceof HTMLTextAreaElement) return;
    if (ev.key === "r" || ev.key === "R") refreshAll();
    if (ev.key === "Escape") closePreview();
    if (ev.key === "Backspace" && !state.selected) goBack();
  });
}

// ─────────────────────────────────────────────────────────────────────
// APS access — host SDK first; executa fallback for `stats`,
// `scope=tool`, and any `permission_denied` (user hasn't granted).
// ─────────────────────────────────────────────────────────────────────

// Scopes the iframe is allowed to request via host SDK directly.
// `tool` scope is not yet exposed on the iframe path — falls through to executa.
const SCOPE_VIA_HOST = new Set(["app", "user"]);

function _isPermissionDenied(err) {
  if (!err) return false;
  const msg = String(err.message || err.code || "");
  return msg.includes("permission_denied") || msg.includes("aps.scope.");
}

async function apsList(prefix, cursor, limit = 200) {
  if (anna && SCOPE_VIA_HOST.has(state.scope)) {
    try {
      return await anna.storage.list({
        scope: state.scope,
        prefix: prefix || "",
        cursor: cursor || undefined,
        limit,
      });
    } catch (e) {
      if (!_isPermissionDenied(e)) throw e;
      // Fall through to executa — user hasn't granted the scope yet,
      // but the executa path may still succeed via its own grant.
    }
  }
  return await callTool("list", { scope: state.scope, prefix: prefix || "", cursor: cursor || "", limit });
}

async function apsGet(key) {
  if (anna && SCOPE_VIA_HOST.has(state.scope)) {
    try {
      return await anna.storage.get({ scope: state.scope, key });
    } catch (e) {
      if (!_isPermissionDenied(e)) throw e;
    }
  }
  return await callTool("get", { scope: state.scope, key });
}

async function apsSet(key, value, ifMatch) {
  if (anna && SCOPE_VIA_HOST.has(state.scope)) {
    try {
      const args = { scope: state.scope, key, value };
      if (ifMatch) args.if_match = ifMatch;
      return await anna.storage.set(args);
    } catch (e) {
      if (!_isPermissionDenied(e)) throw e;
    }
  }
  const args = { scope: state.scope, key, value };
  if (ifMatch) args.if_match = ifMatch;
  return await callTool("set", args);
}

async function apsDelete(key, ifMatch) {
  if (anna && SCOPE_VIA_HOST.has(state.scope)) {
    try {
      const args = { scope: state.scope, key };
      if (ifMatch) args.if_match = ifMatch;
      return await anna.storage.delete(args);
    } catch (e) {
      if (!_isPermissionDenied(e)) throw e;
    }
  }
  const args = { scope: state.scope, key };
  if (ifMatch) args.if_match = ifMatch;
  return await callTool("delete", args);
}

async function apsStats(prefix) {
  return await callTool("stats", { scope: state.scope, prefix: prefix || "" });
}

async function callTool(action, extra = {}) {
  if (!anna) throw new Error("Not connected to Anna");
  if (isCalling) return null;
  isCalling = true;
  setBusy(true);
  try {
    const result = await anna.tools.invoke({
      tool_id: TOOL_ID,
      method:  TOOL_METHOD,
      args:    { action, ...extra },
    });
    if (result && typeof result === "object" && "success" in result) {
      if (!result.success) {
        const msg = result.error || `aps.${action} failed`;
        const err = new Error(msg);
        err.code = result.code;
        throw err;
      }
      return result.data;
    }
    return result;
  } finally {
    isCalling = false;
    setBusy(false);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Sidebar — buckets (first key segment under current scope).
// ─────────────────────────────────────────────────────────────────────

async function loadBuckets() {
  try {
    const data = await apsStats("");
    state.buckets = Array.isArray(data?.buckets) ? data.buckets : [];
    state.totals = {
      size: Number(data?.total_size || 0),
      count: Number(data?.total_keys || 0),
    };
  } catch (e) {
    state.buckets = [];
    state.totals = { size: 0, count: 0 };
    if (anna) toast(`Cannot read APS stats: ${e?.message || e}`, "err");
  }
  renderBuckets();
  renderTotals();
}

function renderBuckets() {
  const ul = els.appsList;
  ul.innerHTML = "";
  if (!state.buckets.length) {
    const li = document.createElement("li");
    li.className = "apps__empty";
    li.textContent = anna ? "No entries yet in this scope." : "Loading…";
    ul.appendChild(li);
    return;
  }
  for (const b of state.buckets) {
    const li = document.createElement("li");
    li.className = "app-item";
    const activeHead = firstSegment(state.prefix);
    if (activeHead && activeHead === b.name) li.classList.add("is-active");
    li.tabIndex = 0;
    const targetPrefix = b.name + "/";

    const icon = document.createElement("span");
    icon.className = "app-item__icon";
    icon.textContent = (b.name || "?").slice(0, 1).toUpperCase();

    const name = document.createElement("span");
    name.className = "app-item__name";
    name.textContent = b.name || "(root)";

    const size = document.createElement("span");
    size.className = "app-item__size";
    size.textContent = `${humanBytes(b.size)} · ${b.count}`;

    li.append(icon, name, size);
    li.addEventListener("click", () => navigateTo(targetPrefix));
    li.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") navigateTo(targetPrefix);
    });
    ul.appendChild(li);
  }
}

function renderTotals() {
  els.totalsLine.textContent =
    `${humanBytes(state.totals.size)} · ${state.totals.count} keys`;
}

// ─────────────────────────────────────────────────────────────────────
// Scope switching
// ─────────────────────────────────────────────────────────────────────

function setScope(scope, { persist = true } = {}) {
  if (!["app", "user", "tool"].includes(scope)) return;
  state.scope = scope;
  for (const b of els.scopeBtns) {
    b.classList.toggle("is-active", b.dataset.scope === scope);
  }
  state.history = [];
  state.prefix = "";
  closePreview();
  if (persist && anna) {
    anna.storage.set({ key: STORAGE_KEY_SCOPE, value: scope }).catch(() => {});
  }
  refreshAll();
}

// ─────────────────────────────────────────────────────────────────────
// Navigation + entry list
// ─────────────────────────────────────────────────────────────────────

async function navigateTo(prefix, { pushHistory = true } = {}) {
  const target = (prefix || "").replace(/^\/+/, "");
  if (pushHistory && target !== state.prefix) {
    state.history.push(state.prefix);
  }
  state.prefix = target;
  state.filter = "";
  els.filterInput.value = "";
  closePreview();
  await loadEntries();
  renderBuckets();
  persistLastPrefix();
  if (anna) {
    try {
      await anna.window.set_title({
        title: target ? `Finder — ${state.scope}:${target}` : `Finder — ${state.scope}`,
      });
    } catch { /* set_title may be denied */ }
  }
}

async function loadEntries() {
  state.entries = [];
  if (!anna) {
    renderEntries();
    renderCrumbs();
    return;
  }
  try {
    let cursor = "";
    let pages = 0;
    do {
      const page = await apsList(state.prefix, cursor, 200);
      const items = Array.isArray(page?.items) ? page.items : [];
      state.entries.push(...items);
      cursor = page?.next_cursor || "";
      pages += 1;
    } while (cursor && pages < 5 && state.entries.length < 1000);
  } catch (e) {
    toast(`Cannot list entries: ${e?.message || e}`, "err");
  }
  renderEntries();
  renderCrumbs();
  els.backBtn.disabled = state.history.length === 0 && state.prefix === "";
}

function renderEntries() {
  const tbody = els.entriesBody;
  tbody.innerHTML = "";
  const filter = state.filter;

  // ── Aggregate the flat APS keys into "folders" + "files" relative to the
  //    current prefix. APS itself is flat (no delimiter on the server side
  //    — see matrix-nexus storage_service.kv_list); the hierarchy is purely
  //    a client-side projection of `/`-segments.
  const here = state.prefix || "";
  const folderMap = new Map();   // dirName -> { count, size }
  const files = [];
  for (const e of state.entries) {
    const key = e.key || "";
    if (!key.startsWith(here)) continue;
    const rest = key.slice(here.length);
    if (!rest) continue;                       // exact-prefix entry: hide
    const slash = rest.indexOf("/");
    if (slash < 0) {
      files.push({ ...e, _leaf: rest });
    } else {
      const dir = rest.slice(0, slash);
      const agg = folderMap.get(dir) || { count: 0, size: 0 };
      agg.count += 1;
      agg.size  += Number(e.size_bytes || 0);
      folderMap.set(dir, agg);
    }
  }

  const folderRows = Array.from(folderMap.entries())
    .map(([name, agg]) => ({
      _isFolder: true,
      _leaf: name,
      key: here + name + "/",
      count: agg.count,
      size_bytes: agg.size,
    }))
    .sort((a, b) => a._leaf.localeCompare(b._leaf));
  const fileRows = files.sort((a, b) => a._leaf.localeCompare(b._leaf));

  let combined = [...folderRows, ...fileRows];
  if (filter) {
    combined = combined.filter((e) => (e._leaf || "").toLowerCase().includes(filter));
  }

  if (!combined.length) {
    const tr = document.createElement("tr");
    tr.className = "entries__empty";
    const td = document.createElement("td");
    td.colSpan = 4;
    td.textContent = filter
      ? `No keys match "${filter}".`
      : (anna
          ? (state.prefix ? `No entries under "${state.prefix}".` : "Pick a prefix on the left, or create your first entry.")
          : "Standalone preview — connect via Anna to see real APS entries.");
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  for (const entry of combined) {
    const tr = document.createElement("tr");
    if (entry._isFolder) tr.classList.add("entry-row--folder");
    if (!entry._isFolder && state.selected && state.selected.key === entry.key) {
      tr.classList.add("is-selected");
    }

    // ── Key cell with icon
    const tdName = document.createElement("td");
    tdName.className = "col-name";
    const wrap = document.createElement("span");
    wrap.className = "entry-name";
    const icon = document.createElement("span");
    icon.className = "entry-icon";
    icon.dataset.kind = guessKind(entry);
    icon.textContent = iconGlyph(entry);
    const nameText = document.createElement("span");
    nameText.className = "entry-name__text";
    nameText.textContent = entry._leaf || entry.key;
    wrap.append(icon, nameText);
    tdName.appendChild(wrap);

    const tdKind = document.createElement("td");
    tdKind.className = "col-kind";
    tdKind.textContent = labelKind(entry);

    const tdSize = document.createElement("td");
    tdSize.className = "col-size";
    tdSize.textContent = humanBytes(entry.size_bytes || 0);

    const tdMtime = document.createElement("td");
    tdMtime.className = "col-mtime";
    if (entry._isFolder) {
      tdMtime.textContent = `${entry.count} item${entry.count === 1 ? "" : "s"}`;
    } else {
      tdMtime.textContent = entry.updated_at ? humanTime(Date.parse(entry.updated_at)) : "—";
    }

    tr.append(tdName, tdKind, tdSize, tdMtime);
    if (entry._isFolder) {
      const goInto = () => navigateTo(entry.key);
      tr.addEventListener("click", goInto);
      tr.addEventListener("dblclick", goInto);
      tr.tabIndex = 0;
      tr.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); goInto(); }
      });
    } else {
      tr.addEventListener("click", () => openEntry(entry));
      tr.addEventListener("dblclick", () => openEntry(entry));
    }
    tbody.appendChild(tr);
  }
}

function renderCrumbs() {
  els.crumbs.innerHTML = "";
  const segs = state.prefix ? state.prefix.split("/").filter(Boolean) : [];
  els.crumbs.appendChild(makeCrumb(state.scope, "", segs.length === 0));
  let acc = "";
  segs.forEach((seg, i) => {
    els.crumbs.appendChild(crumbSep());
    acc = acc ? `${acc}/${seg}` : seg;
    els.crumbs.appendChild(makeCrumb(seg, acc + "/", i === segs.length - 1));
  });
}

function makeCrumb(label, prefix, current) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = current ? "crumb is-current" : "crumb";
  btn.textContent = label;
  if (!current) btn.addEventListener("click", () => navigateTo(prefix));
  return btn;
}

function crumbSep() {
  const s = document.createElement("span");
  s.className = "crumb__sep";
  s.textContent = "/";
  return s;
}

function goBack() {
  if (state.history.length) {
    const prev = state.history.pop();
    navigateTo(prev, { pushHistory: false });
  } else if (state.prefix) {
    const segs = state.prefix.replace(/\/+$/,"").split("/").slice(0, -1);
    navigateTo(segs.length ? segs.join("/") + "/" : "", { pushHistory: false });
  }
}

// ─────────────────────────────────────────────────────────────────────
// Entry viewer / editor
// ─────────────────────────────────────────────────────────────────────

async function openEntry(entry) {
  state.selected = { ...entry, value: undefined };
  state.editing = false;
  els.preview.setAttribute("aria-hidden", "false");
  els.previewTitle.textContent = entry.key;
  els.previewSub.textContent =
    `${state.scope} · ${humanBytes(entry.size_bytes || 0)} · etag ${truncEtag(entry.etag)}`;
  els.previewBody.innerHTML = '<div class="muted">Loading…</div>';
  setEditMode(false);
  renderEntries();

  try {
    const data = await apsGet(entry.key);
    state.selected.value = data?.value;
    state.selected.etag = data?.etag || entry.etag;
    state.selected.generation = data?.generation;
    renderViewer();
  } catch (e) {
    els.previewBody.innerHTML = "";
    const div = document.createElement("div");
    div.className = "preview__error";
    div.textContent = `Cannot read: ${e?.message || e}`;
    els.previewBody.appendChild(div);
  }
}

function renderViewer() {
  els.previewBody.innerHTML = "";
  const value = state.selected?.value;
  const pre = document.createElement("pre");
  pre.className = "json-view";
  pre.textContent = formatJson(value);
  els.previewBody.appendChild(pre);
}

function beginEdit() {
  if (!state.selected) return;
  state.editing = true;
  setEditMode(true);
  els.previewBody.innerHTML = "";
  const ta = document.createElement("textarea");
  ta.className = "json-edit";
  ta.spellcheck = false;
  ta.value = formatJson(state.selected.value);
  els.previewBody.appendChild(ta);
  ta.focus();
  state.editor = ta;
}

function cancelEdit() {
  state.editing = false;
  state.editor = null;
  setEditMode(false);
  renderViewer();
}

async function saveEdit() {
  if (!state.selected || !state.editor) return;
  let parsed;
  try {
    parsed = JSON.parse(state.editor.value);
  } catch (e) {
    toast(`Invalid JSON: ${e?.message || e}`, "err");
    return;
  }
  try {
    const res = await apsSet(state.selected.key, parsed, state.selected.etag);
    state.selected.value = parsed;
    state.selected.etag = res?.etag;
    state.selected.generation = res?.generation;
    state.selected.size_bytes = res?.size_bytes;
    state.editing = false;
    state.editor = null;
    setEditMode(false);
    renderViewer();
    els.previewSub.textContent =
      `${state.scope} · ${humanBytes(state.selected.size_bytes || 0)} · etag ${truncEtag(state.selected.etag)}`;
    toast("Saved");
    await refreshAll({ keepSelection: true });
  } catch (e) {
    toast(`Save failed: ${e?.message || e}`, "err");
  }
}

function setEditMode(on) {
  els.editBtn.hidden   = on;
  els.exportBtn.hidden = on;
  els.deleteBtn.hidden = on;
  els.saveBtn.hidden   = !on;
  els.cancelBtn.hidden = !on;
}

function closePreview() {
  els.preview.setAttribute("aria-hidden", "true");
  state.selected = null;
  state.editing = false;
  state.editor = null;
  setEditMode(false);
  renderEntries();
}

// ─────────────────────────────────────────────────────────────────────
// Destructive + creation actions
// ─────────────────────────────────────────────────────────────────────

async function deleteSelected() {
  const e = state.selected;
  if (!e) return;
  const ok = await appConfirm(
    `Delete APS entry "${e.key}" in scope "${state.scope}"?\nThis cannot be undone.`,
    { title: "Delete entry", okLabel: "Delete", danger: true }
  );
  if (!ok) return;
  try {
    await apsDelete(e.key, e.etag);
    toast(`Deleted ${e.key}`);
    closePreview();
    await refreshAll();
  } catch (err) {
    toast(`Delete failed: ${err?.message || err}`, "err");
  }
}

async function exportSelected() {
  const e = state.selected;
  if (!e) return;
  const text = formatJson(e.value);
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeFilename(e.key)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast("Exported");
}

async function onCreateEntry() {
  const suffix = await appPrompt(
    `New APS key${state.prefix ? ` under "${state.prefix}"` : ""} (relative path):`,
    { title: "New entry", defaultValue: "draft.json", placeholder: "e.g. notes/draft.json" }
  );
  if (!suffix || !suffix.trim()) return;
  const key = (state.prefix || "") + suffix.trim();
  const raw = await appPrompt(
    `Initial JSON value for "${key}":`,
    { title: "New entry · value", defaultValue: '{"created": true}', multiline: true }
  );
  if (raw === null) return;
  let value;
  try {
    value = JSON.parse(raw || "null");
  } catch (e) {
    toast(`Invalid JSON: ${e?.message || e}`, "err");
    return;
  }
  try {
    const existing = await apsGet(key);
    if (existing?.exists) {
      const overwrite = await appConfirm(
        `"${key}" already exists. Overwrite?`,
        { title: "Overwrite entry", okLabel: "Overwrite", danger: true }
      );
      if (!overwrite) return;
    }
    await apsSet(key, value, existing?.exists ? existing.etag : undefined);
    toast(`Created ${key}`);
    await refreshAll();
  } catch (e) {
    toast(`Create failed: ${e?.message || e}`, "err");
  }
}

async function refreshAll({ keepSelection = false } = {}) {
  const sel = keepSelection ? state.selected : null;
  await loadBuckets();
  await loadEntries();
  if (sel) {
    const match = state.entries.find((e) => e.key === sel.key);
    if (match) {
      state.selected = { ...match, value: sel.value, etag: sel.etag };
      renderEntries();
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Curator integration (chat write_message)
// ─────────────────────────────────────────────────────────────────────

async function askCurator() {
  if (!anna) {
    toast("Not connected to Anna", "err");
    return;
  }
  const where = state.prefix ? `${state.scope}:${state.prefix}` : state.scope;
  const sel = state.selected;
  const content = sel
    ? `Looking at APS entry ${state.scope}:${sel.key} (${humanBytes(sel.size_bytes || 0)}). What does this represent and is anything safe to clean up?`
    : `Browsing APS at ${where}. Anything stale or oversized I should curate?`;
  try {
    await anna.chat.write_message({ role: "user", content });
  } catch (e) {
    toast(`Chat denied: ${e?.message || e}`, "err");
  }
}

// ─────────────────────────────────────────────────────────────────────
// Theme
// ─────────────────────────────────────────────────────────────────────

function applyStoredTheme() {
  const stored = localStorage.getItem(STORAGE_KEY_THEME);
  if (stored === "dark" || stored === "light") {
    els.body.dataset.theme = stored;
  }
  setTimeout(async () => {
    if (!anna) return;
    try {
      const r = await anna.storage.get({ key: STORAGE_KEY_THEME });
      if (r?.value === "dark" || r?.value === "light") {
        els.body.dataset.theme = r.value;
      }
    } catch { /* fine */ }
  }, 0);
}

function toggleTheme() {
  const next = els.body.dataset.theme === "dark" ? "light" : "dark";
  els.body.dataset.theme = next;
  try { localStorage.setItem(STORAGE_KEY_THEME, next); } catch { /* private mode */ }
  if (anna) {
    anna.storage.set({ key: STORAGE_KEY_THEME, value: next }).catch(() => {});
  }
}

async function persistLastPrefix() {
  if (!anna) return;
  try { await anna.storage.set({ key: STORAGE_KEY_PREFIX, value: state.prefix }); }
  catch { /* non-fatal */ }
}

// ─────────────────────────────────────────────────────────────────────
// Standalone fallback (design preview without an Anna host)
// ─────────────────────────────────────────────────────────────────────

function standaloneSeed() {
  state.buckets = [
    { name: "notes",     size: 14_532, count: 12 },
    { name: "sessions",  size: 86_120, count: 4 },
    { name: "drafts",    size: 2_048,  count: 3 },
  ];
  state.totals = { size: 102_700, count: 19 };
  state.entries = [
    { key: "notes/2025-04-01.json", size_bytes: 1234, updated_at: new Date().toISOString(), etag: 'W/"1-abc"' },
    { key: "notes/2025-04-02.json", size_bytes: 2345, updated_at: new Date().toISOString(), etag: 'W/"1-def"' },
  ];
  renderBuckets();
  renderTotals();
  renderEntries();
  renderCrumbs();
}

// ─────────────────────────────────────────────────────────────────────
// Tiny helpers
// ─────────────────────────────────────────────────────────────────────

function setConn(on) {
  els.connStatus.classList.toggle("dot--on", !!on);
  els.connStatus.classList.toggle("dot--off", !on);
  els.connStatus.title = on ? "Connected to Anna" : "Disconnected";
}

function setBusy(busy) {
  document.body.classList.toggle("is-busy", !!busy);
}

function toast(text, level = "ok") {
  els.toast.textContent = text;
  els.toast.classList.toggle("toast--err", level === "err");
  els.toast.hidden = false;
  void els.toast.offsetWidth;
  els.toast.classList.add("is-on");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.classList.remove("is-on");
    setTimeout(() => { els.toast.hidden = true; }, 220);
  }, 2200);
}

// ─────────────────────────────────────────────────────────────────────
// In-app modal (sandbox-safe replacement for window.prompt/confirm).
//
// The anna-app dev harness iframe lacks the `allow-modals` sandbox token,
// so calls to native prompt()/confirm() silently no-op. These helpers
// render the same flow into our own modal element and return a Promise.
// Behaviour:
//   - Esc / backdrop click  → resolve(null) for prompt, resolve(false) for confirm
//   - Enter (single-line)   → resolve current value
//   - Cmd/Ctrl+Enter        → submit even in multi-line textarea
// ─────────────────────────────────────────────────────────────────────

let _modalCleanup = null;

function _openModal({ title, render, onSubmit, onCancel, okLabel = "OK", cancelLabel = "Cancel", danger = false }) {
  if (_modalCleanup) _modalCleanup();

  els.modalTitle.textContent = title;
  els.modalBody.replaceChildren();
  render(els.modalBody);

  els.modalOk.textContent = okLabel;
  els.modalCancel.textContent = cancelLabel;
  els.modalOk.classList.toggle("btn--danger", !!danger);
  els.modalOk.classList.toggle("btn--primary", !danger);

  els.modal.setAttribute("aria-hidden", "false");

  const focusable = els.modalBody.querySelector("input, textarea");
  if (focusable) {
    focusable.focus();
    if (typeof focusable.select === "function") focusable.select();
  } else {
    els.modalOk.focus();
  }

  const close = () => {
    els.modal.setAttribute("aria-hidden", "true");
    els.modalOk.removeEventListener("click", okHandler);
    els.modalCancel.removeEventListener("click", cancelHandler);
    document.removeEventListener("keydown", keyHandler, true);
    els.modal.querySelectorAll("[data-modal-dismiss]").forEach(
      (el) => el.removeEventListener("click", cancelHandler),
    );
    _modalCleanup = null;
  };
  const okHandler     = () => { onSubmit(); close(); };
  const cancelHandler = () => { onCancel(); close(); };
  const keyHandler = (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      cancelHandler();
      return;
    }
    if (ev.key === "Enter") {
      const target = ev.target;
      const isTextarea = target instanceof HTMLTextAreaElement;
      if (!isTextarea || ev.metaKey || ev.ctrlKey) {
        ev.preventDefault();
        okHandler();
      }
    }
  };

  els.modalOk.addEventListener("click", okHandler);
  els.modalCancel.addEventListener("click", cancelHandler);
  els.modal.querySelectorAll("[data-modal-dismiss]").forEach(
    (el) => el.addEventListener("click", cancelHandler),
  );
  document.addEventListener("keydown", keyHandler, true);

  _modalCleanup = close;
}

function appConfirm(message, opts = {}) {
  return new Promise((resolve) => {
    _openModal({
      title: opts.title || "Confirm",
      okLabel: opts.okLabel || "OK",
      cancelLabel: opts.cancelLabel || "Cancel",
      danger: !!opts.danger,
      render: (root) => {
        const p = document.createElement("p");
        p.className = "modal__msg";
        p.textContent = message;
        root.appendChild(p);
      },
      onSubmit: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}

function appPrompt(message, opts = {}) {
  return new Promise((resolve) => {
    let inputEl;
    _openModal({
      title: opts.title || "Input",
      okLabel: opts.okLabel || "OK",
      cancelLabel: opts.cancelLabel || "Cancel",
      render: (root) => {
        if (message) {
          const p = document.createElement("p");
          p.className = "modal__msg";
          p.textContent = message;
          root.appendChild(p);
        }
        inputEl = opts.multiline
          ? document.createElement("textarea")
          : document.createElement("input");
        if (!opts.multiline) inputEl.type = "text";
        inputEl.className = "modal__input";
        inputEl.value = opts.defaultValue ?? "";
        if (opts.placeholder) inputEl.placeholder = opts.placeholder;
        root.appendChild(inputEl);
      },
      onSubmit: () => resolve(inputEl ? inputEl.value : ""),
      onCancel: () => resolve(null),
    });
  });
}

function humanBytes(n) {
  const x = Number(n) || 0;
  if (x < 1024) return `${x} B`;
  if (x < 1024 ** 2) return `${(x / 1024).toFixed(1)} KB`;
  if (x < 1024 ** 3) return `${(x / 1024 ** 2).toFixed(1)} MB`;
  return `${(x / 1024 ** 3).toFixed(2)} GB`;
}

function humanTime(ms) {
  const d = new Date(ms);
  if (isNaN(+d)) return "—";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return `Today ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  }
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString([], {
    year: sameYear ? undefined : "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function firstSegment(p) {
  if (!p) return "";
  const head = p.split("/")[0];
  return head || "";
}

function guessKind(entry) {
  if (entry && entry._isFolder) return "folder";
  const k = (entry.key || "").toLowerCase();
  if (k.endsWith(".json")) return "json";
  if (k.endsWith(".md") || k.endsWith(".txt")) return "text";
  if (k.endsWith("/")) return "folder";
  return "json"; // APS values are always JSON-like
}

function labelKind(entry) {
  const k = guessKind(entry);
  if (k === "folder") return "Folder";
  return k[0].toUpperCase() + k.slice(1);
}

function iconGlyph(entry) {
  switch (guessKind(entry)) {
    case "folder": return "📁";
    case "json":   return "{}";
    case "text":   return "T";
    default:       return "•";
  }
}

function formatJson(v) {
  if (v === undefined) return "";
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function truncEtag(etag) {
  if (!etag) return "—";
  return etag.length > 14 ? etag.slice(0, 14) + "…" : etag;
}

function safeFilename(key) {
  return (key || "entry").replace(/[\/\\:*?"<>|]+/g, "_");
}

// ─────────────────────────────────────────────────────────────────────
init().catch((e) => {
  console.error("[finder] init failed:", e);
  toast(`Init failed: ${e?.message || e}`, "err");
});
