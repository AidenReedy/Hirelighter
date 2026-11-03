// Resume tab (internally "builder"): choose and order content per resume preset, live preview, download.
import { store, refresh, find, onBankChange } from "./app.js";
import {
  el, POST, PUT, DEL, fail, toast,
  promptDialog, confirmDialog, debounce, saveBlob, lsGet, lsSet,
} from "./util.js";
import { openJobDialog } from "./jobs.js";
import { renderDoc, fetchFile } from "./preview.js";

let root, treeEl, hintsEl, previewEl, pagePill, presetSel, dirtyEl, formatSel;
let presetId = null;   // saved preset being edited (null = unsaved)
let work = null;       // working tree: [{id, on, entries:[{id,on,bullets:[{id,on}]}], skills:Set, skillOrder:Map<groupId, skillId[]>}]
let skillsLayout = "inline";
let format = "pdf";
let dirty = false;
let previewAbort = null;
let lastPageCount = null;

const FORMATS = { pdf: "PDF", docx: "Word (.docx)", tex: "LaTeX source (.tex)" };

// ---------- model ----------

/** Items included by the config first (in config order), then the rest of the bank (unchecked). */
function ordered(bankItems, cfgItems, idOf = (x) => x.id) {
  const byId = new Map(bankItems.map((b) => [b.id, b]));
  const out = [];
  for (const c of cfgItems || []) {
    const id = idOf(c);
    if (byId.has(id)) { out.push({ item: byId.get(id), cfg: c, on: true }); byId.delete(id); }
  }
  for (const b of bankItems) if (byId.has(b.id)) out.push({ item: b, cfg: null, on: false });
  return out;
}

function buildWork(config) {
  skillsLayout = config.skills_layout || "inline";
  return ordered(store.bank.sections, config.sections).map(({ item: s, cfg, on }) => ({
    id: s.id,
    on,
    entries: ordered(s.entries, cfg?.entries).map(({ item: e, cfg: ce, on: eon }) => ({
      id: e.id,
      on: eon,
      bullets: ordered(e.bullets.filter((b) => !b.archived), ce?.bullets, (x) => x)
        .map(({ item: b, on: bon }) => ({ id: b.id, on: bon })),
    })),
    skills: new Set(cfg?.skills || []),
    skillOrder: new Map((s.groups || []).map((g) => [g.id, ordered(g.skills, cfg?.skills, (x) => x).map(({ item }) => item.id)])),
  }));
}

function toConfig() {
  return {
    skills_layout: skillsLayout,
    sections: work.filter((s) => s.on).map((s) => {
      const sec = find.section(s.id);
      return {
        id: s.id,
        entries: s.entries.filter((e) => e.on).map((e) => ({ id: e.id, bullets: e.bullets.filter((b) => b.on).map((b) => b.id) })),
        skills: sec.kind === "skills" ? sec.groups.flatMap((g) => s.skillOrder.get(g.id) || []).filter((k) => s.skills.has(k)) : [],
      };
    }),
  };
}

const currentPreset = () => store.resumes.find((r) => r.id === presetId);
const presetName = () => currentPreset()?.name || "Untitled";

function setDirty(v = true) {
  dirty = v;
  dirtyEl.hidden = !v;
}

function changed() {
  setDirty(true);
  renderHints();
  schedulePreview();
}

// ---------- tree ----------

function renderTree() {
  treeEl.replaceChildren(...work.map(renderSection));
  Sortable.create(treeEl, {
    handle: ".sec-head > .drag", animation: 150,
    onEnd: () => { reorderFromDom(treeEl, work); changed(); },
  });
}

function reorderFromDom(container, arr) {
  const ids = [...container.children].map((n) => Number(n.dataset.id));
  arr.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
}

function check(on, onChange) {
  return el("input", { type: "checkbox", checked: on, on: { change: (e) => onChange(e.target.checked) } });
}

function renderSection(s) {
  const sec = find.section(s.id);
  const node = el("div.card.tree-sec", { dataset: { id: s.id }, class: s.on ? "" : "off" });
  const countEl = el("span.count");
  const updateCount = () => {
    if (sec.kind === "skills") countEl.textContent = `${s.skills.size} skills`;
    else countEl.textContent = `${s.entries.filter((e) => e.on).length}/${s.entries.length}`;
  };
  updateCount();
  node.append(el("div.sec-head",
    el("span.drag", { title: "Drag to reorder" }, "⋮⋮"),
    check(s.on, (v) => { s.on = v; node.classList.toggle("off", !v); changed(); }),
    el("span.title", sec.title),
    countEl));

  const body = el("div.sec-body");
  node.append(body);

  if (sec.kind === "skills") {
    for (const g of sec.groups) {
      body.append(el("div.group-label", g.name));
      const byId = new Map(g.skills.map((k) => [k.id, k]));
      const chips = el("div.chips", (s.skillOrder.get(g.id) || []).map((id) => byId.get(id)).filter(Boolean).map((k) => {
        const chip = el("span.chip", { dataset: { id: k.id }, class: s.skills.has(k.id) ? "on" : "off", title: "Click to toggle, drag to reorder" }, k.name);
        chip.addEventListener("click", () => {
          s.skills.has(k.id) ? s.skills.delete(k.id) : s.skills.add(k.id);
          chip.className = "chip " + (s.skills.has(k.id) ? "on" : "off");
          updateCount();
          changed();
        });
        return chip;
      }));
      body.append(chips);
      Sortable.create(chips, {
        animation: 150,
        onEnd: (ev) => {
          if (ev.oldIndex === ev.newIndex) return;
          s.skillOrder.set(g.id, [...chips.children].map((n) => Number(n.dataset.id)));
          changed();
        },
      });
    }
    if (!sec.groups.length) body.append(el("div.muted.small", { style: { paddingLeft: "22px" } }, "No skills yet. Add some in Content."));
    body.append(el("div.row.small", { style: { padding: "2px 0 0 22px" } },
      el("label.check", check(skillsLayout === "lines", (v) => { skillsLayout = v ? "lines" : "inline"; changed(); }),
        "One line per group")));
    return node;
  }

  const entriesEl = el("div.entries");
  for (const e of s.entries) entriesEl.append(renderEntry(e, updateCount));
  if (!s.entries.length) entriesEl.append(el("div.muted.small", { style: { paddingLeft: "22px" } }, "Nothing here yet. Add entries in Content."));
  body.append(entriesEl);
  Sortable.create(entriesEl, {
    handle: ".ent-head > .drag", animation: 150,
    onEnd: () => { reorderFromDom(entriesEl, s.entries); changed(); },
  });
  return node;
}

function entrySubtitle(e) {
  return [e.org, e.date].filter(Boolean).join(" · ").replace(/--/g, "–");
}

function renderEntry(e, updateCount) {
  const ent = find.entry(e.id);
  const node = el("div.ent", { dataset: { id: e.id }, class: e.on ? "" : "off" });
  node.append(el("div.ent-head",
    el("span.drag", { title: "Drag to reorder" }, "⋮⋮"),
    check(e.on, (v) => { e.on = v; node.classList.toggle("off", !v); updateCount(); changed(); }),
    el("span.t", ent.title || "(untitled)"),
    el("span.sub", entrySubtitle(ent))));

  const list = el("ul.bullets");
  for (const b of e.bullets) list.append(renderBullet(e, b));
  node.append(list);
  Sortable.create(list, {
    handle: ".drag", animation: 150,
    onEnd: () => { reorderFromDom(list, e.bullets); changed(); },
  });

  if (!["cert", "education"].includes(ent.kind) || ent.bullets.length) {
    node.append(el("div.add-row",
      el("button.btn.ghost.small", { type: "button", on: { click: () => addBullet(e, list) } }, "+ Add bullet")));
  }
  return node;
}

function renderBullet(e, b) {
  const bank = find.bullet(b.id);
  const text = el("div.btext", { contenteditable: "plaintext-only", spellcheck: "true" }, bank.text);
  if (text.contentEditable !== "plaintext-only") text.contentEditable = "true";
  text.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); text.blur(); } });
  text.addEventListener("blur", () => saveBulletText(bank, text.textContent.replace(/\s+/g, " ").trim()));
  const node = el("li.bul", { dataset: { id: b.id }, class: b.on ? "" : "off" },
    el("span.drag", "⋮⋮"),
    check(b.on, (v) => { b.on = v; node.classList.toggle("off", !v); changed(); }),
    el("div", { style: { flex: "1", minWidth: "0" } }, text, bank.note ? el("span.todo", bank.note) : null));
  return node;
}

async function saveBulletText(bank, value) {
  if (value === bank.text) return;
  if (!value) { toast("Bullet text can't be empty. Delete it in Content instead.", "error"); renderTree(); return; }
  try {
    await PUT(`/api/bullets/${bank.id}`, { text: value });
    bank.text = value;
    toast("Saved. This bullet is updated in every resume.");
    renderHints();
    schedulePreview();
  } catch (err) { fail(err); }
}

async function addBullet(e, list) {
  const text = await promptDialog("New bullet", "Bullet text. It's added to the bank and available to every resume.", "", "Add");
  if (!text) return;
  try {
    const { id } = await POST("/api/bullets", { entry_id: e.id, text });
    await refresh({ notify: false });
    e.bullets.push({ id, on: true });
    list.append(renderBullet(e, e.bullets.at(-1)));
    changed();
  } catch (err) { fail(err); }
}

// ---------- hints ----------

function renderHints() {
  // Only one warning: a resume that spills onto a second page.
  const over = format === "pdf" && lastPageCount > 1;
  hintsEl.hidden = !over;
  if (over) hintsEl.replaceChildren(el("div.hint", `The PDF is ${lastPageCount} pages. Cut something to get back to one.`));
}

// ---------- preview ----------

const schedulePreview = debounce(renderPreview, 900);

function fetchRender(fmt, signal) {
  return fetchFile("/api/render", { config: toConfig(), format: fmt, name: presetName() }, `resume.${fmt}`, signal);
}

async function renderPreview() {
  previewAbort?.abort();
  const ctrl = new AbortController();
  previewAbort = ctrl;
  setPill("Rendering…");
  const pfmt = format === "docx" ? "docx" : "pdf";
  try {
    const { blob, pages } = await fetchRender(pfmt, ctrl.signal);
    if (ctrl.signal.aborted) return;
    const n = await renderDoc(previewEl, blob, pfmt, () => ctrl.signal.aborted);
    if (n === undefined) return;
    if (pfmt === "pdf") {
      lastPageCount = Number(pages) || n;
      setPill(lastPageCount === 1 ? "1 page" : `${lastPageCount} pages`, lastPageCount === 1 ? "good" : "bad");
    } else {
      lastPageCount = null;
      setPill("Word preview, approximate layout");
    }
    renderHints();
  } catch (err) {
    if (err.name === "AbortError" || ctrl.signal.aborted) return;
    setPill("Error", "bad");
    previewEl.replaceChildren(el("div.err", err.message + (err.log ? "\n\n" + err.log : "")));
  }
}

function setPill(text, kind = "") {
  pagePill.textContent = text;
  pagePill.className = "status-pill " + kind;
}

// ---------- presets ----------

function renderPresetOptions() {
  presetSel.replaceChildren(
    ...store.resumes.map((r) => el("option", { value: r.id, selected: r.id === presetId }, r.name)),
    presetId == null ? el("option", { value: "", selected: true }, "Untitled (unsaved)") : null,
  );
}

function loadPreset(id) {
  const p = store.resumes.find((r) => r.id === id) || null;
  presetId = p?.id ?? null;
  work = buildWork(p?.config || { sections: [] });
  format = p?.format || "pdf";
  formatSel.value = format;
  if (p) lsSet("preset", String(p.id));
  setDirty(false);
  renderPresetOptions();
  renderTree();
  renderHints();
  renderPreview();
}

async function confirmDiscard() {
  if (!dirty) return true;
  return confirmDialog("Discard unsaved changes?", `Your changes to "${presetName()}" haven't been saved.`, "Discard");
}

async function save() {
  if (presetId == null) return saveAs();
  try {
    await PUT(`/api/resumes/${presetId}`, { config: toConfig(), format });
    await refresh({ notify: false });
    setDirty(false);
    toast(`Saved "${presetName()}"`);
  } catch (err) { fail(err); }
}

async function saveAs() {
  const name = await promptDialog("Save as new resume", "Name (e.g. Pentest, SOC: Company X)", presetId ? `${presetName()} copy` : "");
  if (!name) return;
  try {
    const { id } = await POST("/api/resumes", { name, config: toConfig(), format });
    await refresh({ notify: false });
    presetId = id;
    lsSet("preset", String(id));
    setDirty(false);
    renderPresetOptions();
    toast(`Saved "${name}"`);
  } catch (err) { fail(err); }
}

async function rename() {
  if (presetId == null) return saveAs();
  const name = await promptDialog("Rename resume", "Name", presetName(), "Rename");
  if (!name) return;
  try {
    await PUT(`/api/resumes/${presetId}`, { name });
    await refresh({ notify: false });
    renderPresetOptions();
  } catch (err) { fail(err); }
}

async function remove() {
  if (presetId == null) return;
  if (!(await confirmDialog(`Delete "${presetName()}"?`, "Only this saved selection is deleted. Your bullets stay in the bank."))) return;
  try {
    await DEL(`/api/resumes/${presetId}`);
    await refresh({ notify: false });
    loadPreset(store.resumes[0]?.id ?? null);
  } catch (err) { fail(err); }
}

// ---------- download ----------

async function download(btn) {
  btn.disabled = true;
  try {
    const { blob, filename } = await fetchRender(format);
    saveBlob(blob, filename);
    if (format === "tex") return;
    openJobDialog({ blob, filename, resumeId: presetId, resumeName: presetName(), fromDownload: true });
  } catch (err) {
    fail(err);
  } finally {
    btn.disabled = false;
  }
}

// ---------- tab ----------

export function init(node) {
  root = node;
  presetSel = el("select", { "aria-label": "Resume", on: { change: async () => {
    const want = Number(presetSel.value) || null;
    if (await confirmDiscard()) loadPreset(want); else renderPresetOptions();
  } } });
  dirtyEl = el("span.dirty-dot", { hidden: true }, "● unsaved");
  formatSel = el("select", { "aria-label": "Format", on: { change: () => { format = formatSel.value; changed(); } } },
    Object.entries(FORMATS).map(([v, l]) => el("option", { value: v }, l)));
  treeEl = el("div.tree", { style: { display: "flex", flexDirection: "column", gap: "12px" } });
  hintsEl = el("div.card.hints", { hidden: true });
  previewEl = el("div.preview", el("div.loading", "Loading preview…"));
  pagePill = el("span.status-pill", "…");
  const dlBtn = el("button.btn.primary", { type: "button" }, "Download");
  dlBtn.addEventListener("click", () => download(dlBtn));

  root.append(el("div.builder",
    el("div.builder-left",
      el("div.card.preset-bar",
        presetSel,
        el("button.btn", { type: "button", on: { click: save } }, "Save"),
        el("button.btn", { type: "button", on: { click: saveAs } }, "Save as…"),
        el("button.btn.ghost", { type: "button", on: { click: rename } }, "Rename"),
        el("button.btn.ghost.danger", { type: "button", on: { click: remove } }, "Delete"),
        dirtyEl),
      hintsEl,
      treeEl),
    el("div.preview-pane",
      el("div.card.preview-bar", pagePill, el("span.grow"), formatSel, dlBtn),
      previewEl)));

  window.addEventListener("beforeunload", (e) => { if (dirty) e.preventDefault(); });

  onBankChange(() => {
    // keep unsaved selections, pick up new/edited/deleted bank items
    if (!work) return;
    work = buildWork(toConfig());
    renderTree();
    renderHints();
    schedulePreview();
  });

  const remembered = Number(lsGet("preset"));
  loadPreset(store.resumes.some((r) => r.id === remembered) ? remembered : store.resumes[0]?.id ?? null);
}

export function show() {}
