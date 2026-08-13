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
 * The browser is launched as a *server* rather than in-process. That is what makes the
 * human-handoff claim real: the operator connects to the same `wsEndpoint`, so they get the
 * same browser, same cookies, same half-filled form — not a fresh session that merely looks
 * similar.
 */

import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserServer,
  type Frame,
  type Locator,
  type Page,
} from "playwright";
import type { AxNode, Observation, ResolveResult, ResolveTarget, Surface } from "./surface.js";
import { ACTIONABLE_ROLES, INFORMATIONAL_ROLES, parseAriaSnapshot } from "./aria-snapshot.js";

export interface WebSurfaceOptions {
  headless?: boolean;
  /** Slows actions so a watching human can follow a discovery run. Demo only. */
  slowMoMs?: number;
  defaultTimeoutMs?: number;
}

export class WebSurface implements Surface {
  readonly kind = "legacy-web" as const;

  private server?: BrowserServer;
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private automationInControl = true;
  private readonly opts: Required<WebSurfaceOptions>;

  constructor(opts: WebSurfaceOptions = {}) {
    this.opts = {
      headless: opts.headless ?? true,
      slowMoMs: opts.slowMoMs ?? 0,
      defaultTimeoutMs: opts.defaultTimeoutMs ?? 8000,
    };
  }

  async start(): Promise<void> {
    this.server = await chromium.launchServer({ headless: this.opts.headless });
    // slowMo belongs to the *client* connection, not the server. Worth noting because it
    // means the pacing is a property of who is driving, which is exactly right here: a
    // human taking over should not inherit the automation's artificial delay.
    this.browser = await chromium.connect(this.server.wsEndpoint(), {
      slowMo: this.opts.slowMoMs,
    });
    this.context = await this.browser.newContext({ viewport: { width: 1280, height: 900 } });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(this.opts.defaultTimeoutMs);
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
  async resolve(target: ResolveTarget): Promise<ResolveResult> {
    for (const frame of this.framesFor(target)) {
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
            detail: fb.note ?? fb.value,
          };
        }
      }
    }
    return { found: false, matchCount: 0, detail: describeTarget(target) };
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
    const r = await this.resolve(target);
    if (!r.found || !r.handle) throw new TargetNotFoundError(describeTarget(target));
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

  /* ---------------------------------------------------------------- control transfer */

  async cedeControl(): Promise<void> {
    this.automationInControl = false;
  }

  async resumeControl(): Promise<void> {
    this.automationInControl = true;
  }

  isAutomationInControl(): boolean {
    return this.automationInControl;
  }

  /**
   * Where an operator attaches to take over.
   *
   * This is the real seam. `chromium.connect(endpoint)` from an operator console yields the
   * same browser, the same context and the same page state — not a lookalike session. In
   * headed mode the human can simply use the window that is already open.
   */
  liveSessionEndpoint(): string | undefined {
    return this.server?.wsEndpoint();
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    await this.server?.close().catch(() => {});
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

export function describeTarget(t: ResolveTarget): string {
  const bits = [`role=${t.role}`];
  if (t.name) bits.push(`name~${t.nameMatch}~"${t.name}"`);
  if (t.within)
    bits.push(
      `within=${t.within.role}"${t.within.name ?? ""}"${t.within.hasText ? `[hasText:"${t.within.hasText}"]` : ""}`
    );
  if (t.index !== undefined) bits.push(`index=${t.index}`);
  bits.push(`frame=${t.frame.strategy}${t.frame.value ? `:${t.frame.value}` : ""}`);
  return bits.join(" ");
}
