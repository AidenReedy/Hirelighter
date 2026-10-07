// Small shared helpers: fetch wrapper, DOM builder, toasts, dialogs.

export async function api(method, url, data) {
  const opts = { method, headers: {} };
  if (data instanceof FormData) opts.body = data;
  else if (data !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(data);
  }
  const res = await fetch(url, opts);
  const isJson = (res.headers.get("Content-Type") || "").includes("json");
  const out = isJson ? await res.json() : await res.text();
  if (!res.ok) throw new Error((out && out.error) || res.statusText);
  return out;
}

export const GET = (u) => api("GET", u);
export const POST = (u, d) => api("POST", u, d);
export const PUT = (u, d) => api("PUT", u, d);
export const DEL = (u) => api("DELETE", u);

/** el("div.cls#id", {attr, on: {click}}, ...children) */
export function el(spec, attrs, ...children) {
  if (attrs == null || typeof attrs !== "object" || attrs instanceof Node || Array.isArray(attrs)) {
    if (attrs != null) children.unshift(attrs);
    attrs = {};
  }
  const [, tag = "div", rest = ""] = spec.match(/^([a-z0-9-]*)(.*)$/i);
  const node = document.createElement(tag || "div");
  for (const m of rest.matchAll(/([.#])([\w-]+)/g)) {
    if (m[1] === ".") node.classList.add(m[2]);
    else node.id = m[2];
  }
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "on") for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else if (k === "class") node.className += " " + v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k in node && typeof v !== "string") node[k] = v;
    else if (k === "value") node.value = v;
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

let toastTimer;
export function toast(msg, kind = "") {
  document.querySelector(".toast")?.remove();
  const t = el("div.toast", { class: kind }, msg);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), kind === "error" ? 6000 : 2200);
}

export function fail(e) {
  console.error(e);
  toast(e.message || String(e), "error");
}

/** Visible length on the page: **bold** markers dropped, -- counts as one dash. */
export function visibleLen(s) {
  return (s || "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/--/g, "–").length;
}

export let MAX_CHARS = 107;
export const setMaxChars = (n) => { if (n > 0) MAX_CHARS = n; };

/** Hidden normally; shows a "too long" tag once a bullet passes MAX_CHARS (so it won't fit on one line). */
export function counter(text) {
  const node = el("span.cc", { title: `Over ${MAX_CHARS} characters: it won't fit on one line` }, "too long");
  updateCounter(node, text);
  return node;
}

export function updateCounter(node, text) {
  const over = visibleLen(text) > MAX_CHARS;
  node.classList.toggle("over", over);
  node.hidden = !over;
}

/**
 * Open the shared <dialog>. `build(form, close)` fills it; resolves with whatever close(value) gets.
 * Esc / backdrop resolve null.
 */
export function openDialog(build) {
  const dlg = document.getElementById("dialog");
  dlg.replaceChildren();
  return new Promise((resolve) => {
    let done = false;
    const close = (v) => {
      if (done) return;
      done = true;
      dlg.close();
      resolve(v);
    };
    const form = el("form", { method: "dialog", on: { submit: (e) => e.preventDefault() } });
    const append = form.append.bind(form);
    form.append = (...nodes) => append(...nodes.filter((n) => n != null && n !== false)); // allow cond ? node : null
    build(form, close);
    dlg.append(form);
    dlg.onclose = () => close(null);
    dlg.onclick = (e) => { if (e.target === dlg) close(null); };
    dlg.showModal();
    form.querySelector("input, textarea, select")?.focus();
  });
}

export function promptDialog(title, label, value = "", okLabel = "Save") {
  return openDialog((form, close) => {
    const input = el("input", { type: "text", value, required: true });
    form.append(
      el("h3", title),
      el("label.field", label, input),
      el("div.actions",
        el("button.btn", { type: "button", on: { click: () => close(null) } }, "Cancel"),
        el("button.btn.primary", { type: "submit" }, okLabel)),
    );
    form.addEventListener("submit", () => input.value.trim() && close(input.value.trim()));
  });
}

export function confirmDialog(title, message, okLabel = "Delete", danger = true, cancelLabel = "Cancel") {
  return openDialog((form, close) => {
    form.append(
      el("h3", title),
      message ? el("p.sub", { style: { whiteSpace: "pre-line" } }, message) : null,
      el("div.actions",
        el("button.btn", { type: "button", on: { click: () => close(false) } }, cancelLabel),
        el("button.btn", { type: "submit", class: danger ? "danger" : "primary" }, okLabel)),
    );
    form.addEventListener("submit", () => close(true));
  });
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export const lsGet = (k, d = null) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
export const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
