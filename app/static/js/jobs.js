// Jobs tab: application tracker, post-download questionnaire, Sankey diagram, Gmail updates.
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

let root, tableWrap, sankeyEl, statsEl, filterSel, searchInput, mailEl;
let jobs = [];
let mail = null;
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
    const expect = el("input", { type: "text", value: j.expect_from || "", placeholder: "Filled in from the application-received email" });
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
      editing ? el("label.field", "Expected email sender (helps match Gmail updates)", expect) : null,
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
      if (editing) Object.assign(out, { status: status.value, interview_count: Number(count.value) || 0, expect_from: expect.value.trim() });
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
    if (e.kind === "status") return `${when}: ${STATUS_LABELS[e.from_value]} → ${STATUS_LABELS[e.to_value]}${e.source === "email" ? " (from email)" : ""}`;
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

// ---------- email (Gmail watcher) ----------

const ago = (sqlTime) => {
  if (!sqlTime) return "never";
  const mins = Math.round((Date.now() - new Date(sqlTime.replace(" ", "T") + "Z")) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} days ago`;
};
const day = (sqlTime) => new Date(sqlTime.replace(" ", "T") + "Z").toLocaleDateString();
const jobLabel = (j) => (j.role ? `${j.company} · ${j.role}` : j.company);

async function mailAction(url, body, msg) {
  try { await POST(url, body); if (msg) toast(msg); await load(); } catch (e) { fail(e); }
}

async function checkNow(btn) {
  btn.disabled = true;
  await mailAction("/api/mail/check", undefined, "Checking Gmail. Results show up in under a minute.");
  setTimeout(() => shown && load(), 40000);
}

function reviewItem(m) {
  // candidates first, then every other job you've applied to
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const cands = m.candidates.map((id) => byId.get(id)).filter(Boolean);
  const rest = jobs.filter((j) => j.status !== "not_applied" && !m.candidates.includes(j.id));
  const jobSel = el("select", { "aria-label": "Job" },
    el("option", { value: "" }, "Which job?"),
    cands.map((j, i) => el("option", { value: j.id, selected: i === 0 && j.id === m.job_id }, jobLabel(j))),
    rest.length ? el("optgroup", { label: "Other jobs" }, rest.map((j) => el("option", { value: j.id }, jobLabel(j)))) : null);
  const statusSel = el("select", { "aria-label": "New status" },
    ["rejected", "rejected_after_interview"].map((k) => el("option", { value: k, selected: k === m.to_status }, STATUS_LABELS[k])));
  jobSel.addEventListener("change", () => {
    const j = byId.get(Number(jobSel.value));
    if (j) statusSel.value = j.status === "interviewing" || j.interview_count > 0 ? "rejected_after_interview" : "rejected";
  });
  return el("div.mail-item",
    el("div.mail-head",
      el("b", m.subject || "(no subject)"),
      el("span.muted.small", `${m.from_name || m.from_addr} · ${day(m.received_at)}`)),
    el("div.mail-snippet", m.snippet),
    el("div.muted.small", m.confidence === "high" ? "Looks like a rejection, but the job wasn't clear." : `Might be a rejection: "${m.reason}"`),
    el("div.row.mail-actions",
      jobSel, statusSel,
      el("button.btn.small.primary", { type: "button", on: { click: () => {
        if (!jobSel.value) { jobSel.focus(); return toast("Pick the job this email is about", "error"); }
        mailAction(`/api/mail/${m.id}/accept`, { job_id: Number(jobSel.value), status: statusSel.value }, "Status updated");
      } } }, "Apply"),
      el("button.btn.small.ghost", { type: "button", on: { click: () => mailAction(`/api/mail/${m.id}/dismiss`, undefined, "Dismissed") } }, "Not a rejection")));
}

function recentItem(m) {
  const canUndo = m.job_status === m.to_status;
  return el("div.mail-recent",
    el("span", el("b", m.company ? jobLabel(m) : "(deleted job)"), `: ${STATUS_LABELS[m.from_status]} → ${STATUS_LABELS[m.to_status]}`),
    el("span.muted.small.grow", { title: m.snippet }, `${m.outcome === "auto" ? "Automatic" : "You applied it"}, ${day(m.received_at)}: "${m.subject}"`),
    el("button.btn.small.ghost", {
      type: "button", disabled: !canUndo, title: canUndo ? "Put the old status back" : "The status has changed since",
      on: { click: () => mailAction(`/api/mail/${m.id}/undo`, undefined, "Undone") },
    }, "Undo"));
}

function renderMail() {
  if (!mail?.enabled) { mailEl.hidden = true; return; }
  mailEl.hidden = false;
  const pill = mail.last_error
    ? el("span.status-pill.bad", { title: mail.last_error }, "Gmail error")
    : el("span.status-pill.good", `Checked ${ago(mail.last_check_at)}`);
  const btn = el("button.btn.small", { type: "button", disabled: mail.check_requested }, mail.check_requested ? "Checking…" : "Check now");
  btn.addEventListener("click", () => checkNow(btn));
  mailEl.replaceChildren(...[
    el("div.mail-bar",
      el("h2", "Email"), pill,
      el("span.muted.small.grow", mail.account ? `${mail.account}, label "${mail.label}"${mail.auto_apply ? "" : ", review only"}` : ""),
      btn),
    mail.last_error ? el("div.hint", mail.last_error) : null,
    mail.login_on ? null : el("div.hint", "Gmail is connected but Hirelighter has no login, so anyone who can reach it can read these emails. Set APP_PASSWORD in .env."),
    mail.review.length
      ? el("div.mail-section", el("h3", `To review (${mail.review.length})`), mail.review.map(reviewItem))
      : null,
    mail.recent.length
      ? el("div.mail-section", el("h3", "Updated from email (last 14 days)"), mail.recent.map(recentItem))
      : null,
    !mail.review.length && !mail.recent.length && !mail.last_error
      ? el("div.muted.small", "Nothing yet. Rejections in your Gmail label show up here.")
      : null,
  ].filter(Boolean));
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
    const [j, s, m] = await Promise.all([GET("/api/jobs"), GET("/api/sankey"), GET("/api/mail")]);
    jobs = j;
    mail = m;
    renderMail();
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
  mailEl = el("div.card.mail-card", { hidden: true });
  filterSel = el("select", { "aria-label": "Filter", on: { change: () => { lsSet("jobFilter", filterSel.value); renderTable(); } } },
    el("option", { value: "all" }, "All jobs"),
    el("option", { value: "active" }, "Active (applied, interviewing, offered)"),
    Object.entries(STATUS_LABELS).map(([k, l]) => el("option", { value: k }, l)));
  filterSel.value = lsGet("jobFilter", "all");
  searchInput = el("input", { type: "text", placeholder: "Search company, role, notes", on: { input: renderTable } });
  root.append(el("div.jobs",
    statsEl,
    mailEl,
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
