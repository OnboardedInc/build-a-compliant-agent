// The contract between the Worker and the app for everything before the call: who the
// visitor is, their brand, their two screening questions, and their agent's name and face.

export const AGENT_NAME_MAX = 8;
export const FACE_COUNT = 10;
/** An agent asks exactly this many screening questions before the offer. */
export const QUESTION_COUNT = 2;

/** Logo and two colours for the candidate's screen. `primary` is always the darker colour. */
export interface Brand {
  logoUrl: string | null;
  /** The darker colour: the ground of the candidate's screen. Dark enough for white text. */
  primary: string;
  /** The lighter colour: the accent (face, steps, sound bars, buttons). */
  secondary: string;
  /** Where it came from. "default" when nothing could be found. */
  source: "brand.dev" | "website" | "default";
}

export const DEFAULT_BRAND: Brand = { logoUrl: null, primary: "#1F2A44", secondary: "#C9D3EA", source: "default" };

export interface ScreeningQuestion {
  id: string;
  /** What the agent says, as one spoken question. */
  question: string;
  /** What the answer is scored as, two words at most: "Experience". */
  topic: string;
  /** What a good answer sounds like, for the note-taker that scores it. */
  listenFor: string;
}

export type BuildStep = "company" | "email" | "questions" | "name" | "built";

export interface BuilderView {
  id: string;
  email: string;
  company: string;
  /** The company's domain: "larkspur-staffing.example". */
  website: string;
  brand: Brand;
  verified: boolean;
  /** What the visitor typed or said in step 3. */
  description: string | null;
  /** The job the agent screens for, read from the description: "Banquet server". */
  jobTitle: string | null;
  questions: ScreeningQuestion[];
  agentName: string | null;
  /** 1 to FACE_COUNT. */
  agentFace: number | null;
  built: boolean;
  /** The first step that is not finished: where the app should put the visitor. */
  step: BuildStep;
  /** Local development only: the one-time link, shown on the page instead of relying on email. */
  devVerifyUrl?: string;
}

export interface FieldError {
  field: "email" | "company" | "website" | "description" | "questions" | "agentName" | "agentFace";
  message: string;
}

/** Every refusal from the builder API: `error` for the page, `errors` per field when a field is at fault. */
export interface ApiProblem {
  error: string;
  errors?: FieldError[];
  /** Set on the 429 for the email limit, with the time the next agent is free. */
  limit?: "agents";
  retryAt?: string | null;
}

export interface StartRequest {
  email: string;
  company: string;
  website: string;
}

export interface StartResponse {
  /** The browser's credential from here on: `Authorization: Bearer <token>`. */
  token: string;
  builder: BuilderView;
}

export interface UpdateRequest {
  questions?: Array<Pick<ScreeningQuestion, "id" | "question">>;
  agentName?: string;
  agentFace?: number;
}

// -- Work email -------------------------------------------------------------------------------

/** Providers anyone can sign up for. An address at one of these is not a work email. */
export const PERSONAL_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "ymail.com", "rocketmail.com", "outlook.com", "hotmail.com",
  "hotmail.co.uk", "live.com", "msn.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com",
  "pm.me", "gmx.com", "gmx.net", "mail.com", "zoho.com", "yandex.com", "yandex.ru", "fastmail.com", "hey.com", "tutanota.com",
  "tuta.io", "duck.com", "qq.com", "163.com", "126.com", "comcast.net", "verizon.net", "att.net", "sbcglobal.net", "cox.net",
  "mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com", "sharklasers.com", "yopmail.com",
]);

/**
 * The listed domain an address is at: the domain itself, or a listed domain it is a
 * sub-domain of ("mail.gmail.com" is at "gmail.com"). Null when it is at none. An ending of
 * one label, such as "com", is never looked up.
 */
export function domainListed(list: ReadonlySet<string>, input: string): string | null {
  const labels = input.trim().toLowerCase().split(".").filter(Boolean);
  for (let i = 0; i + 2 <= labels.length; i++) {
    const candidate = labels.slice(i).join(".");
    if (list.has(candidate)) return candidate;
  }
  return null;
}

/** Null when the address is a usable work email, else what to tell the visitor. */
export function workEmailProblem(input: string): string | null {
  const email = input.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(email)) return "Enter a valid email address.";
  const domain = email.split("@")[1] ?? "";
  if (PERSONAL_EMAIL_DOMAINS.has(domain)) return `Use your work email. Addresses at ${domain} are not accepted.`;
  return null;
}

/** "https://www.Larkspur-Staffing.com/about" → "larkspur-staffing.com". Null when it is not a domain. */
export function normalizeDomain(input: string): string | null {
  const host = input.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0] ?? "";
  return /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(host) ? host : null;
}

// -- Colour -----------------------------------------------------------------------------------

const channels = (hex: string): [number, number, number] | null => {
  const raw = hex.trim().replace(/^#/, "");
  const full = raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
};

const toHex = (rgb: [number, number, number]): string =>
  `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("").toUpperCase()}`;

/** WCAG relative luminance, 0 (black) to 1 (white). Null for anything that is not a hex colour. */
export function luminance(hex: string): number | null {
  const rgb = channels(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two hex colours (1 to 21). */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a) ?? 0, luminance(b) ?? 0].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Moves a colour toward black (amount < 0) or white (amount > 0), by a share of the distance. */
export function shade(hex: string, amount: number): string {
  const rgb = channels(hex);
  if (!rgb) return hex;
  const to = amount < 0 ? 0 : 255;
  const k = Math.abs(amount);
  return toHex(rgb.map((v) => v + (to - v) * k) as [number, number, number]);
}

/**
 * From whatever colours a brand has, the two the candidate's screen uses. The darker one is
 * always the primary and the lighter one the secondary, whatever the brand calls them,
 * so the screen reads the same for every brand. The primary is darkened until white text on it passes 4.5:1, and the
 * secondary is lightened until the primary's colour on it does.
 */
export function pickBrandColours(hexes: ReadonlyArray<string>): Pick<Brand, "primary" | "secondary"> | null {
  const valid = [...new Set(hexes.map((h) => (channels(h) ? toHex(channels(h) as [number, number, number]) : null)).filter((h): h is string => h !== null))];
  // Near-white and near-black say nothing about a brand unless they are all there is.
  const telling = valid.filter((h) => { const l = luminance(h) ?? 0; return l > 0.015 && l < 0.9; });
  const pool = (telling.length ? telling : valid).sort((a, b) => (luminance(a) ?? 0) - (luminance(b) ?? 0));
  if (pool.length === 0) return null;
  let primary = pool[0] as string;
  let secondary = pool.length > 1 ? (pool[pool.length - 1] as string) : shade(primary, 0.72);
  for (let i = 0; i < 20 && contrast(primary, "#FFFFFF") < 4.5; i += 1) primary = shade(primary, -0.12);
  for (let i = 0; i < 20 && contrast(secondary, primary) < 4.5; i += 1) secondary = shade(secondary, 0.15);
  return { primary, secondary };
}
