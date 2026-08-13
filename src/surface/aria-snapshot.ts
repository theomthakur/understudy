/**
 * Parser for Playwright's aria snapshot format.
 *
 * `locator.ariaSnapshot()` returns an indented YAML-ish rendering of the accessibility tree:
 *
 *   - banner:
 *     - heading "Member Search" [level=2]
 *   - textbox "Member ID"
 *   - button "Search"
 *   - text: Enter a member number to open the servicing workspace.
 *
 * We parse it into a flat list of controls because that is what both the discovery prompt
 * and the replay resolver actually consume. Structure beyond "which region am I in" is not
 * used, so keeping the tree would be carrying weight for nothing.
 *
 * This is the one place in the codebase that knows the snapshot syntax. If Playwright
 * changes it, or a desktop surface produces a different shape, only this file moves.
 */

export interface ParsedNode {
  role: string;
  name: string;
  value?: string;
  disabled?: boolean;
  depth: number;
  /** Nearest enclosing named container, used for `within` scoping. */
  container?: string;
}

const LINE = /^(\s*)-\s+([a-zA-Z]+)(?:\s+"((?:[^"\\]|\\.)*)")?(?:\s+\[([^\]]*)\])?(:?)\s*(.*)$/;

export function parseAriaSnapshot(snapshot: string): ParsedNode[] {
  const out: ParsedNode[] = [];
  // Stack of [depth, containerName] so a node can report what region it sits in.
  const containers: { depth: number; name: string }[] = [];

  for (const rawLine of snapshot.split("\n")) {
    if (!rawLine.trim()) continue;
    const m = LINE.exec(rawLine);
    if (!m) continue;

    const indent = m[1] ?? "";
    const role = m[2] ?? "";
    const name = unescape(m[3] ?? "");
    const attrs = m[4] ?? "";
    const trailing = (m[6] ?? "").trim();
    const depth = Math.floor(indent.length / 2);

    while (containers.length && containers[containers.length - 1]!.depth >= depth) {
      containers.pop();
    }

    // `- text: some content` carries its content after the colon rather than in quotes.
    const isTextNode = role === "text";
    const effectiveName = isTextNode ? trailing : name;

    const node: ParsedNode = {
      role,
      name: effectiveName,
      depth,
      container: containers[containers.length - 1]?.name,
    };

    if (attrs) {
      if (/\bdisabled\b/.test(attrs)) node.disabled = true;
      const valueMatch = /\bvalue=(?:"([^"]*)"|(\S+))/.exec(attrs);
      if (valueMatch) node.value = valueMatch[1] ?? valueMatch[2];
      const checked = /\bchecked\b/.test(attrs);
      if (checked) node.value = node.value ?? "checked";
    }

    // A node that opens a block becomes the container for what follows. Landmark roles
    // (banner, main, navigation) usually have no accessible name, so fall back to the role
    // itself — "inside the banner" is still useful scoping information.
    if (m[5] === ":") {
      containers.push({ depth, name: effectiveName || role });
    }

    out.push(node);
  }
  return out;
}

function unescape(s: string): string {
  return s.replace(/\\(.)/g, "$1").trim().replace(/\s+/g, " ");
}

/**
 * Roles worth showing a decision-maker.
 *
 * Excluding layout noise matters more than it looks: a legacy grid emits hundreds of `cell`
 * nodes, and a prompt full of table cells crowds out the controls that can actually be
 * acted on.
 */
export const ACTIONABLE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "menuitem",
  "tab",
  "option",
]);

export const INFORMATIONAL_ROLES = new Set([
  "heading",
  "alert",
  "status",
  "cell",
  "rowheader",
  "columnheader",
  "text",
  "paragraph",
]);
