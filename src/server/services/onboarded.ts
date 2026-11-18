import type { Bindings } from "../index";
import { ob, type CallCounter, type OnboardedConfig } from "./interview";

export function getConfig(env: Pick<Bindings, "ONBOARDED_API_BASE" | "ONBOARDED_API_KEY">): OnboardedConfig | null {
  const apiKey = env.ONBOARDED_API_KEY?.trim();
  if (!apiKey) return null;
  return { apiKey, apiUrl: (env.ONBOARDED_API_BASE?.trim() || "https://app.onboarded.com/api/v1").replace(/\/+$/, "") };
}

/** All Onboarded requests pass through this helper. Credentials come only from env. */
export async function onboardedFetch(config: OnboardedConfig, path: string, options: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(`${config.apiUrl}${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}`, ...options.headers },
    });
  } catch {
    throw new Error("Could not reach the Onboarded API. Check ONBOARDED_API_BASE.");
  }
}

export async function createOnboardedEmployee(config: OnboardedConfig, counter: CallCounter, candidate: { first: string; last: string; email: string }): Promise<string> {
  // This product has no address on file and sends none, so no retry without an address is needed.
  const made = await ob<{ id?: string; data?: { id?: string } }>(config, counter, "POST", "/employees", {
    // The employer belongs to the placement: the employees endpoint refuses an employer_id.
    first_name: candidate.first, last_name: candidate.last, email: candidate.email,
  }, {
    detail: "Create this session's guest employee in Onboarded",
    returned: (b) => { const e = b as { id?: string; data?: { id?: string } }; return [`id: ${e.data?.id ?? e.id ?? "missing"}`]; },
    result: () => "employee created",
  });
  const id = made.data?.id ?? made.id;
  if (!id) throw new Error("Employee created but no ID returned.");
  return id;
}
