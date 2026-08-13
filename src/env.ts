/**
 * Minimal .env loader.
 *
 * A dependency for this would be silly. Node 20.6+ has --env-file but the target runtime
 * here is Node 18, so twelve lines it is.
 */

import { existsSync, readFileSync } from "node:fs";

export function config(path = ".env"): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value !== "" && process.env[key] === undefined) process.env[key] = value;
  }
}
