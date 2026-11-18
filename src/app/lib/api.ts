import type { ApiProblem, FieldError } from "@shared/builder";

export const TOKEN_KEY = "bca_token";
export const SESSION_KEY = "bca_session";

export class ApiError extends Error {
  constructor(public status: number, message: string, public errors: FieldError[] = []) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    const problem = await response.json().catch(() => null) as ApiProblem | null;
    throw new ApiError(response.status, problem?.error ?? `Something went wrong (${response.status}). Please try again.`, problem?.errors);
  }
  return response.json() as Promise<T>;
}
