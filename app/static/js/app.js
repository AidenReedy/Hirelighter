import { GET, fail, setMaxChars } from "./util.js";
import * as builder from "./builder.js";
import * as content from "./content.js";
import * as jobs from "./jobs.js";
import * as setup from "./setup.js";

/** Shared app state: the content bank and saved resume presets. */
export const store = { bank: null, resumes: [], statuses: [], entryKinds: [], empty: false };

const listeners = new Set();
export const onBankChange = (fn) => listeners.add(fn);

export async function refresh({ notify = true } = {}) {
  const s = await GET("/api/state");
  store.bank = s.bank;
  store.resumes = s.resumes;
  store.statuses = s.statuses;
  store.entryKinds = s.entry_kinds;
  store.empty = s.empty;
  setMaxChars(s.settings?.max_bullet_chars);
  if (notify) listeners.forEach((fn) => fn());
}

/** Lookup helpers over the bank. */
export const find = {
  section: (id) => store.bank.sections.find((s) => s.id === id),
  entry: (id) => store.bank.sections.flatMap((s) => s.entries).find((e) => e.id === id),
  bullet: (id) => store.bank.sections.flatMap((s) => s.entries).flatMap((e) => e.bullets).find((b) => b.id === id),
};

/** Names of saved presets that use a given item (for delete confirmations). */
export function presetsUsing(kind, id) {
  return store.resumes.filter((r) => (r.config.sections || []).some((s) =>
    (kind === "section" && s.id === id) ||
    (kind === "skill" && (s.skills || []).includes(id)) ||
    (s.entries || []).some((e) => (kind === "entry" && e.id === id) || (kind === "bullet" && (e.bullets || []).includes(id)))
  )).map((r) => r.name);
}

const tabs = { builder, content, jobs };
let current = null;

function show() {
  const name = (location.hash.slice(1) || "builder");
  const tab = tabs[name] ? name : "builder";
  for (const t of Object.keys(tabs)) document.getElementById(`tab-${t}`).hidden = t !== tab;
  document.querySelectorAll("nav.tabs a").forEach((a) => a.classList.toggle("active", a.dataset.tab === tab));
  if (current !== tab) {
    current = tab;
    tabs[tab].show?.();
  }
}

async function main() {
  try {
    await refresh({ notify: false });
  } catch (e) {
    fail(e);
    return;
  }
  if (store.empty) {
    // first run: nothing to build with yet
    document.querySelector("nav.tabs").hidden = true;
    const node = document.getElementById("tab-setup");
    node.hidden = false;
    setup.render(node, (hash) => { location.hash = hash; location.reload(); });
    return;
  }
  builder.init(document.getElementById("tab-builder"));
  content.init(document.getElementById("tab-content"));
  jobs.init(document.getElementById("tab-jobs"));
  window.addEventListener("hashchange", show);
  show();
}

main();
