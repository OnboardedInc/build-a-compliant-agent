import type { Bindings } from "../index";

/** What is told to the team's Slack channel when a visitor finishes building an agent. */
export interface BuiltAgent {
  email: string; contactName?: string | null; contactTitle?: string | null;
  company: string; website: string; primary?: string | null; secondary?: string | null;
  agentName: string | null; agentFace: number | null; jobTitle: string | null;
  description: string | null; questions: string[];
}

/** Slack reads &, < and > as markup. */
const plain = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function builtAgentMessage(siteName: string, agent: BuiltAgent): string {
  const who = [agent.contactName, agent.contactTitle].filter(Boolean).join(", ");
  const colours = [agent.primary, agent.secondary].filter(Boolean).join(" and ");
  return [
    `*New agent built on ${plain(siteName)}*`,
    `*Who:* ${plain(agent.email)}${who ? ` (${plain(who)})` : ""}`,
    `*Company:* ${plain(agent.company)} (${plain(agent.website)})`,
    `*Agent:* ${plain(agent.agentName ?? "unnamed")}${agent.agentFace ? `, face ${agent.agentFace}` : ""}${colours ? `, colours ${plain(colours)}` : ""}`,
    ...(agent.jobTitle ? [`*Job:* ${plain(agent.jobTitle)}`] : []),
    ...agent.questions.map((question, i) => `*Question ${i + 1}:* ${plain(question)}`),
    ...(agent.description ? [`*Their description:* ${plain(agent.description.slice(0, 600))}`] : []),
  ].join("\n");
}

/**
 * Posts the built agent to the Slack channel behind SLACK_WEBHOOK_URL (a Slack incoming
 * webhook). Without the secret nothing is sent, and nothing is sent for an agent built on
 * any host but the site's own domain (SITE_NAME). A failed post is dropped: telling the team
 * never gets in the visitor's way.
 */
export async function announceBuiltAgent(env: Pick<Bindings, "SLACK_WEBHOOK_URL" | "SITE_NAME">, agent: BuiltAgent, host: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  const url = env.SLACK_WEBHOOK_URL?.trim();
  if (!url || !url.startsWith("https://hooks.slack.com/")) return false;
  // Only agents built on the site's own domain are told to the channel: the same Worker also
  // answers at its workers.dev address and on localhost, and those are not signups to follow up.
  if (host.trim().toLowerCase() !== env.SITE_NAME.trim().toLowerCase()) return false;
  try {
    const response = await fetcher(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: builtAgentMessage(env.SITE_NAME, agent) }), signal: AbortSignal.timeout(8000) });
    return response.ok;
  } catch { return false; }
}
