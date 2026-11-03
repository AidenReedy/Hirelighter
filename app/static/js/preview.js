// Shared document preview: draws a rendered PDF (pdf.js) or Word file (docx-preview) into a pane.
import { el, debounce } from "./util.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/static/vendor/pdf.worker.min.js";

/**
 * Render `blob` into `target`. Returns the PDF page count (null for Word), or undefined if
 * `stale()` turned true while rendering (a newer preview started), in which case nothing is replaced.
 */
export async function renderDoc(target, blob, fmt, stale = () => false) {
  // attached off-screen so docx-preview can measure text for tab stops
  const stage = el("div", { style: { position: "absolute", left: "-10000px", top: "0", width: "1000px" } });
  document.body.append(stage);
  try {
    let pages = null;
    if (fmt === "pdf") {
      const pdf = await pdfjsLib.getDocument({ data: await blob.arrayBuffer(), isEvalSupported: false }).promise;
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const vp = page.getViewport({ scale: 2 });
        const canvas = el("canvas", { width: vp.width, height: vp.height });
        await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
        stage.append(canvas);
      }
      pages = pdf.numPages;
    } else {
      await docx.renderAsync(blob, stage, null, { inWrapper: true, ignoreLastRenderedPageBreak: true, breakPages: true, experimental: true });
      alignTabs(stage); // experimental marks tabs as .docx-tab-stop; we then lay them out ourselves
    }
    if (stale()) return undefined;
    target.replaceChildren(...stage.childNodes);
    fitDocx(target);
    return pages;
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
export function fitDocx(previewEl) {
  // transform (not zoom) so text isn't re-laid out and lines don't re-wrap
  const wrap = previewEl.querySelector(".docx-wrapper");
  if (!wrap || !previewEl.clientWidth) return;
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

window.addEventListener("resize", debounce(() => document.querySelectorAll(".preview").forEach(fitDocx), 150));

/** POST a render request; resolves {blob, filename, pages, headers} or throws with the LaTeX log attached. */
export async function fetchFile(url, payload, fallbackName, signal) {
  const res = await fetch(url, {
    method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let msg = res.statusText, log = "";
    try { const j = await res.json(); msg = j.error || msg; log = j.log || ""; } catch { /* not json */ }
    const err = new Error(msg); err.log = log; throw err;
  }
  return {
    blob: await res.blob(),
    filename: res.headers.get("X-Filename") || fallbackName,
    pages: res.headers.get("X-Page-Count"),
    headers: res.headers,
  };
}
