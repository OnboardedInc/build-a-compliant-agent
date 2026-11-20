import { readFileSync, writeFileSync } from "node:fs";
import { withBaseConfig } from "./base-config.mjs";

const source = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
writeFileSync(new URL("../wrangler.preview.jsonc", import.meta.url), withBaseConfig(source, process.env.BCA_BASE_PATH));
