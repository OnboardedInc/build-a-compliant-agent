import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import type { InterviewSession } from "@shared/interview";

export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === "string" ? error : "Something went wrong. Please try again.";

/** Serializing reads and writes prevents an older poll from replacing a new answer. */
export function useSession(initial: InterviewSession) {
  const [session, setSession] = useState(initial);
  const current = useRef(initial);
  const alive = useRef(true);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const acting = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const request = useCallback((path = "", body?: unknown) => {
    const run = queue.current.catch(() => {}).then(async () => {
      if (!alive.current) return current.current;
      const next = await apiFetch<InterviewSession>(`/api/sessions/${initial.id}${path}`, {
        ...(path ? { method: "POST", body: JSON.stringify(body ?? {}) } : {}),
      });
      if (alive.current) {
        current.current = next;
        setSession(next);
        setError(null);
      }
      return next;
    });
    queue.current = run;
    return run;
  }, [initial.id]);

  const refresh = useCallback(() => request(), [request]);
  const report = useCallback((reason: unknown) => {
    if (alive.current) setError(errorMessage(reason));
  }, []);
  const act = useCallback(async (action: "approve") => {
    if (acting.current) return;
    acting.current = true;
    setPending(true);
    try { await request(`/${action}`); }
    catch (reason) { report(reason); }
    finally {
      acting.current = false;
      if (alive.current) setPending(false);
    }
  }, [request, report]);

  const following = session.status === "approved" && !session.hire?.ready;
  useEffect(() => {
    if (!following) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await refresh(); } catch (reason) { if (!stopped) report(reason); }
      if (!stopped && !current.current.hire?.ready) timer = setTimeout(poll, 1500);
    };
    timer = setTimeout(poll, 1500);
    return () => { stopped = true; clearTimeout(timer); };
  }, [following, refresh, report]);

  return { session, current, refresh, act, pending, error, report };
}

export type SessionController = ReturnType<typeof useSession>;
