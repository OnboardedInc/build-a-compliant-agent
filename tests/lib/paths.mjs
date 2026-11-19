// Where the tests read from and write to. Every path is resolved from this file, so the tests
// run from any working directory.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The `tests/` folder. */
export const TESTS = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The repository root. */
export const REPO = resolve(TESTS, "..");
/** Files the tests ship with (the sample document image). */
export const ASSETS = resolve(TESTS, "assets");
/** Everything a run writes: screenshots, synthesized audio, saved calls. Not committed. */
export const OUT = resolve(TESTS, "out");

/** A folder under tests/out, made if missing. */
export const outDir = (...parts) => {
  const dir = resolve(OUT, ...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** One value from the repository's .dev.vars, read at run time. Never print what it returns. */
export const devVar = (name) => {
  const file = resolve(REPO, ".dev.vars");
  if (!existsSync(file)) throw new Error(`No .dev.vars in ${REPO}: copy .dev.vars.example and fill it in.`);
  const line = readFileSync(file, "utf8").match(new RegExp(`^${name}=(.*)$`, "m"));
  const value = line?.[1].trim().replace(/^["']|["']$/g, "");
  if (!value) throw new Error(`${name} is not set in .dev.vars.`);
  return value;
};

/** One value from the gitignored .prod.vars, read at run time. Never print what it returns. */
export const prodVar = (name) => {
  const file = resolve(REPO, ".prod.vars");
  if (!existsSync(file)) throw new Error("No .prod.vars at the repository root. Add the deployed test secrets there.");
  const line = readFileSync(file, "utf8").match(new RegExp(`^${name}=(.*)$`, "m"));
  const value = line?.[1].trim().replace(/^["']|["']$/g, "");
  if (!value) throw new Error(`${name} is not set in .prod.vars.`);
  return value;
};
