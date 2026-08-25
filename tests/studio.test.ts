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
  assert.match(source, /async function playDiscovery\(\)/);
  assert.match(source, /renderTimeline\(plan\.steps, index\)/);
  assert.match(source, /await delay\(index === 0 \? 1100 : 900\)/);
  assert.match(source, /Committed evidence playback/);
  assert.match(source, /Illustrated preview/);
});

test("Studio design register and presentation stay aligned with committed content", async () => {
  const source = await readFile("public/studio.html", "utf8");
  assert.equal((source.match(/<article class="decision-card">/g) ?? []).length, 18);
  assert.equal((source.match(/<article class="slide(?: active)?">/g) ?? []).length, 10);
  assert.match(source, /<b>8<\/b><span>curated replay cases<\/span>/);
  assert.match(source, /id="discovery-goal"/);
  assert.match(source, /id="discovery-member-id"/);
  assert.match(source, /Play guided discovery/);
  assert.match(source, /Show and copy genuine command/);
  assert.match(source, /id="discovery-command-panel"/);
  assert.match(source, /id="surface-stage"/);
  assert.equal((source.match(/data-goal="/g) ?? []).length, 3);
  assert.match(source, /High-level system design/);
  assert.match(source, /Thank you\./);
  assert.match(source, /https:\/\/theomthakur\.github\.io\/portfolio/);
  assert.match(source, /https:\/\/github\.com\/theomthakur/);
  assert.match(source, /https:\/\/www\.linkedin\.com\/in\/theomthakur\//);
  assert.doesNotMatch(source, /seven curated scenarios|Never raw selectors|Every mutation is followed by a checkpoint/);
});

test("Studio supports direct section links and labelled compact navigation", async () => {
  const script = await readFile("public/studio.js", "utf8");
  assert.match(script, /const initialView = location\.hash\.replace\("#", ""\)/);
  assert.match(script, /window\.addEventListener\("hashchange"/);

  const html = await readFile("public/studio.html", "utf8");
  const mobileNav = html.match(/<nav class="mobile-nav"[\s\S]*?<\/nav>/)?.[0] ?? "";
  assert.equal((mobileNav.match(/aria-label=/g) ?? []).length, 7, "nav plus all six compact controls need labels");
  for (const label of ["Overview", "Guided demo", "Proof", "Human review", "Design decisions", "Presentation"]) {
    assert.match(mobileNav, new RegExp(`aria-label="${label}"`));
  }
});
