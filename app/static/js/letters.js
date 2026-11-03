// Cover Letter tab: paste a posting, pick and order paragraphs from the bank, write the "why", preview, download.
import { store, refresh, onBankChange } from "./app.js";
import {
  el, GET, POST, PUT, DEL, fail, toast, openDialog, promptDialog, confirmDialog, debounce, saveBlob, lsGet, lsSet,
} from "./util.js";
import { openJobDialog, jobLabel, STATUS_LABELS } from "./jobs.js";
import { renderDoc, fetchFile } from "./preview.js";

const FORMATS = { pdf: "PDF", docx: "Word (.docx)", tex: "LaTeX source (.tex)" };
const PLACEHOLDERS = ["{company}", "{role}", "{keyword1}", "{keyword2}", "{keyword3}", "{keywords}"];
const MAX_AUTO_KEYWORDS = 3;

let root, savedSel, dirtyEl, formatSel, previewEl, pill, hintsEl;
let jobEl, postingEl, keywordsEl, whyEl, blocksEl;
let letterId = null;  // saved letter being edited (null = unsaved draft)
let work = null;      // {company, role, posting, why, greeting, closing, keywords: [], blocks: [{id, on, text?}], autoSuggested}
let analysis = { terms: [], marks: [], suggested_blocks: [] };
let editingPosting = true;
let format = "pdf";
let dirty = false;
let previewAbort = null;
let unfilled = [];

// ---------- model ----------

const bankBlocks = () => store.letterBlocks.filter((b) => !b.archived);
const findBlock = (id) => store.letterBlocks.find((b) => b.id === id);
const currentLetter = () => store.letters.find((l) => l.id === letterId);
const letterName = () => currentLetter()?.name || "Untitled";

/** Config blocks first (in config order), then the rest of the bank unchecked; "why" goes second if missing. */
function buildWork(cfg = {}) {
  const live = new Map(bankBlocks().map((b) => [b.id, b]));
  const blocks = [];
  for (const c of cfg.blocks || []) {
    if (c.id === "why") blocks.push({ id: "why", on: true });
    else if (live.has(c.id)) { blocks.push({ id: c.id, on: true, text: c.text ?? null, fill: c.fill !== false }); live.delete(c.id); }
  }
  for (const b of live.values()) blocks.push({ id: b.id, on: !cfg.blocks, text: null, fill: true });  // brand-new letter: all on
  if (!blocks.some((b) => b.id === "why")) blocks.splice(Math.min(1, blocks.length), 0, { id: "why", on: true });
  return {
    company: cfg.company || "", role: cfg.role || "", posting: cfg.posting || "", why: cfg.why || "",
    greeting: cfg.greeting || "", closing: cfg.closing || "", keywords: [...(cfg.keywords || [])], blocks,
    autoSuggested: !!cfg.posting,
  };
}

function toConfig() {
  const { company, role, posting, why, greeting, closing, keywords } = work;
  return {
    company, role, posting, why, greeting, closing, keywords,
    blocks: work.blocks.filter((b) => b.on).map((b) => {
      if (b.id === "why") return { id: "why" };
      const out = { id: b.id };
      if (b.text != null) out.text = b.text;
      if (b.fill === false) out.fill = false;
      return out;
    }),
  };
}

function setDirty(v = true) {
  dirty = v;
  dirtyEl.hidden = !v;
  if (letterId == null) lsSet("letterDraft", JSON.stringify(toConfig()));
}

function changed() {
  setDirty(true);
  renderHints();
  schedulePreview();
}

// ---------- job + posting ----------

function input(value, placeholder, onInput, attrs = {}) {
  const i = el("input", { type: "text", value, placeholder, ...attrs });
  i.addEventListener("input", () => onInput(i.value));
  return i;
}

function renderJob() {
  jobEl.replaceChildren(
    el("h2", "The job"),
    el("div.fields",
      el("label.field", "Company", input(work.company, "e.g. Acme", (v) => { work.company = v; changed(); })),
      el("label.field", "Role title", input(work.role, "e.g. SOC Analyst", (v) => { work.role = v; changed(); }))),
    el("div.fields",
      el("label.field", "Greeting", input(work.greeting, `Dear ${work.company.trim() || "{company}"} Hiring Team,`, (v) => { work.greeting = v; changed(); })),
      el("label.field", "Sign-off", input(work.closing, "Sincerely,", (v) => { work.closing = v; changed(); }))));
}

const analyze = debounce(async () => {
  try {
    analysis = await POST("/api/letters/keywords", { posting: work.posting });
  } catch (e) { fail(e); return; }
  const mine = analysis.terms.filter((t) => t.have).map((t) => t.term);
  if (!work.keywords.length && mine.length) { work.keywords = mine.slice(0, MAX_AUTO_KEYWORDS); changed(); }
  if (!work.autoSuggested && work.posting.trim() && analysis.suggested_blocks.length) {
    work.autoSuggested = true;
    applySuggestions();
  }
  renderPosting();
  renderKeywords();
  renderBlocks();
}, 400);

function renderPosting() {
  const has = work.posting.trim().length > 0;
  let body;
  if (editingPosting || !has) {
    const ta = el("textarea", { rows: 7, value: work.posting, placeholder: "Paste the job posting here. Keywords it mentions are picked out below." });
    ta.addEventListener("input", () => { work.posting = ta.value; setDirty(true); analyze(); });
    ta.addEventListener("blur", () => { if (work.posting.trim()) { editingPosting = false; renderPosting(); } });
    body = ta;
  } else {
    const have = new Map(analysis.terms.map((t) => [t.term, t.have]));
    const parts = [];
    let pos = 0;
    for (const [a, b, term] of analysis.marks) {
      if (a < pos) continue;
      parts.push(work.posting.slice(pos, a));
      parts.push(el("mark.kw", { class: have.get(term) ? "have" : "gap", title: term }, work.posting.slice(a, b)));
      pos = b;
    }
    parts.push(work.posting.slice(pos));
    body = el("div.posting-view", { title: "Click to edit", on: { click: () => { editingPosting = true; renderPosting(); postingEl.querySelector("textarea")?.focus(); } } }, parts);
  }
  postingEl.replaceChildren(
    el("div.row", el("h2", "Job posting"), el("span.grow"),
      has && !editingPosting ? el("span.legend", el("mark.kw.have", "you have it"), el("mark.kw.gap", "not in your bank")) : null,
      has && !editingPosting ? el("button.btn.ghost.small", { type: "button", on: { click: () => { editingPosting = true; renderPosting(); } } }, "Edit") : null),
    body);
}

function renderKeywords() {
  const mine = analysis.terms.filter((t) => t.have).map((t) => t.term);
  const gaps = analysis.terms.filter((t) => !t.have).map((t) => t.term);
  const picked = el("div.chips.kw-picked", work.keywords.map((k, i) => el("span.chip.on", { dataset: { k } },
    el("b", `${i + 1} `), k,
    el("button.icon-btn", { type: "button", title: "Remove", on: { click: () => { work.keywords.splice(i, 1); renderKeywords(); changed(); } } }, "✕"))));
  Sortable.create(picked, {
    animation: 150, filter: "button", preventOnFilter: false,
    onEnd: () => { work.keywords = [...picked.children].map((n) => n.dataset.k); renderKeywords(); changed(); },
  });
  const add = el("input", { type: "text", placeholder: "Add a keyword, press Enter", style: { width: "200px" } });
  add.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    const v = add.value.trim();
    if (v && !work.keywords.includes(v)) { work.keywords.push(v); renderKeywords(); changed(); }
  });
  const offer = mine.filter((t) => !work.keywords.includes(t));
  keywordsEl.replaceChildren(
    el("h2", "Keywords"),
    el("div.muted.small", "Fill {keyword1}, {keyword2}… in this order, and {keywords} as a phrase. Drag to reorder."),
    work.keywords.length ? picked : el("div.muted.small.kw-none", "None picked yet."),
    offer.length ? el("div", el("div.group-label", "From the posting, and in your bank (click to add)"),
      el("div.chips", offer.map((t) => el("span.chip.off-add", { title: "Add", on: { click: () => { work.keywords.push(t); renderKeywords(); changed(); } } }, "+ " + t)))) : null,
    gaps.length ? el("div", el("div.group-label", "The posting wants these, but they're not in your skills or bullets"),
      el("div.chips", gaps.map((t) => el("span.chip.gap", { title: "Add it in Content if you have it, then it can fill placeholders" }, t)))) : null,
    el("div.row", { style: { marginTop: "6px" } }, add));
}

// ---------- why ----------

function renderWhy() {
  const ta = el("textarea", { rows: 3, value: work.why, placeholder: "1–3 sentences on why this company: their product, mission, a recent project, someone you talked to. This is the part recruiters notice." });
  ta.addEventListener("input", () => {
    work.why = ta.value;
    blocksEl.querySelector(".lblock.why")?.replaceWith(renderWhyRow());
    changed();
  });
  whyEl.replaceChildren(el("h2", "Why this company"), ta);
}

// ---------- paragraphs ----------

/** Paragraph text with {placeholders} marked. */
function withPlaceholders(text) {
  return text.split(/(\{[A-Za-z_][A-Za-z0-9_]*\})/).map((part, i) => (i % 2 ? el("span.ph", part) : part));
}

function applySuggestions() {
  const sug = new Set(analysis.suggested_blocks);
  for (const b of work.blocks) {
    if (b.id === "why") continue;
    if ((findBlock(b.id)?.tags || "").trim()) b.on = sug.has(b.id);
  }
  changed();
  renderBlocks();
}

function renderBlocks() {
  const sug = new Set(analysis.suggested_blocks);
  const list = el("div.letter-blocks");
  for (const b of work.blocks) list.append(b.id === "why" ? renderWhyRow() : renderBlockRow(b, sug.has(b.id)));
  Sortable.create(list, {
    handle: ".drag", animation: 150,
    onEnd: () => {
      const order = [...list.children].map((n) => (n.dataset.id === "why" ? "why" : Number(n.dataset.id)));
      work.blocks.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      changed();
    },
  });
  const empty = !store.letterBlocks.length;
  blocksEl.replaceChildren(
    el("div.row", el("h2", "Paragraphs"), el("span.grow"),
      sug.size ? el("button.btn.small", { type: "button", title: "Check the tagged paragraphs that match this posting", on: { click: applySuggestions } }, "Use suggested") : null,
      el("button.btn.small", { type: "button", on: { click: () => editBlock() } }, "+ New paragraph")),
    el("div.muted.small", "Check, uncheck and drag. Click a paragraph to change it for this letter only. Placeholders: ",
      PLACEHOLDERS.map((p) => el("span.ph", p)).reduce((a, n) => [...a, a.length ? " " : "", n], [])),
    empty
      ? el("div.empty-blocks",
        el("p", "No paragraphs yet. Start from three editable examples (opener, experience, closing), or write your own."),
        el("button.btn.primary", { type: "button", on: { click: addStarter } }, "Add starter paragraphs"))
      : list);
}

function renderWhyRow() {
  const has = work.why.trim().length > 0;
  return el("div.lblock.why", { dataset: { id: "why" } },
    el("span.drag", { title: "Drag to reorder" }, "⋮⋮"),
    el("span.why-mark", "★"),
    el("div.lbody",
      el("div.lhead", el("b", "Why this company"), el("span.tag", "written above")),
      el("div.ltext", { class: has ? "" : "muted" }, has ? withPlaceholders(work.why) : "Empty. Write it in the box above.")));
}

/** "a" / "a and b" / "a, b, and c", matching the server's {keywords}. */
function phrase(items) {
  items = items.filter(Boolean);
  return items.length <= 2 ? items.join(" and ") : `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

const KEYWORD_PH = /\{(keywords|keyword\d+)\}/gi;

/** Put the current keywords into a paragraph as plain text, leaving any placeholder without a keyword. */
function fillKeywords(text) {
  return text.replace(KEYWORD_PH, (m, name) => {
    name = name.toLowerCase();
    const v = name === "keywords" ? phrase(work.keywords) : work.keywords[Number(name.slice(7)) - 1];
    return v || m;
  });
}

/**
 * Fill in keywords off: the keywords currently in the paragraph become plain text you can reword,
 * and later keyword changes leave it alone. On again: back to the placeholders if you didn't change it.
 */
function setFill(b, on) {
  const bank = findBlock(b.id);
  if (!on) {
    const src = b.text ?? bank.text;
    const filled = fillKeywords(src);
    if (filled !== src) { b.text = filled; b.autoText = filled; }
  } else {
    if (b.autoText != null && b.text === b.autoText) b.text = null;
    delete b.autoText;
  }
  b.fill = on;
  renderBlocks();
  changed();
}

function renderBlockRow(b, suggested) {
  const bank = findBlock(b.id);
  const overridden = b.text != null;
  const node = el("div.lblock", { dataset: { id: b.id }, class: b.on ? "" : "off" });
  const box = el("input", { type: "checkbox", checked: b.on, on: { change: (e) => { b.on = e.target.checked; node.classList.toggle("off", !b.on); changed(); } } });
  const textEl = el("div.ltext", { title: "Click to edit for this letter only" }, withPlaceholders(overridden ? b.text : bank.text));
  textEl.addEventListener("click", () => {
    const ta = el("textarea", { rows: 4, value: overridden ? b.text : bank.text });
    const done = () => {
      const v = ta.value.trim();
      b.text = !v || v === bank.text ? null : v;
      renderBlocks();
      changed();
    };
    ta.addEventListener("blur", done);
    ta.addEventListener("keydown", (ev) => { if (ev.key === "Escape") { ta.value = overridden ? b.text : bank.text; ta.blur(); } });
    textEl.replaceWith(ta);
    ta.focus();
  });
  node.append(
    el("span.drag", { title: "Drag to reorder" }, "⋮⋮"),
    box,
    el("div.lbody",
      el("div.lhead",
        el("b", bank.label || "(no name)"),
        bank.tags ? el("span.tag", { title: "Tags" }, bank.tags) : null,
        suggested ? el("span.tag.sug", "fits posting") : null,
        overridden ? el("span.tag.edited", "edited for this letter") : null,
        el("span.grow"),
        el("label.check.small.fill-toggle", { title: b.fill === false
          ? "Off: you write the keywords yourself. Click the text to edit it."
          : "On: {keyword1}, {keywords}… fill from the Keywords list" },
          el("input", { type: "checkbox", checked: b.fill !== false, on: { change: (e) => setFill(b, e.target.checked) } }),
          "Fill in keywords"),
        overridden ? el("button.btn.ghost.small", { type: "button", title: "Make this the version every letter uses",
          on: { click: () => saveOverrideToBank(b) } }, "Save to bank") : null,
        overridden ? el("button.btn.ghost.small", { type: "button", title: "Go back to the bank version",
          on: { click: () => { b.text = null; renderBlocks(); changed(); } } }, "Reset") : null,
        el("button.icon-btn", { type: "button", title: "Edit in the bank (every letter)", on: { click: () => editBlock(bank) } }, "✎")),
      textEl));
  return node;
}

async function addStarter() {
  try {
    await POST("/api/letter-blocks/starter");
    await refresh();
    for (const b of work.blocks) b.on = true;
    renderBlocks();
    changed();
    toast("Added three example paragraphs. Edit them to sound like you.");
  } catch (e) { fail(e); }
}

async function saveOverrideToBank(b) {
  const choice = await openDialog((form, close) => {
    form.append(
      el("h3", "Save to bank"),
      el("p.sub", "Replace the bank version (every letter that uses it changes), or keep both by adding this as a new paragraph?"),
      el("div.actions",
        el("button.btn", { type: "button", on: { click: () => close(null) } }, "Cancel"),
        el("button.btn", { type: "button", on: { click: () => close("new") } }, "Add as new"),
        el("button.btn.primary", { type: "submit" }, "Replace")));
    form.addEventListener("submit", () => close("replace"));
  });
  if (!choice) return;
  try {
    const bank = findBlock(b.id);
    if (choice === "replace") {
      await PUT(`/api/letter-blocks/${b.id}`, { text: b.text });
      b.text = null;
    } else {
      const { id } = await POST("/api/letter-blocks", { label: `${bank.label} (${work.company || "copy"})`, text: b.text, tags: bank.tags });
      const i = work.blocks.indexOf(b);
      b.on = false;
      b.text = null;
      work.blocks.splice(i, 0, { id, on: true, text: null });
    }
    await refresh({ notify: false });
    renderBlocks();
    changed();
    toast("Saved to the paragraph bank");
  } catch (e) { fail(e); }
}

/** Add (no arg) or edit a bank paragraph: name, text, tags; archive or delete. */
async function editBlock(bank = null) {
  const res = await openDialog((form, close) => {
    const label = el("input", { type: "text", value: bank?.label || "", placeholder: "e.g. SOC internship story" });
    const text = el("textarea", { rows: 6, value: bank?.text || "", placeholder: "Paragraph text. Use {company}, {role}, {keyword1}, {keywords}." });
    const tags = el("input", { type: "text", value: bank?.tags || "", placeholder: "e.g. incident response, SIEM" });
    form.append(
      el("h3", bank ? "Edit paragraph" : "New paragraph"),
      bank ? el("p.sub", "Changes here apply to every letter that uses it.") : null,
      el("label.field", "Name (only you see it)", label),
      el("label.field", "Text", text),
      el("label.field", "Tags: when a posting mentions one, this paragraph is suggested", tags),
      el("div.actions",
        bank ? el("button.btn.ghost.danger", { type: "button", on: { click: () => close({ del: true }) } }, "Delete") : null,
        bank ? el("button.btn.ghost", { type: "button", on: { click: () => close({ archive: !bank.archived }) } }, bank.archived ? "Restore" : "Archive") : null,
        el("span.grow"),
        el("button.btn", { type: "button", on: { click: () => close(null) } }, "Cancel"),
        el("button.btn.primary", { type: "submit" }, bank ? "Save" : "Add")));
    form.addEventListener("submit", () => {
      if (!text.value.trim()) return text.focus();
      close({ label: label.value.trim(), text: text.value.trim(), tags: tags.value.trim() });
    });
  });
  if (!res) return;
  try {
    if (res.del) {
      const used = store.letters.filter((l) => (l.config.blocks || []).some((x) => x.id === bank.id)).map((l) => l.name);
      if (!(await confirmDialog(`Delete "${bank.label || "this paragraph"}"?`,
        used.length ? `Used in: ${used.join(", ")}. It will be removed from them. Archive it instead to keep it.` : "Archive it instead if you might want it later."))) return;
      await DEL(`/api/letter-blocks/${bank.id}`);
      work.blocks = work.blocks.filter((b) => b.id !== bank.id);
    } else if ("archive" in res) {
      await PUT(`/api/letter-blocks/${bank.id}`, { archived: res.archive });
      if (res.archive) work.blocks = work.blocks.filter((b) => b.id !== bank.id);
    } else if (bank) {
      await PUT(`/api/letter-blocks/${bank.id}`, res);
    } else {
      const { id } = await POST("/api/letter-blocks", res);
      work.blocks.push({ id, on: true, text: null });
    }
    await refresh();
    analyze();
  } catch (e) { fail(e); }
}

// ---------- hints ----------

function renderHints() {
  const hints = [];
  if (!work.company.trim()) hints.push("Add the company name.");
  if (!work.why.trim()) hints.push("\"Why this company\" is empty. A sentence or two here makes the letter yours.");
  if (unfilled.length) hints.push(`Couldn't fill ${unfilled.join(", ")}. Pick more keywords, or edit the paragraph.`);
  hintsEl.hidden = !hints.length;
  hintsEl.replaceChildren(...hints.map((t) => el("div.hint", t)));
}

// ---------- preview ----------

const schedulePreview = debounce(renderPreview, 900);

function fetchRender(fmt, signal) {
  return fetchFile("/api/render-letter", { config: toConfig(), format: fmt }, `CoverLetter.${fmt}`, signal);
}

function setPill(text, kind = "") {
  pill.textContent = text;
  pill.className = "status-pill " + kind;
}

async function renderPreview() {
  if (root.closest("section").hidden) return;  // drawn when the tab opens
  previewAbort?.abort();
  const ctrl = new AbortController();
  previewAbort = ctrl;
  setPill("Rendering…");
  const pfmt = format === "docx" ? "docx" : "pdf";
  try {
    const { blob, pages, headers } = await fetchRender(pfmt, ctrl.signal);
    if (ctrl.signal.aborted) return;
    unfilled = (headers.get("X-Unfilled") || "").split(",").filter(Boolean);
    const n = await renderDoc(previewEl, blob, pfmt, () => ctrl.signal.aborted);
    if (n === undefined) return;
    if (pfmt === "pdf") {
      const count = Number(pages) || n;
      setPill(count === 1 ? "1 page" : `${count} pages`, count === 1 ? "good" : "bad");
    } else setPill("Word preview, approximate layout");
    renderHints();
  } catch (err) {
    if (err.name === "AbortError" || ctrl.signal.aborted) return;
    setPill("Error", "bad");
    previewEl.replaceChildren(el("div.err", err.message + (err.log ? "\n\n" + err.log : "")));
  }
}

// ---------- saved letters ----------

function renderSavedOptions() {
  savedSel.replaceChildren(
    ...store.letters.map((l) => el("option", { value: l.id, selected: l.id === letterId }, l.name)),
    letterId == null ? el("option", { value: "", selected: true }, "Untitled (unsaved)") : null);
}

function load(id, cfg = null) {
  const l = store.letters.find((x) => x.id === id) || null;
  letterId = l?.id ?? null;
  work = buildWork(cfg || l?.config || {});
  format = l?.format || lsGet("letterFormat", "pdf");
  formatSel.value = format;
  lsSet("letter", l ? String(l.id) : "");
  editingPosting = !work.posting.trim();
  analysis = { terms: [], marks: [], suggested_blocks: [] };
  unfilled = [];
  dirty = false;
  dirtyEl.hidden = true;
  renderAll();
  if (work.posting.trim()) analyze();
  schedulePreview();
}

function renderAll() {
  renderSavedOptions();
  renderJob();
  renderPosting();
  renderKeywords();
  renderWhy();
  renderBlocks();
  renderHints();
}

async function confirmDiscard() {
  if (!dirty || letterId == null && !work.company && !work.why) return true;
  return confirmDialog("Discard unsaved changes?", `Your changes to "${letterName()}" haven't been saved.`, "Discard");
}

/** Start the next letter: same paragraph picks and order, job details cleared. */
async function newLetter() {
  if (!(await confirmDiscard())) return;
  const keep = toConfig();
  load(null, { blocks: keep.blocks.filter((b) => b.id === "why" || findBlock(b.id)), greeting: "", closing: keep.closing });
  setDirty(false);
  jobEl.querySelector("input")?.focus();
}

async function save() {
  if (letterId == null) return saveAs();
  try {
    await PUT(`/api/letters/${letterId}`, { config: toConfig(), format: format === "tex" ? "pdf" : format });
    await refresh({ notify: false });
    setDirty(false);
    toast(`Saved "${letterName()}"`);
  } catch (err) { fail(err); }
}

async function saveAs() {
  const guess = [work.company, work.role].filter(Boolean).join(" ") || (letterId ? `${letterName()} copy` : "");
  const name = await promptDialog("Save letter", "Name (e.g. Acme SOC)", guess);
  if (!name) return;
  try {
    const { id } = await POST("/api/letters", { name, config: toConfig(), format: format === "tex" ? "pdf" : format });
    await refresh({ notify: false });
    letterId = id;
    lsSet("letter", String(id));
    lsSet("letterDraft", "");
    setDirty(false);
    renderSavedOptions();
    toast(`Saved "${name}"`);
  } catch (err) { fail(err); }
}

async function rename() {
  if (letterId == null) return saveAs();
  const name = await promptDialog("Rename letter", "Name", letterName(), "Rename");
  if (!name) return;
  try {
    await PUT(`/api/letters/${letterId}`, { name });
    await refresh({ notify: false });
    renderSavedOptions();
  } catch (err) { fail(err); }
}

async function remove() {
  if (letterId == null) return;
  if (!(await confirmDialog(`Delete "${letterName()}"?`, "Only this saved letter is deleted. Your paragraphs stay in the bank, and copies already sent stay with their jobs."))) return;
  try {
    await DEL(`/api/letters/${letterId}`);
    await refresh({ notify: false });
    load(store.letters[0]?.id ?? null);
  } catch (err) { fail(err); }
}

// ---------- download + link to jobs ----------

async function download(btn) {
  if (!work.why.trim() && !(await confirmDialog("Download without a \"why this company\" part?",
    "It's the sentence or two that shows you picked this company on purpose.", "Download anyway", false, "Go back"))) return;
  btn.disabled = true;
  try {
    const { blob, filename } = await fetchRender(format);
    saveBlob(blob, filename);
    if (format !== "tex") await linkToJobs(blob, filename);
  } catch (err) {
    fail(err);
  } finally {
    btn.disabled = false;
  }
}

/** After a download: tick the jobs this letter went with, and keep a copy with each. */
async function linkToJobs(blob, filename) {
  let jobs;
  try { jobs = await GET("/api/jobs"); } catch (e) { return fail(e); }
  const applied = (j) => j.status !== "not_applied";
  jobs.sort((a, b) => applied(b) - applied(a));
  const company = work.company.trim().toLowerCase();
  const picked = new Set(company ? jobs.filter((j) => j.company.trim().toLowerCase() === company && !j.cover_letter).map((j) => j.id) : []);

  let ids;
  for (;;) {  // the dialog element is shared, so "+ New job" closes this picker, opens the job form, then comes back
    ids = await pickJobs(jobs, picked, filename);
    if (ids !== "new") break;
    const saved = await openJobDialog({ prefill: { company: work.company.trim(), role: work.role.trim() } });
    if (saved) { jobs.unshift(saved); picked.add(saved.id); }
  }
  if (!ids?.length) return;
  try {
    for (const id of ids) {
      const fd = new FormData();
      fd.append("letter", blob, filename);
      fd.append("letter_name", letterId != null ? letterName() : [work.company, work.role].filter(Boolean).join(" "));
      await POST(`/api/jobs/${id}/letter`, fd);
    }
    toast(ids.length === 1 ? "Cover letter added to that application" : `Cover letter added to ${ids.length} applications`);
  } catch (e) { fail(e); }
}

function pickJobs(jobs, picked, filename) {
  return openDialog((form, close) => {
    const search = el("input", { type: "text", placeholder: "Search company or role" });
    const list = el("div.job-pick");
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      const rows = jobs.filter((j) => !q || `${j.company} ${j.role}`.toLowerCase().includes(q));
      list.replaceChildren(...(rows.length ? rows.map((j) => el("label.job-pick-row",
        el("input", { type: "checkbox", checked: picked.has(j.id), on: { change: (e) => (e.target.checked ? picked.add(j.id) : picked.delete(j.id)) } }),
        el("span.grow", el("b", jobLabel(j))),
        j.cover_letter ? el("span.tag", { title: "Already has a cover letter; this one replaces the saved copy" }, "✓ letter") : null,
        el("span.status-pill", { class: `st-${j.status}` }, STATUS_LABELS[j.status])))
        : [el("div.muted.small", jobs.length ? "No jobs match." : "No jobs yet. Add one below.")]));
    };
    search.addEventListener("input", draw);
    draw();
    form.append(
      el("h3", "Which application is this for?"),
      el("p.sub", `Downloaded ${filename}. Check the job(s) it went with: they get a cover-letter tick and a saved copy.`),
      jobs.length > 6 ? search : null,
      list,
      el("div.row", el("button.btn.ghost.small", { type: "button", on: { click: () => close("new") } }, "+ New job")),
      el("div.actions",
        el("button.btn", { type: "button", on: { click: () => close(null) } }, "Skip"),
        el("button.btn.primary", { type: "submit" }, "Save")));
    form.addEventListener("submit", () => close([...picked]));
  });
}

// ---------- tab ----------

export function init(node) {
  root = node;
  savedSel = el("select", { "aria-label": "Saved letter", on: { change: async () => {
    const want = Number(savedSel.value) || null;
    if (await confirmDiscard()) load(want); else renderSavedOptions();
  } } });
  dirtyEl = el("span.dirty-dot", { hidden: true }, "● unsaved");
  formatSel = el("select", { "aria-label": "Format", on: { change: () => { format = formatSel.value; lsSet("letterFormat", format); changed(); } } },
    Object.entries(FORMATS).map(([v, l]) => el("option", { value: v }, l)));
  previewEl = el("div.preview", el("div.loading", "Loading preview…"));
  pill = el("span.status-pill", "…");
  hintsEl = el("div.card.hints", { hidden: true });
  jobEl = el("div.card.lcard");
  postingEl = el("div.card.lcard");
  keywordsEl = el("div.card.lcard");
  whyEl = el("div.card.lcard");
  blocksEl = el("div.card.lcard");
  const dlBtn = el("button.btn.primary", { type: "button" }, "Download");
  dlBtn.addEventListener("click", () => download(dlBtn));

  root.append(el("div.builder.letters",
    el("div.builder-left",
      el("div.card.preset-bar",
        savedSel,
        el("button.btn", { type: "button", title: "Start the next letter with the same paragraphs", on: { click: newLetter } }, "New letter"),
        el("button.btn", { type: "button", on: { click: save } }, "Save"),
        el("button.btn", { type: "button", on: { click: saveAs } }, "Save as…"),
        el("button.btn.ghost", { type: "button", on: { click: rename } }, "Rename"),
        el("button.btn.ghost.danger", { type: "button", on: { click: remove } }, "Delete"),
        dirtyEl),
      hintsEl, jobEl, postingEl, keywordsEl, whyEl, blocksEl),
    el("div.preview-pane",
      el("div.card.preview-bar", pill, el("span.grow"), formatSel, dlBtn),
      previewEl)));

  window.addEventListener("beforeunload", (e) => { if (dirty && letterId != null) e.preventDefault(); });

  onBankChange(() => {
    // keep the letter in progress, pick up added/edited/deleted paragraphs and profile changes
    if (!work) return;
    work = { ...buildWork(toConfig()), autoSuggested: work.autoSuggested };
    renderBlocks();
    schedulePreview();
    if (work.posting.trim()) analyze();  // a skill or bullet added in Content can turn a pink keyword green
  });

  const remembered = Number(lsGet("letter"));
  if (store.letters.some((l) => l.id === remembered)) return load(remembered);
  let draft = null;
  try { draft = JSON.parse(lsGet("letterDraft") || "null"); } catch { /* ignore */ }
  load(null, draft);
}

export function show() {
  schedulePreview();
}
