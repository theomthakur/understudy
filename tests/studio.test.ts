import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { startStudioServer } from "../src/studio/server.js";

test("Studio proxies the live synthetic target on the reviewer-visible origin", async () => {
  const studio = await startStudioServer(0, false);
  try {
    const response = await fetch(`${studio.origin}/legacy/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Member Search/);
  } finally {
    await studio.close();
  }
});

test("Studio starts with pending timeline steps rather than completed checkmarks", async () => {
  const source = await readFile("public/studio.js", "utf8");
  assert.match(source, /function renderTimeline\(steps, completed = -1,/);
});
