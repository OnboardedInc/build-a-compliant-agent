import type { ApiProblem, FieldError } from "@shared/builder";
import type { AccessState } from "@shared/access";
import { withBase } from "@shared/base-path";
import { agentLimitMessage } from "@shared/limits";
export type { AccessState } from "@shared/access";

export const TOKEN_KEY = "bca_token";
export const SESSION_KEY = "bca_session";
export const APP_BASE = import.meta.env.BASE_URL.slice(0, -1);
export const appPath = (path: string): string => withBase(APP_BASE, path);

export class ApiError extends Error {
  constructor(public status: number, message: string, public errors: FieldError[] = []) {
    super(message);
    this.name = "ApiError";
  }
}

export class SignInRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignInRequiredError";
  }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(appPath(path), { ...init, headers });
  if (!response.ok) {
    const problem = await response.json().catch(() => null) as (ApiProblem & { signIn?: unknown }) | null;
    if ((response.status === 401 || response.status === 503) && problem && typeof problem === "object" && "signIn" in problem) {
      window.dispatchEvent(new CustomEvent("bca-sign-in-required"));
      throw new SignInRequiredError(problem.error ?? "Sign in with your Google work account.");
    }
    // The email limit names the time the next agent is free: said on this visitor's clock, not the server's.
    const message = response.status === 429 && problem?.limit === "agents" ? agentLimitMessage(problem.retryAt) : problem?.error;
    throw new ApiError(response.status, message ?? `Something went wrong (${response.status}). Please try again.`, problem?.errors);
  }
  return response.json() as Promise<T>;
}

export const readAccess = (): Promise<AccessState> => apiFetch("/api/auth/me");
export const signInWithGoogle = (credential: string): Promise<AccessState> => apiFetch("/api/auth/google", { method: "POST", body: JSON.stringify({ credential }) });
export const signOut = (): Promise<{ ok: true }> => apiFetch("/api/auth/logout", { method: "POST" });
