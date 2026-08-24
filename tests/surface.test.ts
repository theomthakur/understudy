/**
 * Surface tests.
 *
 * These are the tests worth having: they prove that the perception layer can find controls
 * in a deliberately hostile, frameset-based, test-id-free app using nothing but roles and
 * accessible names. If this holds, the whole locator strategy holds.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { WebSurface } from "../src/surface/web-surface.js";
import { parseAriaSnapshot } from "../src/surface/aria-snapshot.js";
import type { ResolveTarget } from "../src/surface/surface.js";
import { PolicyEngine, DEFAULT_POLICY } from "../src/policy/policy.js";

const BASE = `http://localhost:${process.env.TARGET_PORT ?? 4471}`;
let surface: WebSurface;

function target(t: Partial<ResolveTarget> & { role: string }): ResolveTarget {
  return {
    nameMatch: "exact",
    frame: { strategy: "main" },
    fallbacks: [],
    ...t,
  };
}

before(async () => {
  surface = new WebSurface({ headless: true });
  await surface.start();
});

after(async () => {
  await surface?.close();
});

test("parses the aria snapshot format including containers and text nodes", () => {
  const nodes = parseAriaSnapshot(`
- banner:
  - heading "Member Search" [level=2]
- textbox "Member ID"
- button "Search" [disabled]
- text: Enter a member number.
`);
  const roles = nodes.map((n) => n.role);
  assert.ok(roles.includes("heading"));
  assert.ok(roles.includes("textbox"));

  const search = nodes.find((n) => n.role === "button");
  assert.equal(search?.name, "Search");
  assert.equal(search?.disabled, true);

  const heading = nodes.find((n) => n.role === "heading");
  assert.equal(heading?.container, "banner", "heading should report its enclosing region");

  const text = nodes.find((n) => n.role === "text");
  assert.equal(text?.name, "Enter a member number.");
});

test("observes controls on a table-based page with no test ids", async () => {
  await surface.open(BASE);
  const obs = await surface.observe();

  const names = obs.tree.map((n) => `${n.role}:${n.name}`);
  assert.ok(
    names.some((n) => n.startsWith("textbox:") && /Member/i.test(n)),
    `expected a member-id textbox, got ${JSON.stringify(names)}`
  );
  assert.ok(names.some((n) => n === "button:Search"), "expected a Search button");
});

test("resolves a control by role and accessible name alone", async () => {
  await surface.open(BASE);
  const r = await surface.resolve(target({ role: "button", name: "Search" }));
  assert.equal(r.found, true);
  assert.equal(r.strategy, "role-name", "should resolve on the primary strategy, not a fallback");
  assert.equal(r.matchCount, 1, "descriptor should be unambiguous");
});

test("reaches controls inside a frameset", async () => {
  // The workspace is a frameset; the member profile lives in a child frame. Resolution
  // must cross into it without the caller knowing the frame layout.
  await surface.open(`${BASE}/workspace?memberId=12345`);
  await surface.waitForSettled(5000);

  const obs = await surface.observe();
  const frames = new Set(obs.tree.map((n) => n.frame));
  assert.ok(frames.size > 1, `expected multiple frames, saw ${[...frames].join(", ")}`);

  const heading = await surface.resolve(
    target({ role: "heading", name: "Member Profile", nameMatch: "contains" })
  );
  assert.equal(heading.found, true, "should find the profile heading inside the detail frame");
});

test("falls back when the exact name no longer matches", async () => {
  await surface.open(BASE);
  // Primary asks for a label this tenant does not use; the contains-fallback rescues it.
  const r = await surface.resolve(
    target({
      role: "textbox",
      name: "Member Identifier",
      fallbacks: [{ kind: "role-name", value: "Member", note: "relaxed to substring" }],
    })
  );
  assert.equal(r.found, true, "fallback should rescue a relabelled control");
  assert.equal(r.strategy, "fallback:role-name");
});

test("reports not-found rather than throwing, for a control that does not exist", async () => {
  await surface.open(BASE);
  const r = await surface.resolve(target({ role: "button", name: "Wire Transfer" }));
  assert.equal(r.found, false);
  assert.equal(r.matchCount, 0);
});

test("browser guard blocks click-triggered navigation before it leaves the allowlist", async () => {
  const policy = new PolicyEngine({ ...DEFAULT_POLICY, allowedHosts: ["localhost"] });
  surface.setNavigationGuard((url) => policy.checkUrl(url));
  await surface.open(`${BASE}/policy-probe`);
  await surface.click(target({ role: "link", name: "Leave approved application" })).catch(() => {});
  await assert.rejects(() => surface.assertPolicyBoundary(), /Policy denied navigation.*allowlist/i);
  surface.setNavigationGuard(() => ({ allow: true }));
});

test("refuses to act when a human holds control", async () => {
  await surface.open(BASE);
  await assert.rejects(
    () => surface.humanAct({ kind: "press", key: "Enter" }),
    /while automation owns/,
    "operator-console actions must not bypass the automation lease"
  );
  await surface.cedeControl();
  await assert.rejects(
    () => surface.click(target({ role: "button", name: "Search" })),
    /does not hold control/,
    "automation must not act while a human has the session"
  );
  await surface.humanAct({
    kind: "type",
    target: target({ role: "textbox", name: "Member ID" }),
    text: "12345",
  });
  const humanEvents = JSON.stringify(surface.collectHumanEvents());
  assert.doesNotMatch(humanEvents, /12345/, "raw operator-typed text must never be persisted");
  assert.match(humanEvents, /"textLength":5/, "the audit keeps non-sensitive shape information");
  await surface.resumeControl();
});
