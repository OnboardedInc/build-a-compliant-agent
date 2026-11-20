import { basePath } from "../src/shared/base-path.ts";

export function withBaseConfig(source, input) {
  const base = basePath(input);
  if (!base) return source;
  // Leave directory redirects and index.html lookups to the Worker in this mode.
  return source
    .replace('"not_found_handling": "single-page-application"', '"not_found_handling": "none",\n\t\t"html_handling": "none"')
    .replace('"vars": {', `"vars": {\n\t\t"BASE_PATH": ${JSON.stringify(base)},`);
}
