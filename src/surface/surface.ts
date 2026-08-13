/**
 * The surface seam.
 *
 * This interface is the whole answer to "how does this extend to legacy web and desktop?".
 *
 * Everything above it — the artifact schema, the replay engine, the policy layer, the
 * discovery agent — is written against `Surface` and knows nothing about Playwright, the
 * DOM, or even that there is a browser. A surface is anything that can:
 *
 *   - describe what a human would currently perceive  (observe)
 *   - resolve a semantic description to a real control (resolve)
 *   - act on that control                              (click / type / press / read)
 *
 * Those three capabilities exist on a modern web app, on a frameset-and-tables legacy app,
 * and on a native desktop app via the platform accessibility APIs. That is why the
 * observation model below is an accessibility-node tree rather than HTML: HTML is the one
 * representation that does *not* generalise.
 *
 * A desktop implementation would be a new class here (`Win32Surface`, `AXSurface`) and
 * nothing else in the codebase would change. That is the claim, and this file is where it
 * is made checkable.
 */

export interface AxNode {
  /** ARIA-style role: "button", "textbox", "link", "cell", "heading", ... */
  role: string;
  /** Accessible name — the text a human reads to identify the control. */
  name: string;
  value?: string;
  /** Only present for controls a human could act on. */
  focusable?: boolean;
  disabled?: boolean;
  /** Frame identity, so cross-frame legacy apps stay addressable. */
  frame: string;
  /** Stable-ish path used only for logging and disambiguation, never persisted as a locator. */
  path: string;
  children?: AxNode[];
}

export interface Observation {
  /** Where we are. For desktop this would be the window/app identity. */
  location: string;
  title: string;
  /** The perceivable control tree, pruned to what matters. */
  tree: AxNode[];
  /** Visible alert/status text, extracted separately because it drives outcome detection. */
  notices: string[];
  capturedAt: string;
}

export interface ResolveTarget {
  role: string;
  name?: string;
  nameMatch: "exact" | "contains" | "regex";
  index?: number;
  within?: { role: string; name?: string; hasText?: string };
  frame: { strategy: "main" | "name" | "url-contains"; value?: string };
  fallbacks: { kind: string; value: string; note?: string }[];
}

export interface ResolveResult {
  found: boolean;
  /** Which strategy in the ladder succeeded. Recorded so flakiness is visible in evidence. */
  strategy?: string;
  /** How many candidates matched. >1 means the descriptor is ambiguous. */
  matchCount: number;
  handle?: unknown;
  detail?: string;
}

export interface Surface {
  readonly kind: "web" | "legacy-web" | "desktop";

  open(url: string): Promise<void>;
  observe(): Promise<Observation>;

  resolve(target: ResolveTarget): Promise<ResolveResult>;

  click(target: ResolveTarget): Promise<void>;
  type(target: ResolveTarget, text: string): Promise<void>;
  press(key: string): Promise<void>;
  /** Returns the text a human would read from the control. */
  read(target: ResolveTarget): Promise<string>;

  waitForSettled(timeoutMs: number): Promise<void>;
  currentLocation(): Promise<string>;

  screenshot(path: string): Promise<void>;
  close(): Promise<void>;

  /**
   * Control transfer for human handoff.
   *
   * `cedeControl` must leave the session *alive and usable by a person*. It does not
   * create a new session — the entire point is that the human continues in the same one,
   * with the same cookies, same frame state, same half-filled form.
   */
  cedeControl(): Promise<void>;
  resumeControl(): Promise<void>;
  isAutomationInControl(): boolean;
}
