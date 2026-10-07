// Builder tab: choose and order content per resume preset, live preview, download.
import { store, refresh, find, onBankChange } from "./app.js";
import {
  el, POST, PUT, DEL, fail, toast, counter, updateCounter, visibleLen, MAX_CHARS,
  promptDialog, confirmDialog, debounce, saveBlob, lsGet, lsSet,
} from "./util.js";
import { openJobDialog } from "./jobs.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/static/vendor/pdf.worker.min.js";

let root, treeEl, hintsEl, previewEl, pagePill, presetSel, dirtyEl, formatSel;
let presetId = null;   // saved preset being edited (null = unsaved)
let work = null;       // working tree: [{id, on, entries:[{id,on,bullets:[{id,on}]}], skills:Set}]
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
        skills: sec.kind === "skills" ? sec.groups.flatMap((g) => g.skills.map((k) => k.id)).filter((k) => s.skills.has(k)) : [],
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
      body.append(el("div.chips", g.skills.map((k) => {
        const chip = el("span.chip", { class: s.skills.has(k.id) ? "on" : "off" }, k.name);
        chip.addEventListener("click", () => {
          s.skills.has(k.id) ? s.skills.delete(k.id) : s.skills.add(k.id);
          chip.className = "chip " + (s.skills.has(k.id) ? "on" : "off");
          updateCount();
          changed();
        });
        return chip;
      })));
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
  const cc = counter(bank.text);
  const text = el("div.btext", { contenteditable: "plaintext-only", spellcheck: "true" }, bank.text);
  if (text.contentEditable !== "plaintext-only") text.contentEditable = "true";
  text.addEventListener("input", () => updateCounter(cc, text.textContent));
  text.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); text.blur(); } });
  text.addEventListener("blur", () => saveBulletText(bank, text.textContent.replace(/\s+/g, " ").trim()));
  const node = el("li.bul", { dataset: { id: b.id }, class: b.on ? "" : "off" },
    el("span.drag", "⋮⋮"),
    check(b.on, (v) => { b.on = v; node.classList.toggle("off", !v); changed(); }),
    el("div", { style: { flex: "1", minWidth: "0" } }, text, bank.note ? el("span.todo", bank.note) : null),
    cc);
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
  const hints = [];
  for (const s of work) {
    const sec = find.section(s.id);
    if (!s.on || sec.kind === "skills") continue;
    const kinds = new Set(sec.entries.map((e) => e.kind));
    if (kinds.has("job")) {
      const off = s.entries.filter((e) => !e.on && find.entry(e.id).kind === "job");
      if (off.length) hints.push([`${off.length} job${off.length > 1 ? "s" : ""} hidden in ${sec.title}. Keep every job to avoid gaps.`]);
    }
    if (kinds.has("project")) {
      const n = s.entries.filter((e) => e.on).length;
      if (n !== 2) hints.push([`${n} projects selected. Two that fit the role usually work best.`]);
    }
  }
  const over = [];
  for (const s of work) for (const e of s.entries) for (const b of e.bullets) {
    if (b.on && s.on && e.on && visibleLen(find.bullet(b.id).text) > MAX_CHARS) over.push(b);
  }
  if (over.length) hints.push([`${over.length} selected bullet${over.length > 1 ? "s are" : " is"} too long to fit on one line.`]);
  if (lastPageCount > 1) hints.push([`The PDF is ${lastPageCount} pages. Cut something to get back to one.`]);
  hintsEl.replaceChildren(...(hints.length
    ? hints.map(([t]) => el("div.hint", t))
    : [el("div.hint.ok", "Looks good: one page, every line under the limit.")]));
  if (format !== "pdf" && !hints.length) hintsEl.firstChild.textContent = "No issues found.";
}

// ---------- preview ----------

const schedulePreview = debounce(renderPreview, 900);

async function fetchRender(fmt, signal) {
  const res = await fetch("/api/render", {
    method: "POST", signal, headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config: toConfig(), format: fmt, name: presetName() }),
  });
  if (!res.ok) {
    let msg = res.statusText, log = "";
    try { const j = await res.json(); msg = j.error || msg; log = j.log || ""; } catch { /* not json */ }
    const err = new Error(msg); err.log = log; throw err;
  }
  return { blob: await res.blob(), filename: res.headers.get("X-Filename") || `resume.${fmt}`, pages: res.headers.get("X-Page-Count") };
}

async function renderPreview() {
  previewAbort?.abort();
  const ctrl = new AbortController();
  previewAbort = ctrl;
  setPill("Rendering…");
  const pfmt = format === "docx" ? "docx" : "pdf";
  // attached off-screen so docx-preview can measure text for tab stops
  const stage = el("div", { style: { position: "absolute", left: "-10000px", top: "0", width: "1000px" } });
  try {
    const { blob, pages } = await fetchRender(pfmt, ctrl.signal);
    if (ctrl.signal.aborted) return;
    document.body.append(stage);
    let pill;
    if (pfmt === "pdf") {
      const pdf = await pdfjsLib.getDocument({ data: await blob.arrayBuffer(), isEvalSupported: false }).promise;
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const vp = page.getViewport({ scale: 2 });
        const canvas = el("canvas", { width: vp.width, height: vp.height });
        await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
        stage.append(canvas);
      }
      lastPageCount = Number(pages) || pdf.numPages;
      pill = [lastPageCount === 1 ? "1 page" : `${lastPageCount} pages`, lastPageCount === 1 ? "good" : "bad"];
    } else {
      await docx.renderAsync(blob, stage, null, { inWrapper: true, ignoreLastRenderedPageBreak: true, breakPages: true, experimental: true });
      alignTabs(stage); // experimental marks tabs as .docx-tab-stop; we then lay them out ourselves
      lastPageCount = null;
      pill = ["Word preview, approximate layout"];
    }
    if (ctrl.signal.aborted) return;
    previewEl.replaceChildren(...stage.childNodes);
    setPill(...pill);
    fitDocx();
    renderHints();
  } catch (err) {
    if (err.name === "AbortError" || ctrl.signal.aborted) return;
    setPill("Error", "bad");
    previewEl.replaceChildren(el("div.err", err.message + (err.log ? "\n\n" + err.log : "")));
  } finally {
    stage.remove();
  }
}

/**
 * Our .docx only uses one right-aligned tab per line (title<TAB>date). docx-preview doesn't lay those out
 * reliably, so split each such paragraph into left/right halves.
 */
function alignTabs(rootEl) {
  for (const tab of rootEl.querySelectorAll(".docx-tab-stop")) {
    const p = tab.closest("p");
    if (!p || !p.firstChild) continue;
    const after = document.createRange();
    after.setStartAfter(tab);
    after.setEndAfter(p.lastChild);
    const right = el("span", after.extractContents());
    const before = document.createRange();
    before.setStartBefore(p.firstChild);
    before.setEndBefore(tab);
    const left = el("span", before.extractContents());
    p.replaceChildren(left, right);
    Object.assign(p.style, { display: "flex", justifyContent: "space-between", gap: "12px" });
  }
}

/** Word pages render at true size (so tab stops work); scale them to fit the pane. */
function fitDocx() {
  // transform (not zoom) so text isn't re-laid out and lines don't re-wrap
  const wrap = previewEl.querySelector(".docx-wrapper");
  if (!wrap) return;
  let holder = wrap.parentElement;
  if (!holder.classList.contains("docx-holder")) {
    holder = el("div.docx-holder", { style: { overflow: "hidden" } });
    wrap.replaceWith(holder);
    holder.append(wrap);
  }
  Object.assign(wrap.style, { transform: "none", transformOrigin: "0 0", width: "max-content" });
  const avail = previewEl.clientWidth - 24;
  const scale = Math.min(1, avail / wrap.offsetWidth);
  wrap.style.transform = `scale(${scale})`;
  holder.style.height = wrap.offsetHeight * scale + "px";
}
window.addEventListener("resize", debounce(fitDocx, 150));

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
  hintsEl = el("div.card.hints");
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
