import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { BuilderView, StartResponse, UpdateRequest } from "@shared/builder";
import { ApiError, apiFetch, SESSION_KEY, TOKEN_KEY } from "./api";

function useBuilderState() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY));
  const [builder, setBuilder] = useState<BuilderView | null>(null);
  const [loading, setLoading] = useState(!!token);
  const [error, setError] = useState<string | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const revision = useRef(0);
  const boot = useRef<{ token: string; request: Promise<BuilderView> } | null>(null);
  const accept = useCallback((response: StartResponse) => {
    revision.current += 1;
    if (localStorage.getItem(TOKEN_KEY) !== response.token) localStorage.removeItem(SESSION_KEY);
    localStorage.setItem(TOKEN_KEY, response.token);
    setToken(response.token);
    setBuilder(response.builder);
    setLoading(false);
    setError(null);
  }, []);
  const forget = useCallback(() => {
    revision.current += 1;
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(SESSION_KEY);
    setToken(null); setBuilder(null); setLoading(false); setError(null);
    boot.current = null;
  }, []);
  const request = useCallback((path = "/api/me", init?: RequestInit) => {
    const credential = localStorage.getItem(TOKEN_KEY);
    const version = revision.current;
    const next = queue.current.catch(() => {}).then(() => {
      if (version !== revision.current || credential !== localStorage.getItem(TOKEN_KEY)) throw new Error("Your builder changed. Please try again.");
      return apiFetch<BuilderView>(path, init);
    }).then(value => {
      if (version === revision.current && credential === localStorage.getItem(TOKEN_KEY)) { setBuilder(value); setError(null); }
      return value;
    }).catch((reason: unknown) => {
      if (reason instanceof ApiError && reason.status === 401 && version === revision.current && credential === localStorage.getItem(TOKEN_KEY)) forget();
      throw reason;
    });
    queue.current = next;
    return next;
  }, [forget]);
  const refresh = useCallback(() => request(), [request]);
  const update = useCallback((body: UpdateRequest) => request("/api/me", { method: "PUT", body: JSON.stringify(body) }), [request]);
  const retry = useCallback(() => {
    setLoading(true); setError(null);
    void refresh().catch(reason => setError(reason instanceof Error ? reason.message : "Your agent could not be loaded.")).finally(() => setLoading(false));
  }, [refresh]);
  useEffect(() => {
    if (!token || builder) return;
    let cancelled = false;
    if (boot.current?.token !== token) boot.current = { token, request: refresh() };
    void boot.current.request.catch(reason => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "Your agent could not be loaded.");
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token, builder, refresh]);
  useEffect(() => {
    const sync = (event: StorageEvent) => { if (event.key === TOKEN_KEY) { revision.current += 1; setToken(event.newValue); setBuilder(null); setLoading(!!event.newValue); boot.current = null; } };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  return { token, builder, loading, error, accept, forget, refresh, update, request, retry };
}
const BuilderContext = createContext<ReturnType<typeof useBuilderState> | null>(null);
export function BuilderProvider({ children }: { children: ReactNode }) {
  const state = useBuilderState();
  return <BuilderContext.Provider value={state}>{children}</BuilderContext.Provider>;
}
export function useBuilder() {
  const context = useContext(BuilderContext);
  if (!context) throw new Error("BuilderProvider is missing.");
  return context;
}
