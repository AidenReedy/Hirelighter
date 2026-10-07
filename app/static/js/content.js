// Content tab: create, edit, reorder, archive and delete everything in the bank.
import { store, refresh, presetsUsing } from "./app.js";
import { el, POST, PUT, DEL, fail, toast, promptDialog, confirmDialog, openDialog } from "./util.js";
import { importDialog } from "./setup.js";

let root;
const openEntries = new Set();
let showArchived = false;

const KIND_LABELS = { job: "Job / role", education: "Education", cert: "Certification", project: "Project", activity: "Activity / leadership" };

// Which fields each entry kind shows, with labels matching where they appear on the page.
const KIND_FIELDS = {
  job: [["title", "Role title"], ["date", "Dates"], ["org", "Company"], ["location", "Location"]],
  education: [["org", "School"], ["location", "Location"], ["title", "Degree"], ["date", "Dates"]],
  cert: [["title", "Certification"], ["date", "Date"]],
  project: [["title", "Project name"], ["date", "Dates"], ["tech", "Tech / tags (shown in italics)"]],
  activity: [["title", "Name / role"], ["date", "Dates"], ["tech", "Tags (shown in italics)"]],
};

async function reload() {
  const y = window.scrollY;
  await refresh();
  render();
  window.scrollTo(0, y);
}

async function run(fn, msg) {
  try {
    await fn();
    if (msg) toast(msg);
  } catch (e) { fail(e); }
}

function usedIn(kind, id) {
  const names = presetsUsing(kind, id);
  return names.length ? `Used in: ${names.join(", ")}. It will be removed from them.` : "Not used in any saved resume.";
}

/** Text input that saves on change. */
function liveInput(value, onSave, attrs = {}) {
  const input = el("input", { type: "text", value: value ?? "", ...attrs });
  input.addEventListener("change", () => run(() => onSave(input.value), "Saved"));
  return input;
}

// ---------- profile ----------

function renderProfile() {
  const p = structuredClone(store.bank.profile);
  const name = el("input", { type: "text", value: p.name });
  const list = el("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } });
  const draw = () => list.replaceChildren(...p.links.map((l, i) => el("div.row",
    el("input.grow", { type: "text", value: l.text, placeholder: "Shown text", on: { input: (e) => (l.text = e.target.value) } }),
    el("input.grow", { type: "text", value: l.url, placeholder: "Link (optional): https://, mailto:", on: { input: (e) => (l.url = e.target.value) } }),
    el("button.icon-btn", { type: "button", title: "Move up", on: { click: () => { if (i) { [p.links[i - 1], p.links[i]] = [p.links[i], p.links[i - 1]]; draw(); } } } }, "↑"),
    el("button.icon-btn.danger", { type: "button", title: "Remove", on: { click: () => { p.links.splice(i, 1); draw(); } } }, "✕"),
  )));
  draw();
  return el("div.card",
    el("div.sec-card-head", el("h2", "Header"), el("span.grow"),
      el("button.btn.primary.small", { type: "button", on: { click: () => run(async () => {
        await PUT("/api/profile", { name: name.value, links: p.links });
        await reload();
      }, "Header saved") } }, "Save header")),
    el("label.field", "Name", name),
    el("div.field.small", { style: { marginTop: "8px", color: "var(--ink-2)" } }, "Contact line (shown in this order, separated by |)"),
    list,
    el("div", { style: { marginTop: "6px" } },
      el("button.btn.ghost.small", { type: "button", on: { click: () => { p.links.push({ text: "", url: "" }); draw(); } } }, "+ Add contact item")));
}

// ---------- sections ----------

function renderSection(sec, idx, total) {
  const head = el("div.sec-card-head",
    el("span.drag", { title: "Drag to reorder" }, "⋮⋮"),
    liveInput(sec.title, (v) => PUT(`/api/sections/${sec.id}`, { title: v }).then(reload), { "aria-label": "Section title" }),
    el("span.tag", sec.kind === "skills" ? "Skills" : "Entries"),
    el("button.icon-btn.danger", { type: "button", title: "Delete section", on: { click: async () => {
      const n = sec.kind === "skills" ? sec.groups.length + " groups" : sec.entries.length + " entries";
      if (await confirmDialog(`Delete section "${sec.title}"?`, `This deletes the section and its ${n}. ${usedIn("section", sec.id)}`))
        run(async () => { await DEL(`/api/sections/${sec.id}`); await reload(); }, "Section deleted");
    } } }, "✕"));
  const card = el("div.card", { dataset: { id: sec.id } }, head);
  if (sec.kind === "skills") card.append(renderSkills(sec));
  else card.append(renderEntries(sec));
  return card;
}

// ---------- entries ----------

function renderEntries(sec) {
  const wrap = el("div");
  const list = el("div");
  for (const e of sec.entries) list.append(renderEntry(e));
  Sortable.create(list, {
    handle: "summary .drag", animation: 150,
    onEnd: () => run(async () => {
      await POST("/api/entries/reorder", { section_id: sec.id, ids: [...list.children].map((n) => Number(n.dataset.id)) });
      await refresh();
    }),
  });
  const guess = sec.entries[0]?.kind || "job";
  const kindSel = el("select", Object.entries(KIND_LABELS).map(([k, l]) => el("option", { value: k, selected: k === guess }, l)));
  wrap.append(list, el("div.row", { style: { marginTop: "8px" } },
    kindSel,
    el("button.btn.small", { type: "button", on: { click: () => run(async () => {
      const { id } = await POST("/api/entries", { section_id: sec.id, kind: kindSel.value, title: "" });
      openEntries.add(id);
      await reload();
      document.querySelector(`details[data-id="${id}"] input`)?.focus();
    }) } }, "+ Add entry")));
  return wrap;
}

function renderEntry(e) {
  const det = el("details.ent-card", { dataset: { id: e.id }, open: openEntries.has(e.id) });
  det.addEventListener("toggle", () => (det.open ? openEntries.add(e.id) : openEntries.delete(e.id)));
  const active = e.bullets.filter((b) => !b.archived).length;
  const titleEl = el("b", e.title || "(untitled)");
  const subEl = el("span.muted.small");
  const cur = { ...e };
  const updateSummary = () => {
    titleEl.textContent = cur.title || "(untitled)";
    subEl.textContent = [cur.org, cur.date?.replace(/--/g, "–")].filter(Boolean).join(" · ");
  };
  updateSummary();
  det.append(el("summary",
    el("span.drag", { title: "Drag to reorder" }, "⋮⋮"),
    titleEl,
    subEl,
    el("span.grow"),
    el("span.tag", KIND_LABELS[e.kind]),
    e.bullets.length ? el("span.tag", `${active} bullet${active === 1 ? "" : "s"}`) : null));

  const body = el("div.body");
  const kindSel = el("select", { on: { change: () => run(() => PUT(`/api/entries/${e.id}`, { kind: kindSel.value }).then(reload), "Saved") } },
    Object.entries(KIND_LABELS).map(([k, l]) => el("option", { value: k, selected: k === e.kind }, l)));
  body.append(el("div.fields",
    el("label.field", "Type", kindSel),
    ...KIND_FIELDS[e.kind].map(([f, label]) => el("label.field", label,
      liveInput(e[f], (v) => { cur[f] = v; updateSummary(); return PUT(`/api/entries/${e.id}`, { [f]: v }).then(() => refresh()); },
        { placeholder: f === "date" ? "e.g. Sep. 2025 -- Jun. 2026" : "" })))));
  body.append(el("div.muted.small", "Tip: type -- for a date-range dash. Wrap words in **double asterisks** to bold them."));
  body.append(renderBullets(e));
  body.append(el("div.row",
    el("span.grow"),
    el("button.btn.small.danger", { type: "button", on: { click: async () => {
      if (await confirmDialog(`Delete "${e.title || "this entry"}"?`, `Its ${e.bullets.length} bullets are deleted too. ${usedIn("entry", e.id)}`))
        run(async () => { await DEL(`/api/entries/${e.id}`); openEntries.delete(e.id); await reload(); }, "Entry deleted");
    } } }, "Delete entry")));
  det.append(body);
  return det;
}

// ---------- bullets ----------

function allEntries() {
  return store.bank.sections.filter((s) => s.kind === "entries")
    .flatMap((s) => s.entries.map((e) => ({ id: e.id, label: `${s.title} › ${e.title || "(untitled)"}` })));
}

function renderBullets(e) {
  const wrap = el("div.bank-bullets");
  const list = el("div.bank-bullets");
  const visible = e.bullets.filter((b) => showArchived || !b.archived);
  for (const b of visible) list.append(renderBullet(e, b));
  Sortable.create(list, {
    handle: ".drag", animation: 150,
    onEnd: () => run(async () => {
      const shown = [...list.children].map((n) => Number(n.dataset.id));
      const hidden = e.bullets.filter((b) => !shown.includes(b.id)).map((b) => b.id);
      await POST("/api/bullets/reorder", { entry_id: e.id, ids: [...shown, ...hidden] });
      await refresh();
    }),
  });
  const archivedCount = e.bullets.length - visible.length;
  wrap.append(
    el("div.row", el("b.small", "Bullets"), archivedCount ? el("span.muted.small", `(${archivedCount} archived hidden)`) : null),
    list,
    el("div.row",
      el("button.btn.small", { type: "button", on: { click: () => run(async () => {
        const text = await promptDialog("New bullet", "Bullet text", "", "Add");
        if (!text) return;
        await POST("/api/bullets", { entry_id: e.id, text });
        await reload();
      }) } }, "+ Add bullet")));
  return wrap;
}

function renderBullet(e, b) {
  const ta = el("textarea", { rows: 2, value: b.text });
  ta.addEventListener("change", () => {
    const v = ta.value.replace(/\s+/g, " ").trim();
    if (!v) { ta.value = b.text; return toast("Bullet text can't be empty", "error"); }
    run(async () => { await PUT(`/api/bullets/${b.id}`, { text: v }); await refresh(); }, "Saved");
  });
  const note = liveInput(b.note, (v) => PUT(`/api/bullets/${b.id}`, { note: v }).then(() => refresh()),
    { placeholder: "Private note (e.g. how the number was measured)", style: { flex: "1", minWidth: "160px" } });
  const move = el("select", { title: "Move to another entry" },
    el("option", { value: "" }, "Move to…"),
    allEntries().filter((x) => x.id !== e.id).map((x) => el("option", { value: x.id }, x.label)));
  move.addEventListener("change", () => move.value && run(async () => {
    await PUT(`/api/bullets/${b.id}`, { entry_id: Number(move.value) });
    await reload();
  }, "Bullet moved. Check it in your resumes."));
  return el("div.bank-bul", { dataset: { id: b.id }, class: b.archived ? "archived" : "" },
    el("span.drag", { title: "Drag to reorder" }, "⋮⋮"),
    el("div", ta, el("div.meta", note, move)),
    el("div", { style: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "4px" } },
      el("button.btn.ghost.small", { type: "button", title: b.archived ? "Show in the builder again" : "Hide from the builder but keep it here",
        on: { click: () => run(async () => { await PUT(`/api/bullets/${b.id}`, { archived: !b.archived }); await reload(); }, b.archived ? "Restored" : "Archived") } },
        b.archived ? "Restore" : "Archive"),
      el("button.btn.ghost.small.danger", { type: "button", on: { click: async () => {
        if (await confirmDialog("Delete this bullet?", `"${b.text}"\n\n${usedIn("bullet", b.id)} Archive it instead if you might want it later.`))
          run(async () => { await DEL(`/api/bullets/${b.id}`); await reload(); }, "Bullet deleted");
      } } }, "Delete")));
}

// ---------- skills ----------

function renderSkills(sec) {
  const wrap = el("div");
  const groups = el("div");
  for (const g of sec.groups) groups.append(renderGroup(g));
  Sortable.create(groups, {
    handle: ".drag", animation: 150, draggable: ".skill-group",
    onEnd: () => run(async () => {
      await POST("/api/skill-groups/reorder", { section_id: sec.id, ids: [...groups.children].map((n) => Number(n.dataset.id)) });
      await refresh();
    }),
  });
  wrap.append(
    el("div.muted.small", "Only list tools your bullets back up. Pick which skills show on each resume in the Builder."),
    groups,
    el("button.btn.small", { type: "button", on: { click: () => run(async () => {
      const name = await promptDialog("New skill group", "Group name (e.g. Frameworks, Cloud)", "", "Add");
      if (!name) return;
      await POST("/api/skill-groups", { section_id: sec.id, name });
      await reload();
    }) } }, "+ Add group"));
  return wrap;
}

function renderGroup(g) {
  const chips = el("div");
  for (const k of g.skills) {
    const name = el("span", { contenteditable: "true", spellcheck: "false" }, k.name);
    name.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); name.blur(); } });
    name.addEventListener("blur", () => {
      const v = name.textContent.trim();
      if (v && v !== k.name) run(async () => { await PUT(`/api/skills/${k.id}`, { name: v }); await refresh(); }, "Saved");
      else name.textContent = k.name;
    });
    chips.append(el("span.skill-chip", { dataset: { id: k.id } }, name,
      el("button.icon-btn.danger", { type: "button", title: "Delete skill", on: { click: async () => {
        const used = presetsUsing("skill", k.id);
        if (!used.length || await confirmDialog(`Delete "${k.name}"?`, usedIn("skill", k.id)))
          run(async () => { await DEL(`/api/skills/${k.id}`); await reload(); });
      } } }, "✕")));
  }
  Sortable.create(chips, {
    animation: 150, filter: "[contenteditable], button", preventOnFilter: false,
    onEnd: () => run(async () => {
      await POST("/api/skills/reorder", { group_id: g.id, ids: [...chips.children].map((n) => Number(n.dataset.id)) });
      await refresh();
    }),
  });
  const add = el("input", { type: "text", placeholder: "Add skill, press Enter", style: { width: "180px" } });
  add.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    const names = add.value.split(",").map((s) => s.trim()).filter(Boolean);
    if (!names.length) return;
    run(async () => {
      for (const name of names) await POST("/api/skills", { group_id: g.id, name });
      await reload();
      document.querySelector(`.skill-group[data-id="${g.id}"] input`)?.focus();
    });
  });
  return el("div.skill-group", { dataset: { id: g.id } },
    el("div.row",
      el("span.drag", "⋮⋮"),
      liveInput(g.name, (v) => PUT(`/api/skill-groups/${g.id}`, { name: v }).then(() => refresh()), { style: { fontWeight: "600" } }),
      el("span.grow"),
      el("button.icon-btn.danger", { type: "button", title: "Delete group", on: { click: async () => {
        if (await confirmDialog(`Delete group "${g.name}"?`, `Its ${g.skills.length} skills are deleted too.`))
          run(async () => { await DEL(`/api/skill-groups/${g.id}`); await reload(); });
      } } }, "✕")),
    chips, el("div", { style: { marginTop: "4px" } }, add));
}

// ---------- page ----------

async function addSection() {
  const res = await openDialog((form, close) => {
    const title = el("input", { type: "text", required: true, placeholder: "e.g. Awards, Publications" });
    const kind = el("select", el("option", { value: "entries" }, "Entries with bullets (jobs, projects, awards…)"),
      el("option", { value: "skills" }, "Skills list"));
    form.append(el("h3", "New section"), el("label.field", "Title", title), el("label.field", "Type", kind),
      el("div.actions", el("button.btn", { type: "button", on: { click: () => close(null) } }, "Cancel"),
        el("button.btn.primary", { type: "submit" }, "Add")));
    form.addEventListener("submit", () => title.value.trim() && close({ title: title.value.trim(), kind: kind.value }));
  });
  if (res) run(async () => { await POST("/api/sections", res); await reload(); }, "Section added. Turn it on in the Builder.");
}

function render() {
  const secs = el("div", { style: { display: "flex", flexDirection: "column", gap: "14px" } },
    store.bank.sections.map((s, i, a) => renderSection(s, i, a.length)));
  Sortable.create(secs, {
    handle: ".sec-card-head > .drag", animation: 150,
    onEnd: () => run(async () => {
      await POST("/api/sections/reorder", { ids: [...secs.children].map((n) => Number(n.dataset.id)) });
      await refresh();
    }),
  });
  root.replaceChildren(el("div.content",
    el("div.row",
      el("div.grow", el("h2", "Content bank"),
        el("div.muted.small", "Everything you add here is available to every resume. Pick and order it per resume in the Builder.")),
      el("label.check.small", el("input", { type: "checkbox", checked: showArchived, on: { change: (e) => { showArchived = e.target.checked; render(); } } }), "Show archived"),
      el("button.btn", { type: "button", on: { click: async () => { if (await importDialog({ replacing: true })) location.reload(); } } }, "Import .tex"),
      el("button.btn", { type: "button", on: { click: addSection } }, "+ Add section")),
    renderProfile(),
    secs));
}

export function init(node) { root = node; }
export function show() { render(); }
