export function basePath(input = ""): string {
  if (/[^a-z0-9/-]/.test(input)) throw new Error("Base path (BCA_BASE_PATH or BASE_PATH) may contain only lowercase letters, digits, hyphens, and slashes.");
  const segments = input.split("/").filter(Boolean);
  return segments.length ? `/${segments.join("/")}` : "";
}

export const withBase = (base: string, path: string): string => `${base}${path}`;

export function stripBase(base: string, pathname: string): string | null {
  if (!base) return pathname;
  if (pathname === base) return "/";
  return pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : null;
}

type Route =
  | { kind: "hono" }
  | { kind: "app-api"; path: string }
  | { kind: "app-page" }
  | { kind: "redirect"; to: string; status: 302 | 308 }
  | { kind: "root"; status: 200 | 404 };

// The root now belongs to the host. Only named routes from the old SPA move with it.
const oldPage = /^\/(?:check-email|verify|questions|name|built|call|sign-in|i\/[^/]+)\/*$/i;

export function route(base: string, pathname: string): Route {
  if (!base) return { kind: "hono" };
  if (pathname === base) return { kind: "redirect", to: `${base}/`, status: 308 };
  const path = stripBase(base, pathname);
  if (path !== null) return path.startsWith("/api/") ? { kind: "app-api", path } : { kind: "app-page" };
  if (pathname.startsWith("/api/")) return { kind: "hono" };
  if (oldPage.test(pathname)) return { kind: "redirect", to: withBase(base, pathname), status: 302 };
  return { kind: "root", status: pathname === "/" ? 200 : 404 };
}
