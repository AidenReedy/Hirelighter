// First-run setup: download the blank template, upload a filled-in resume (.tex / .json), or start from scratch.
import { el, api, POST, fail, openDialog } from "./util.js";

async function upload(file, preview) {
  const fd = new FormData();
  fd.append("file", file, file.name);
  return api("POST", "/api/import" + (preview ? "?preview=1" : ""), fd);
}

function describe(info) {
  return el("div",
    el("p", { style: { margin: "0 0 6px" } },
      el("b", info.name || "(no name found)"), ": ",
      `${info.sections} sections, ${info.entries} entries, ${info.bullets} bullets, ${info.skills} skills.`),
    info.warnings.length
      ? el("ul.small", { style: { margin: "0", paddingLeft: "18px" } }, info.warnings.map((w) => el("li", w)))
      : null);
}

/**
 * Pick a file, show what was found, confirm. `replacing` adds a warning that the current content is replaced.
 * Resolves true once imported.
 */
export function importDialog({ replacing = false } = {}) {
  return openDialog((form, close) => {
    const input = el("input", { type: "file", accept: ".tex,.json" });
    const result = el("div.small");
    const go = el("button.btn.primary", { type: "submit", disabled: true }, "Import");
    let file = null;
    input.addEventListener("change", async () => {
      file = input.files[0];
      go.disabled = true;
      if (!file) return;
      result.replaceChildren("Reading…");
      try {
        result.replaceChildren(describe(await upload(file, true)));
        go.disabled = false;
      } catch (e) {
        result.replaceChildren(el("span", { style: { color: "var(--danger-text)" } }, e.message));
      }
    });
    form.append(
      el("h3", replacing ? "Import a resume" : "Upload your resume"),
      el("p.sub", "A .tex file in Jake's Resume format (fill in the blank template, or use one you already have)."),
      replacing ? el("p.sub", { style: { fontWeight: "700" } },
        "This replaces everything in Content and your saved resumes. Jobs are kept. Make a Backup first if unsure.") : null,
      input, result,
      el("div.actions", el("button.btn", { type: "button", on: { click: () => close(false) } }, "Cancel"), go));
    form.addEventListener("submit", async () => {
      if (!file) return;
      go.disabled = true;
      try {
        await upload(file, false);
        close(true);
      } catch (e) {
        fail(e);
        go.disabled = false;
      }
    });
  });
}

function step(n, title, text, action) {
  return el("div.card.setup-step",
    el("div.setup-n", n),
    el("div", { style: { flex: "1", minWidth: "0" } }, el("h3", title), el("p", text), action));
}

export function render(root, done) {
  const uploadBtn = el("button.btn.primary", { type: "button" }, "Upload .tex");
  uploadBtn.addEventListener("click", async () => { if (await importDialog()) done("#builder"); });
  const blankBtn = el("button.btn", { type: "button" }, "Start from scratch");
  blankBtn.addEventListener("click", async () => {
    try { await POST("/api/start-blank"); done("#content"); } catch (e) { fail(e); }
  });
  root.replaceChildren(el("div.setup",
    el("h2", "Let's set up your resume"),
    el("p.muted", "Everything stays on this server. You can change any of it later in Content."),
    step("1", "Get the template", "A blank Jake's Resume template with instructions inside. Fill it in with any text editor or Overleaf.",
      el("a.btn", { href: "/api/template", download: "resume_template.tex" }, "Download blank template")),
    step("2", "Upload it", "Upload the filled-in template, or any resume already written in Jake's Resume format. You'll see what was found before anything is saved.",
      uploadBtn),
    step("or", "Skip the template", "Start with empty sections and type everything in the Content tab.", blankBtn)));
}
