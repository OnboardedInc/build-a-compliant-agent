import { PERSONAL_EMAIL_DOMAINS, domainListed } from "../../shared/builder";
import { PERSONAL_EMAIL_DOMAIN_LIST } from "../data/personalEmailDomains";

let listed: Set<string> | null = null;
/** The open lists (about forty thousand domains) plus the short list the page checks. Built on first use. */
const personalDomains = (): Set<string> => listed ??= new Set([...PERSONAL_EMAIL_DOMAIN_LIST.split("\n"), ...PERSONAL_EMAIL_DOMAINS]);

/**
 * Null when the address is not at a personal mailbox provider or a throwaway inbox, else what
 * to tell the visitor. The page checks a short list as they type; this is the full check.
 */
export function personalEmailProblem(email: string): string | null {
  const domain = email.trim().toLowerCase().split("@")[1] ?? "";
  const found = domainListed(personalDomains(), domain);
  return found ? `Use your work email. Addresses at ${found} are not accepted.` : null;
}
