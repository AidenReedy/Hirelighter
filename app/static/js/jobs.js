// Jobs tab: application tracker, post-download questionnaire, Sankey diagram.
import { store } from "./app.js";
import { el, GET, POST, PUT, DEL, fail, toast, openDialog, confirmDialog, lsGet, lsSet } from "./util.js";
import { drawSankey } from "./sankey.js";

export const STATUS_LABELS = {
  not_applied: "Not applied yet",
  applied: "Applied",
  interviewing: "Interviewing",
  rejected: "Rejected",
  rejected_after_interview: "Rejected after interview",
  offered: "Offered",
  accepted: "Accepted",
  declined: "Declined",
};

let root, tableWrap, sankeyEl, statsEl, filterSel, searchInput;
let jobs = [];
let shown = false;

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// ---------- questionnaire ----------

/**
 * Add/edit a job. With `blob`, the downloaded resume is attached to the job.
 * Resolves with the saved job, or null if skipped.
 */
export async function openJobDialog({ job = null, blob = null, filename = "", resumeId = null, resumeName = "", fromDownload = false } = {}) {
  const editing = !!job;
  const j = job || { company: "", role: "", url: "", status: "applied", applied_date: today(), interview_count: 0, notes: "" };
  const values = await openDialog((form, close) => {
    const company = el("input", { type: "text", required: true, value: j.company, placeholder: "Company name" });
    const role = el("input", { type: "text", value: j.role, placeholder: "Role title" });
    const applied = el("input", { type: "checkbox", checked: j.status !== "not_applied" });
    const date = el("input", { type: "date", value: j.applied_date || today() });
    const url = el("input", { type: "url", value: j.url, placeholder: "Job posting link (optional)" });
    const notes = el("textarea", { rows: 2, value: j.notes, placeholder: "Notes (optional)" });
    const status = el("select", Object.entries(STATUS_LABELS).map(([k, l]) => el("option", { value: k, selected: k === j.status }, l)));
    const count = el("input", { type: "number", min: 0, value: j.interview_count, style: { width: "90px" } });
    applied.addEventListener("change", () => {
      date.disabled = !applied.checked;
      if (editing) status.value = applied.checked ? (status.value === "not_applied" ? "applied" : status.value) : "not_applied";
    });
    status.addEventListener("change", () => { applied.checked = status.value !== "not_applied"; date.disabled = !applied.checked; });
    date.disabled = !applied.checked;

    form.append(
      el("h3", fromDownload ? "Log this application?" : editing ? "Edit job" : "Add job"),
      fromDownload ? el("p.sub", `Downloaded ${filename}. Track it in Jobs, or skip.`) : null,
      el("label.field", "Company", company),
      el("label.field", "Role title", role),
      el("div.row", el("label.check", applied, "Applied"), el("label.field.grow", "Date applied", date)),
      editing ? el("div.row", el("label.field.grow", "Status", status), el("label.field", "Interviews", count)) : null,
      el("label.field", "Link", url),
      el("label.field", "Notes", notes),
      el("div.actions",
        el("button.btn", { type: "button", on: { click: () => close(null) } }, fromDownload ? "Skip" : "Cancel"),
        el("button.btn.primary", { type: "submit" }, "Save")),
    );
    form.addEventListener("submit", () => {
      if (!company.value.trim()) return company.focus();
      const out = {
        company: company.value.trim(), role: role.value.trim(), url: url.value.trim(), notes: notes.value.trim(),
        applied_date: applied.checked ? date.value || today() : null,
      };
      if (editing) Object.assign(out, { status: status.value, interview_count: Number(count.value) || 0 });
      else out.applied = applied.checked;
      close(out);
    });
  });
  if (!values) return null;
  try {
    let saved;
    if (editing) {
      saved = await PUT(`/api/jobs/${j.id}`, values);
    } else if (blob) {
      const fd = new FormData();
      fd.append("job", JSON.stringify({ ...values, resume_id: resumeId, resume_name: resumeName }));
      fd.append("resume", blob, filename);
      saved = await POST("/api/jobs", fd);
    } else {
      saved = await POST("/api/jobs", values);
    }
    toast(editing ? "Job updated" : `Added ${saved.company} to Jobs`);
    if (shown) await load();
    return saved;
  } catch (e) {
    fail(e);
    return null;
  }
}

// ---------- updates ----------

async function setStatus(job, status, sel) {
  if (status === "rejected" && job.interview_count > 0) {
    const after = await confirmDialog("Rejected after interviewing?",
      `You logged ${job.interview_count} interview${job.interview_count > 1 ? "s" : ""} with ${job.company}. Mark it as "Rejected after interview"?`,
      "Yes, after interview", false, "No, just Rejected");
    if (after) status = "rejected_after_interview";
  }
  try {
    await PUT(`/api/jobs/${job.id}`, { status });
    await load();
  } catch (e) { fail(e); sel.value = job.status; }
}

async function bump(job, delta) {
  const n = Math.max(0, job.interview_count + delta);
  const body = { interview_count: n };
  if (delta > 0 && ["applied", "not_applied"].includes(job.status)) body.status = "interviewing";
  try { await PUT(`/api/jobs/${job.id}`, body); await load(); } catch (e) { fail(e); }
}

async function showHistory(job) {
  const events = await GET(`/api/jobs/${job.id}/events`);
  const fmt = (e) => {
    const when = new Date(e.at.replace(" ", "T") + "Z").toLocaleString();
    if (e.kind === "created") return `${when}: added as ${STATUS_LABELS[e.to_value] || e.to_value}`;
    if (e.kind === "status") return `${when}: ${STATUS_LABELS[e.from_value]} → ${STATUS_LABELS[e.to_value]}`;
    return `${when}: interviews ${e.from_value} → ${e.to_value}`;
  };
  await openDialog((form, close) => form.append(
    el("h3", `${job.company}: history`),
    el("ol.events", events.map((e) => el("li", fmt(e)))),
    el("div.actions", el("button.btn", { type: "submit", on: { click: () => close(null) } }, "Close"))));
}

async function remove(job) {
  if (!(await confirmDialog(`Delete ${job.company}?`, "This removes the job, its history, and the saved resume copy."))) return;
  try { await DEL(`/api/jobs/${job.id}`); await load(); } catch (e) { fail(e); }
}

// ---------- render ----------

function renderTable() {
  const f = filterSel.value;
  const q = searchInput.value.trim().toLowerCase();
  const rows = jobs.filter((j) => {
    if (f === "active" && !["applied", "interviewing", "offered"].includes(j.status)) return false;
    if (f !== "all" && f !== "active" && j.status !== f) return false;
    return !q || `${j.company} ${j.role} ${j.notes}`.toLowerCase().includes(q);
  });
  if (!jobs.length) {
    tableWrap.replaceChildren(el("div.empty", "No jobs yet. Download a resume and log it, or use + Add job."));
    return;
  }
  if (!rows.length) {
    tableWrap.replaceChildren(el("div.empty", "No jobs match this filter."));
    return;
  }
  tableWrap.replaceChildren(el("table.jobs-table",
    el("thead", el("tr", ["Company / role", "Status", "Interviews", "Applied", "Resume sent", "Notes", ""].map((h) => el("th", h)))),
    el("tbody", rows.map((j) => {
      const sel = el("select.status-sel", { class: `st-${j.status}`, "aria-label": "Status" },
        Object.entries(STATUS_LABELS).map(([k, l]) => el("option", { value: k, selected: k === j.status }, l)));
      sel.addEventListener("change", () => setStatus(j, sel.value, sel));
      return el("tr",
        el("td", el("div.co", j.url ? el("a", { href: j.url, target: "_blank", rel: "noopener noreferrer" }, j.company) : j.company),
          el("div.muted.small", j.role)),
        el("td", sel),
        el("td.num", el("span.counter",
          el("button.btn.small", { type: "button", "aria-label": "One fewer interview", on: { click: () => bump(j, -1) } }, "−"),
          el("b", j.interview_count),
          el("button.btn.small", { type: "button", "aria-label": "Add an interview", on: { click: () => bump(j, 1) } }, "+"))),
        el("td.num.small", j.applied_date || el("span.muted", "—")),
        el("td.small", j.resume_file
          ? el("a", { href: `/api/jobs/${j.id}/resume`, target: "_blank", rel: "noopener" }, j.resume_name || "View")
          : el("span.muted", j.resume_name || "—")),
        el("td.notes", { title: j.notes }, j.notes),
        el("td", el("div.row", { style: { flexWrap: "nowrap", gap: "2px" } },
          el("button.icon-btn", { type: "button", title: "Edit", on: { click: () => openJobDialog({ job: j }) } }, "✎"),
          el("button.icon-btn", { type: "button", title: "History", on: { click: () => showHistory(j) } }, "⟲"),
          el("button.icon-btn.danger", { type: "button", title: "Delete", on: { click: () => remove(j) } }, "✕"))));
    }))));
}

function stat(v, l) { return el("div.card.stat", el("div.v", v), el("div.l", l)); }

function renderStats(t) {
  const rate = t.applied ? Math.round((t.jobs_interviewed / t.applied) * 100) + "%" : "—";
  const active = jobs.filter((j) => ["applied", "interviewing", "offered"].includes(j.status)).length;
  statsEl.replaceChildren(
    stat(t.applied, "Applications"),
    stat(active, "Still active"),
    stat(t.interviews, `Interviews (${t.jobs_interviewed} compan${t.jobs_interviewed === 1 ? "y" : "ies"})`),
    stat(rate, "Interview rate"),
    stat(t.offers, t.offers === 1 ? "Offer" : "Offers"));
}

async function load() {
  try {
    const [j, s] = await Promise.all([GET("/api/jobs"), GET("/api/sankey")]);
    jobs = j;
    renderStats(s.totals);
    drawSankey(sankeyEl, s);
    renderTable();
  } catch (e) { fail(e); }
}

export function init(node) {
  root = node;
  statsEl = el("div.stats");
  sankeyEl = el("div#sankey");
  tableWrap = el("div");
  filterSel = el("select", { "aria-label": "Filter", on: { change: () => { lsSet("jobFilter", filterSel.value); renderTable(); } } },
    el("option", { value: "all" }, "All jobs"),
    el("option", { value: "active" }, "Active (applied, interviewing, offered)"),
    Object.entries(STATUS_LABELS).map(([k, l]) => el("option", { value: k }, l)));
  filterSel.value = lsGet("jobFilter", "all");
  searchInput = el("input", { type: "text", placeholder: "Search company, role, notes", on: { input: renderTable } });
  root.append(el("div.jobs",
    statsEl,
    el("div.card.sankey-card", el("h2", "Your job search"), sankeyEl),
    el("div.card",
      el("div.jobs-toolbar",
        el("button.btn.primary", { type: "button", on: { click: () => openJobDialog() } }, "+ Add job"),
        filterSel, el("span.grow"), searchInput),
      tableWrap)));
  let t;
  window.addEventListener("resize", () => { clearTimeout(t); t = setTimeout(() => shown && load(), 200); });
}

export function show() {
  shown = true;
  load();
}
