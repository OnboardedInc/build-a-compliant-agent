import { useEffect, useRef, useState } from "react";
import { signInWithGoogle, type AccessState } from "../lib/api";
import { SiteMark } from "../components/build/BuildLayout";

type GoogleIdentity = { accounts: { id: {
  initialize(options: { client_id: string; callback: (response: { credential?: string }) => void; ux_mode: "popup"; auto_select: false }): void;
  renderButton(element: HTMLElement, options: { type: "standard"; theme: "outline"; size: "large"; text: "signin_with" }): void;
} } };
declare global { interface Window { google?: GoogleIdentity } }

let googleScript: Promise<GoogleIdentity> | null = null;
function loadGoogle(): Promise<GoogleIdentity> {
  if (window.google) return Promise.resolve(window.google);
  if (!googleScript) googleScript = new Promise((resolve, reject) => {
    const src = "https://accounts.google.com/gsi/client";
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    const script = existing ?? document.createElement("script");
    script.addEventListener("load", () => window.google ? resolve(window.google) : reject(new Error("Google sign-in could not be loaded. Please reload and try again.")), { once: true });
    script.addEventListener("error", () => reject(new Error("Google sign-in could not be loaded. Please reload and try again.")), { once: true });
    if (!existing) { script.src = src; script.async = true; document.head.appendChild(script); }
  });
  return googleScript;
}

export function useGoogleButton(clientId: string | null, onCredential: (credential: string) => void) {
  const ref = useRef<HTMLDivElement>(null);
  const callback = useRef(onCredential);
  callback.current = onCredential;
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!clientId) return;
    let cancelled = false;
    const container = ref.current;
    setError(null);
    void loadGoogle().then((google) => {
      if (cancelled || !container) return;
      google.accounts.id.initialize({ client_id: clientId, callback: (response) => {
        if (cancelled) return;
        if (response.credential) callback.current(response.credential);
        else setError("Google did not return a sign-in credential. Please try again.");
      }, ux_mode: "popup", auto_select: false });
      container.replaceChildren();
      google.accounts.id.renderButton(container, { type: "standard", theme: "outline", size: "large", text: "signin_with" });
    }).catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "Google sign-in could not be loaded."); });
    return () => { cancelled = true; container?.replaceChildren(); };
  }, [clientId]);
  return { ref, error };
}

export function SignIn({ access, onSignedIn }: { access: AccessState; onSignedIn: (access: AccessState) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const acting = useRef(false);
  const submit = async (credential: string) => {
    if (acting.current) return;
    acting.current = true; setPending(true); setError(null);
    try { onSignedIn(await signInWithGoogle(credential)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Sign-in failed. Please try again."); }
    finally { acting.current = false; setPending(false); }
  };
  const button = useGoogleButton(access.ready ? access.clientId : null, (credential) => { void submit(credential); });
  return <main className="status-page sign-in-page" data-testid="sign-in" aria-busy={pending}>
    <div className="sign-in-card">
      <SiteMark />
      <h1>Sign in to build an agent</h1>
      <p>This preview is open to Google accounts at {access.domain}.</p>
      {access.ready ? <div ref={button.ref} className="sign-in-button" /> : <p role="status" className="sign-in-note">Sign-in is not set up yet.</p>}
      <p role="alert" className="field-error sign-in-error">{error ?? button.error}</p>
      {pending && <p role="status" className="sign-in-note">Signing in…</p>}
    </div>
  </main>;
}
