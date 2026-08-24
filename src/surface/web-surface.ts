/**
 * Playwright implementation of `Surface`, perceiving through the accessibility tree.
 *
 * Two decisions worth defending:
 *
 * 1. We perceive through roles and accessible names, not CSS. The target app deliberately
 *    has no test IDs and ids like `ctl00_MainPlaceHolder_grdAccounts_ctl03_lnkView` that
 *    carry a row index — exactly the kind that looks stable and breaks when a result set
 *    changes order. Roles and names survive that, and they are the same abstraction desktop
 *    accessibility APIs expose, which is what makes the desktop story in REPORT.md §4 more
 *    than a hand-wave.
 *
 * 2. Frames are addressed explicitly rather than flattened. The member workspace is a
 *    frameset, which is normal for this class of app. Silently searching every frame would
 *    make resolution ambiguous in a way that is painful to debug, so the descriptor says
 *    where to look and the resolver honours it.
 *
 * Chromium runs with a persistent context and a loopback-only DevTools endpoint. That makes
 * the human-handoff claim testable: an operator client connects over CDP and sees the same
 * context, cookies, frames, and half-filled form rather than a fresh lookalike session.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Frame,
  type Locator,
  type Page,
} from "playwright";
import type { AxNode, HumanAction, Observation, ResolveResult, ResolveTarget, Surface } from "./surface.js";
import { ACTIONABLE_ROLES, INFORMATIONAL_ROLES, parseAriaSnapshot } from "./aria-snapshot.js";

export interface WebSurfaceOptions {
  headless?: boolean;
  /** Slows actions so a watching human can follow a discovery run. Demo only. */
  slowMoMs?: number;
  defaultTimeoutMs?: number;
}

export class WebSurface implements Surface {
  readonly kind = "legacy-web" as const;

  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private cdpEndpoint?: string;
  private userDataDir?: string;
  private automationInControl = true;
  private navigationGuard: (url: string) => { allow: boolean; reason?: string } = () => ({ allow: true });
  private navigationViolation?: string;
  private readonly humanEvents: unknown[] = [];
  private pendingResolutionDiagnostic?: { attempts: number; strategy?: string };
  private readonly opts: Required<WebSurfaceOptions>;

  constructor(opts: WebSurfaceOptions = {}) {
    this.opts = {
      headless: opts.headless ?? true,
      slowMoMs: opts.slowMoMs ?? 0,
      defaultTimeoutMs: opts.defaultTimeoutMs ?? 8000,
    };
  }

  async start(): Promise<void> {
    const cdpPort = await availablePort();
    this.userDataDir = await mkdtemp(join(tmpdir(), "understudy-browser-"));
    this.context = await chromium.launchPersistentContext(this.userDataDir, {
      headless: this.opts.headless,
      slowMo: this.opts.slowMoMs,
      viewport: { width: 1280, height: 900 },
      args: [`--remote-debugging-port=${cdpPort}`],
    });
    this.browser = this.context.browser() ?? undefined;
    this.cdpEndpoint = `http://127.0.0.1:${cdpPort}`;
    await this.context.exposeBinding("__understudyHumanEvent", (_source, event: unknown) => {
      if (!this.automationInControl) this.humanEvents.push(event);
    });
    await this.context.addInitScript(() => {
      const record = (kind: string, event: Event) => {
        const target = event.target as HTMLElement | null;
        const payload = {
          at: new Date().toISOString(),
          kind,
          tag: target?.tagName,
          label: (target?.innerText || target?.getAttribute("aria-label") || target?.getAttribute("name") || "").slice(0, 80),
        };
        void (window as unknown as { __understudyHumanEvent: (value: unknown) => Promise<void> }).__understudyHumanEvent(payload);
      };
      document.addEventListener("click", (event) => record("click", event), true);
      document.addEventListener("change", (event) => record("change", event), true);
    });
    // A second CDP client does not reliably trigger Playwright's exposed binding in every
    // frame. Navigation requests are observed by the owning context, so they provide a
    // provider-independent audit signal for a human-submitted form without storing fields.
    this.context.on("request", (request) => {
      if (this.automationInControl || !request.isNavigationRequest()) return;
      let destination = "[unavailable]";
      try {
        destination = new URL(request.url()).pathname.replace(/\d{3,10}/g, "[REDACTED]");
      } catch { /* retain the unavailable marker */ }
      this.humanEvents.push({
        at: new Date().toISOString(),
        kind: "navigation",
        method: request.method(),
        destination,
      });
    });
    await this.context.route("**/*", async (route) => {
      const request = route.request();
      if (request.isNavigationRequest() && request.resourceType() === "document") {
        const verdict = this.navigationGuard(request.url());
        if (!verdict.allow) {
          this.navigationViolation = verdict.reason ?? `Navigation denied: ${request.url()}`;
          await route.abort("blockedbyclient");
          return;
        }
      }
      await route.continue();
    });
    this.page = this.context.pages()[0] ?? await this.context.newPage();
    this.page.setDefaultTimeout(this.opts.defaultTimeoutMs);
    this.context.on("page", (popup) => {
      if (popup === this.page) return;
      this.navigationViolation = `Popup or new tab blocked by policy: ${popup.url() || "pending navigation"}`;
      void popup.close();
    });
  }

  private requirePage(): Page {
    if (!this.page) throw new Error("Surface not started. Call start() first.");
    return this.page;
  }

  async open(url: string): Promise<void> {
    await this.requirePage().goto(url, { waitUntil: "domcontentloaded" });
  }

  async currentLocation(): Promise<string> {
    return this.requirePage().url();
  }

  /* ---------------------------------------------------------------- frames */

  private frameLabel(f: Frame): string {
    const page = this.requirePage();
    if (f === page.mainFrame()) return "main";
    return f.name() || shortPath(f.url());
  }

  /**
   * Which frames a descriptor may be resolved in, in priority order.
   *
   * Note the deliberate fallthrough: with a frameset, the main frame holds no content, so
   * `strategy: "main"` cannot mean "only the main frame" without failing on a technicality.
   * It means "start at the top and keep looking".
   */
  private framesFor(target: ResolveTarget): Frame[] {
    const page = this.requirePage();
    const all = page.frames();
    switch (target.frame.strategy) {
      case "name": {
        const named = all.filter((f) => this.frameLabel(f) === target.frame.value);
        return named.length ? [...named, ...all.filter((f) => !named.includes(f))] : all;
      }
      case "url-contains": {
        const v = target.frame.value ?? "";
        const matched = all.filter((f) => f.url().includes(v));
        return matched.length ? [...matched, ...all.filter((f) => !matched.includes(f))] : all;
      }
      case "main":
      default:
        return [page.mainFrame(), ...all.filter((f) => f !== page.mainFrame())];
    }
  }

  /* ---------------------------------------------------------------- observe */

  async observe(): Promise<Observation> {
    const page = this.requirePage();
    const tree: AxNode[] = [];
    const notices: string[] = [];

    for (const frame of page.frames()) {
      const label = this.frameLabel(frame);
      let snapshot: string;
      try {
        snapshot = await frame.locator("body").ariaSnapshot({ timeout: 2500 });
      } catch {
        // Frames detach mid-navigation. Skipping is correct — recording a stale frame
        // would put phantom controls in front of the model.
        continue;
      }

      for (const n of parseAriaSnapshot(snapshot)) {
        const isActionable = ACTIONABLE_ROLES.has(n.role);
        const isInfo = INFORMATIONAL_ROLES.has(n.role);
        if (!isActionable && !isInfo) continue;
        if (!n.name && !n.value) continue;

        if ((n.role === "alert" || n.role === "status") && n.name) {
          if (!notices.includes(n.name)) notices.push(n.name);
        }

        tree.push({
          role: n.role,
          name: n.name,
          value: n.value,
          disabled: n.disabled,
          focusable: isActionable,
          frame: label,
          path: `${label}:${n.depth}`,
        });
      }

      // Legacy apps style an error div without any ARIA role at all, so the a11y tree alone
      // misses them. Notices drive business-outcome detection, which makes this worth a
      // second pass rather than accepting the gap.
      try {
        const texts = await frame.locator(".err, .warn, .ok, [role=alert]").allInnerTexts();
        for (const t of texts) {
          const clean = t.trim().replace(/\s+/g, " ");
          if (clean && !notices.includes(clean)) notices.push(clean);
        }
      } catch {
        /* frame detached */
      }
    }

    return {
      location: page.url(),
      title: await page.title().catch(() => ""),
      tree,
      notices,
      capturedAt: new Date().toISOString(),
    };
  }

  /* ---------------------------------------------------------------- resolve */

  /**
   * The resolution ladder.
   *
   * Primary strategy first, then the artifact's declared fallbacks in order. The winning
   * strategy is returned, not swallowed, so evidence shows when a replay degraded — a run
   * that only passed via the third fallback is a warning about the next run, and losing
   * that signal is how brittle capabilities stay green until they suddenly don't.
   */
  async resolve(target: ResolveTarget, opts: { deadlineMs?: number } = {}): Promise<ResolveResult> {
    const deadlineMs = Math.max(0, opts.deadlineMs ?? 0);
    const deadline = Date.now() + deadlineMs;
    let attempts = 0;
    for (;;) {
      attempts += 1;
      const result = await this.resolveOnce(target);
      if (result.found || Date.now() >= deadline) return { ...result, attempts };
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  }

  private async resolveOnce(target: ResolveTarget): Promise<ResolveResult> {
    for (const frame of this.framesFor(target)) {
      if (target.tableCell) {
        const relational = await this.tableCellLocator(frame, target.tableCell);
        const count = await relational.count().catch(() => 0);
        if (count === 1) {
          return {
            found: true,
            strategy: "table-cell",
            matchCount: 1,
            handle: relational,
            bounds: (await relational.boundingBox()) ?? undefined,
            detail: `${target.tableCell.rowLabel} × ${target.tableCell.columnLabel}`,
          };
        }
        // A relational descriptor is an invariant, not a hint. Falling through to a
        // generic `cell` lookup can silently read a layout cell from a nested legacy table.
        continue;
      }
      const primary = this.roleNameLocator(frame, target);
      if (primary) {
        const count = await primary.count().catch(() => 0);
        if (count > 0) {
          const idx = target.index ?? 0;
          if (idx < count) {
            return {
              found: true,
              strategy: "role-name",
              matchCount: count,
              handle: primary.nth(idx),
              bounds: (await primary.nth(idx).boundingBox()) ?? undefined,
              detail: `${target.role} "${target.name ?? ""}" in frame ${this.frameLabel(frame)}`,
            };
          }
        }
      }

      for (const fb of target.fallbacks) {
        const loc = this.fallbackLocator(frame, fb, target);
        if (!loc) continue;
        const count = await loc.count().catch(() => 0);
        if (count > 0) {
          return {
            found: true,
            strategy: `fallback:${fb.kind}`,
            matchCount: count,
            handle: loc.nth(target.index ?? 0),
            bounds: (await loc.nth(target.index ?? 0).boundingBox()) ?? undefined,
            detail: fb.note ?? fb.value,
          };
        }
      }
    }
    return { found: false, matchCount: 0, detail: describeTarget(target) };
  }

  private async tableCellLocator(
    frame: Frame,
    relation: { rowLabel: string; columnLabel: string; tableName?: string }
  ): Promise<Locator> {
    let tables = frame.locator("table");
    if (relation.tableName) tables = frame.getByRole("table", { name: relation.tableName });
    for (let index = 0; index < await tables.count(); index += 1) {
      const table = tables.nth(index);
      // Direct-child selectors matter: legacy pages routinely nest layout tables around
      // data grids. A descendant selector lets the outer table steal the inner grid's
      // headers and returns the entire profile cell instead of the requested balance.
      const rows = table.locator(":scope > thead > tr, :scope > tbody > tr, :scope > tr");
      let column = -1;
      for (let rowIndex = 0; rowIndex < await rows.count(); rowIndex += 1) {
        const headers = (await rows.nth(rowIndex).locator(":scope > th, :scope > [role=columnheader]").allInnerTexts().catch(() => []))
          .map((value) => value.trim().replace(/\s+/g, " "));
        column = headers.findIndex((header) => header.toLowerCase() === relation.columnLabel.toLowerCase());
        if (column >= 0) break;
      }
      if (column < 0) continue;
      const row = rows.filter({ hasText: new RegExp(`\\b${escapeRegExp(relation.rowLabel)}\\b`, "i") });
      if (await row.count() !== 1) continue;
      return row.locator(":scope > td, :scope > [role=cell]").nth(column);
    }
    return frame.locator("__understudy_missing_relational_cell__");
  }

  private roleNameLocator(frame: Frame, t: ResolveTarget): Locator | undefined {
    const role = t.role as Parameters<Frame["getByRole"]>[0];
    let scope: Frame | Locator = frame;
    if (t.within) {
      try {
        const withinRole = t.within.role as Parameters<Frame["getByRole"]>[0];
        let container: Locator = t.within.name
          ? frame.getByRole(withinRole, { name: t.within.name })
          : frame.getByRole(withinRole);
        // Filtering by contained text is what makes grid targeting work without test IDs:
        // "the row that mentions SAVINGS" is stable across members, where the row's own
        // accessible name (which includes the balance) is not.
        if (t.within.hasText) container = container.filter({ hasText: t.within.hasText });
        scope = container;
      } catch {
        return undefined;
      }
    }
    try {
      if (t.name === undefined) return scope.getByRole(role);
      if (t.nameMatch === "exact") return scope.getByRole(role, { name: t.name, exact: true });
      if (t.nameMatch === "contains") return scope.getByRole(role, { name: t.name });
      return scope.getByRole(role, { name: new RegExp(t.name, "i") });
    } catch {
      return undefined;
    }
  }

  private fallbackLocator(
    frame: Frame,
    fb: { kind: string; value: string },
    t: ResolveTarget
  ): Locator | undefined {
    try {
      switch (fb.kind) {
        case "role-name":
          // Same role, relaxed to substring. Absorbs a relabel like "Member ID" ->
          // "Member ID:" or a per-tenant rename that still contains the original word.
          return frame.getByRole(t.role as Parameters<Frame["getByRole"]>[0], { name: fb.value });
        case "label":
          return frame.getByLabel(fb.value);
        case "placeholder":
          return frame.getByPlaceholder(fb.value);
        case "text":
          return frame.getByText(fb.value);
        case "css":
          return frame.locator(fb.value);
        case "xpath":
          return frame.locator(`xpath=${fb.value}`);
        default:
          return undefined;
      }
    } catch {
      return undefined;
    }
  }

  /* ---------------------------------------------------------------- act */

  private async handleFor(target: ResolveTarget): Promise<Locator> {
    this.assertControl();
    const r = await this.resolve(target, { deadlineMs: this.opts.defaultTimeoutMs });
    if (!r.found || !r.handle) throw new TargetNotFoundError(describeTarget(target));
    if (r.matchCount > 1 && target.index === undefined) {
      throw new Error(`Ambiguous control: ${describeTarget(target)} matched ${r.matchCount} elements`);
    }
    this.pendingResolutionDiagnostic = { attempts: r.attempts ?? 1, strategy: r.strategy };
    return r.handle as Locator;
  }

  /**
   * Guard every action on who holds control.
   *
   * Without this, a run that resumes early races a human who is still typing. Checking in
   * one place rather than at call sites is the only version of this that stays true.
   */
  private assertControl(): void {
    if (!this.automationInControl) {
      throw new Error("Automation does not hold control of this session; a human has it.");
    }
  }

  async click(target: ResolveTarget): Promise<void> {
    const loc = await this.handleFor(target);
    await loc.click({ timeout: this.opts.defaultTimeoutMs });
  }

  async humanAct(action: HumanAction): Promise<void> {
    if (this.automationInControl) {
      throw new Error("Human action refused while automation owns the session.");
    }
    let role: string | undefined;
    let label: string | undefined;
    let textLength: number | undefined;

    if (action.kind === "press") {
      await this.requirePage().keyboard.press(action.key);
      label = action.key;
    } else {
      const resolved = await this.resolve(action.target, { deadlineMs: this.opts.defaultTimeoutMs });
      if (!resolved.found || !resolved.handle) throw new TargetNotFoundError(describeTarget(action.target));
      if (resolved.matchCount > 1 && action.target.index === undefined) {
        throw new Error(`Ambiguous operator target: ${describeTarget(action.target)} matched ${resolved.matchCount} elements`);
      }
      const locator = resolved.handle as Locator;
      role = action.target.role;
      label = action.target.name;
      if (action.kind === "click") {
        await locator.click({ timeout: this.opts.defaultTimeoutMs });
      } else {
        await locator.fill(action.text, { timeout: this.opts.defaultTimeoutMs });
        textLength = action.text.length;
      }
    }

    this.humanEvents.push({
      at: new Date().toISOString(), kind: action.kind, role, label, textLength, source: "operator-console",
    });
  }

  async humanClick(target: ResolveTarget): Promise<void> {
    await this.humanAct({ kind: "click", target });
  }

  async type(target: ResolveTarget, text: string): Promise<void> {
    const loc = await this.handleFor(target);
    await loc.fill(text, { timeout: this.opts.defaultTimeoutMs });
  }

  async press(key: string): Promise<void> {
    this.assertControl();
    await this.requirePage().keyboard.press(key);
  }

  async read(target: ResolveTarget): Promise<string> {
    const loc = await this.handleFor(target);
    const text = (await loc.innerText().catch(async () => (await loc.textContent()) ?? "")) ?? "";
    return text.trim().replace(/\s+/g, " ");
  }

  async waitForSettled(timeoutMs: number): Promise<void> {
    const page = this.requirePage();
    await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => {});
    // networkidle hangs on apps that long-poll, which enterprise consoles routinely do.
    // A short quiet period is a better proxy and cannot stall the run.
    await page.waitForTimeout(200);
  }

  async screenshot(path: string): Promise<void> {
    await this.requirePage()
      .screenshot({ path, fullPage: true })
      .catch(() => {});
  }

  async screenshotBuffer(): Promise<Buffer> {
    return this.requirePage().screenshot({ fullPage: true, type: "png" });
  }

  setNavigationGuard(guard: (url: string) => { allow: boolean; reason?: string }): void {
    this.navigationGuard = guard;
  }

  async assertPolicyBoundary(): Promise<void> {
    if (!this.navigationViolation) return;
    const violation = this.navigationViolation;
    this.navigationViolation = undefined;
    throw new Error(`Policy denied navigation: ${violation}`);
  }

  /* ---------------------------------------------------------------- control transfer */

  async cedeControl(): Promise<void> {
    this.humanEvents.length = 0;
    this.automationInControl = false;
  }

  async resumeControl(): Promise<void> {
    this.automationInControl = true;
  }

  isAutomationInControl(): boolean {
    return this.automationInControl;
  }

  collectHumanEvents(): unknown[] {
    return [...this.humanEvents];
  }

  consumeResolutionDiagnostic(): { attempts: number; strategy?: string } | undefined {
    const diagnostic = this.pendingResolutionDiagnostic;
    this.pendingResolutionDiagnostic = undefined;
    return diagnostic;
  }

  /**
   * Where an operator attaches to take over.
   *
   * This is the real seam. `chromium.connectOverCDP(endpoint)` from an operator console sees
   * the same persistent context and page state — not a lookalike session. In
   * headed mode the human can simply use the window that is already open.
   */
  liveSessionEndpoint(): string | undefined {
    return this.cdpEndpoint;
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    if (this.userDataDir) await rm(this.userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

export class TargetNotFoundError extends Error {
  constructor(public readonly descriptor: string) {
    super(`Could not resolve control: ${descriptor}`);
    this.name = "TargetNotFoundError";
  }
}

/* ---------------------------------------------------------------- helpers */

function shortPath(u: string): string {
  try {
    return new URL(u).pathname || "/";
  } catch {
    return u.slice(0, 40);
  }
}

async function availablePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a CDP port"));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

export function describeTarget(t: ResolveTarget): string {
  const bits = [`role=${t.role}`];
  if (t.tableCell) bits.push(`tableCell=${t.tableCell.rowLabel}×${t.tableCell.columnLabel}`);
  if (t.name) bits.push(`name~${t.nameMatch}~"${t.name}"`);
  if (t.within)
    bits.push(
      `within=${t.within.role}"${t.within.name ?? ""}"${t.within.hasText ? `[hasText:"${t.within.hasText}"]` : ""}`
    );
  if (t.index !== undefined) bits.push(`index=${t.index}`);
  bits.push(`frame=${t.frame.strategy}${t.frame.value ? `:${t.frame.value}` : ""}`);
  return bits.join(" ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
