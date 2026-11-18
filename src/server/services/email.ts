import type { Bindings } from "../index";
const escape = (text: string): string => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * The one-time link. The message carries nothing the visitor typed (no company name): this
 * route takes no login, so anything a visitor wrote would be mail with their words in it, sent
 * from this site to an address of their choosing.
 */
export async function sendVerification(env: Bindings, email: string, url: string): Promise<boolean> {
  const subject = "Confirm your email to keep building your agent";
  const text = `Keep building your AI screening agent on ${env.SITE_NAME}.\n\nConfirm your email: ${url}\n\nThis link works once. If you did not ask for it, ignore this message.`;
  const html = `<p>Keep building your AI screening agent on ${escape(env.SITE_NAME)}.</p><p><a href="${escape(url)}">Confirm your email</a></p><p>This link works once. If you did not ask for it, ignore this message.</p>`;
  try {
    await env.EMAIL.send({ to: email, from: { email: env.EMAIL_FROM, name: env.SITE_NAME }, subject, html, text });
    return true;
  } catch {
    // Delivery errors may echo the full message and its one-time token.
    console.error("Verification email could not be sent");
    return false;
  }
}
