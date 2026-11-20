import { readAccess } from "./api";

// Cloudflare Turnstile: a check that the visitor is a person, asked for before the two requests
// anyone can make without an agent of their own (the company lookup, and starting an agent).
// Most visitors never see it. When Cloudflare wants a click, its box shows at the top of the page.

interface Turnstile {
  render(target: HTMLElement, options: Record<string, unknown>): string;
  remove(id: string): void;
}
declare global { interface Window { turnstile?: Turnstile } }

const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const FAILED = "We could not confirm you are a person. Try that again, or reload the page.";

let key: Promise<string | null> | null = null;
/** The site key, or null when the Worker has Turnstile off (local development). */
const siteKey = (): Promise<string | null> => key ??= readAccess().then(access => access.turnstileSiteKey ?? null).catch(() => { key = null; return null; });

let script: Promise<void> | null = null;
const loadScript = (): Promise<void> => script ??= new Promise<void>((resolve, reject) => {
  if (window.turnstile) { resolve(); return; }
  const tag = document.createElement("script");
  tag.src = SCRIPT; tag.async = true;
  tag.onload = () => resolve();
  tag.onerror = () => { script = null; tag.remove(); reject(new Error(FAILED)); };
  document.head.appendChild(tag);
});

function holder(): HTMLElement {
  let element = document.getElementById("bca-human");
  if (!element) {
    element = document.createElement("div");
    element.id = "bca-human";
    Object.assign(element.style, { position: "fixed", left: "50%", top: "16px", transform: "translateX(-50%)", zIndex: "1000", display: "grid", gap: "8px" });
    document.body.appendChild(element);
  }
  return element;
}

/** A fresh token for one request. Each token works once, so every protected request asks for its own. Null when Turnstile is off. */
export async function humanToken(action: "lookup" | "start"): Promise<string | null> {
  const sitekey = await siteKey();
  if (!sitekey) return null;
  await loadScript();
  return new Promise<string>((resolve, reject) => {
    const slot = document.createElement("div");
    holder().appendChild(slot);
    let id: string | undefined;
    let settled = false;
    const finish = (run: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      run();
      // Outside Turnstile's own callback, so it is not removed while it is still running.
      setTimeout(() => { try { if (id) window.turnstile?.remove(id); } catch { /* Already gone. */ } slot.remove(); }, 0);
    };
    const fail = () => finish(() => reject(new Error(FAILED)));
    // Cloudflare wants a click from this visitor: say so, in a card they cannot miss.
    const ask = () => {
      if (settled || slot.dataset.asked) return;
      slot.dataset.asked = "1";
      Object.assign(slot.style, { background: "#fff", color: "#14163a", padding: "14px 16px 12px", borderRadius: "14px", boxShadow: "0 12px 40px rgba(10, 12, 40, .28)", border: "1px solid #d6d9e6", font: "600 14px/1.4 system-ui, sans-serif", textAlign: "center" });
      const note = document.createElement("p");
      note.textContent = "One quick check: tick the box to carry on.";
      note.setAttribute("role", "status");
      Object.assign(note.style, { margin: "0 0 10px" });
      slot.insertBefore(note, slot.firstChild);
    };
    const timer = setTimeout(fail, 120_000);
    try {
      id = window.turnstile!.render(slot, {
        sitekey, action, appearance: "interaction-only", retry: "never", theme: "light",
        "before-interactive-callback": ask,
        callback: (token: string) => finish(() => resolve(token)),
        "error-callback": () => { fail(); return true; },
        "timeout-callback": fail,
        "unsupported-callback": fail,
      });
    } catch { fail(); }
  });
}

/** The header a protected request carries. Empty when Turnstile is off. */
export async function humanHeaders(action: "lookup" | "start"): Promise<Record<string, string>> {
  const token = await humanToken(action);
  return token ? { "x-turnstile-token": token } : {};
}
