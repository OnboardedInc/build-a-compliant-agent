import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
import type { StartResponse } from "@shared/builder";
import { apiFetch } from "@/lib/api";
import { useBuilder } from "@/lib/builder";
export function Verify() {
  const [params] = useSearchParams();
  const token = params.get("token");
  const { accept } = useBuilder();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const boot = useRef<{ token: string; request: Promise<StartResponse> } | null>(null);
  useEffect(() => {
    if (!token) { setError("This confirmation link is missing its token."); return; }
    let cancelled = false;
    // A one-time link must be consumed once, including under React StrictMode.
    if (boot.current?.token !== token) boot.current = { token, request: apiFetch<StartResponse>("/api/verify", { method: "POST", body: JSON.stringify({ token }) }) };
    void boot.current.request.then(response => { if (!cancelled) { accept(response); navigate("/questions", { replace: true }); } }).catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : "This link is unknown or has already been used."); });
    return () => { cancelled = true; };
  }, [token, accept, navigate]);
  return <main className="status-page">{error ? <><h1>This link does not work</h1><p role="alert">{error}</p><Link className="primary-button" to="/">Return to the start</Link></> : <><Loader2 className="animate-spin" aria-hidden="true" /><p role="status">Confirming your email…</p></>}</main>;
}
