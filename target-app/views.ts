/**
 * Deliberately legacy markup.
 *
 * This is a stand-in for the class of app the brief describes: server-rendered,
 * table-based layout, non-semantic wrappers, no test IDs, generated ids that look
 * stable but are not, and a frameset on the member workspace.
 *
 * What is intentionally hostile here:
 *   - zero data-testid / data-* hooks
 *   - ids like "ctl00_MainPlaceHolder_grdResults_ctl03_lnkView" (ASP.NET-flavoured,
 *     index-bearing, and therefore unstable across result sets)
 *   - deeply nested tables used for layout
 *   - a frameset on the member workspace, so the interesting content is cross-frame
 *   - visually-styled <span> and <td> acting as buttons alongside real controls
 *
 * What is deliberately NOT hostile: accessible names. Real enterprise apps have
 * visible labels because humans have to read them, and that is exactly why the
 * accessibility tree is a more durable perception surface than the markup.
 */

const CHROME_CSS = `
  body { font-family: Verdana, Geneva, sans-serif; font-size: 12px; margin: 0; background: #eef1f5; color: #10151c; }
  .appbar { background: #14324f; color: #fff; padding: 6px 10px; font-weight: bold; letter-spacing: .3px; }
  .appbar .tenant { float: right; font-weight: normal; opacity: .85; }
  table.layout { border-collapse: collapse; width: 100%; }
  table.grid { border-collapse: collapse; margin-top: 8px; background: #fff; }
  table.grid th { background: #d7dee7; text-align: left; padding: 4px 8px; border: 1px solid #9fadbd; font-size: 11px; }
  table.grid td { padding: 4px 8px; border: 1px solid #c3ccd8; }
  .panel { background: #fff; border: 1px solid #a9b5c4; padding: 10px; margin: 10px; }
  .panel .hdr { background: #4a6customs; }
  h2 { font-size: 14px; margin: 0 0 8px 0; border-bottom: 2px solid #14324f; padding-bottom: 3px; }
  input[type=text] { border: 1px solid #7f8fa3; padding: 3px; font-family: inherit; font-size: 12px; }
  .btn { background: #1f5fa9; color: #fff; border: 1px solid #163f70; padding: 3px 12px; font-family: inherit; font-size: 12px; cursor: pointer; }
  .err { background: #ffe9e9; border: 1px solid #c0392b; color: #8e2b20; padding: 6px 8px; margin: 8px 0; }
  .warn { background: #fff7e0; border: 1px solid #d19a1d; color: #7a5b0d; padding: 6px 8px; margin: 8px 0; }
  .ok { background: #e8f7ec; border: 1px solid #2e8b57; color: #1c5c38; padding: 6px 8px; margin: 8px 0; }
  a { color: #1f5fa9; }
  .navlink { display: inline-block; margin-right: 14px; }
  .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.35); }
  .modal { position: fixed; top: 28%; left: 50%; transform: translateX(-50%); background: #fff;
           border: 2px solid #14324f; padding: 14px 18px; min-width: 320px; }
`;

export function chrome(opts: {
  title: string;
  tenant: string;
  body: string;
  banner?: string;
}): string {
  return `<!DOCTYPE html>
<html><head><title>${opts.title}</title><style>${CHROME_CSS}</style></head>
<body>
<div class="appbar">${opts.tenant} &mdash; Back Office Console <span class="tenant">Operator: svc.automation</span></div>
${opts.banner ?? ""}
${opts.body}
</body></html>`;
}

/** Landing / member search. Table-based layout, no test ids. */
export function searchPage(tenant: string, error?: string, inputDelayMs = 0): string {
  const memberInput = '<input type="text" id="ctl00_MainPlaceHolder_txtMemberId" name="memberId" size="18" autocomplete="off">';
  const renderedInput = inputDelayMs > 0
    ? `<span id="delayed-member-input"></span><script>
         setTimeout(function () {
           var slot = document.getElementById("delayed-member-input");
           if (slot) { slot.insertAdjacentHTML("beforebegin", ${JSON.stringify(memberInput)}); slot.remove(); }
         }, ${inputDelayMs});
       </script>`
    : memberInput;
  return chrome({
    title: "Member Search",
    tenant,
    body: `
<div class="panel">
  <h2>Member Search</h2>
  ${error ? `<div class="err" role="alert">${error}</div>` : ""}
  <form method="GET" action="/members/lookup">
    <table class="layout" style="width:auto">
      <tr>
        <td><label for="ctl00_MainPlaceHolder_txtMemberId">Member ID</label></td>
        <td>${renderedInput}</td>
        <td><input type="submit" class="btn" id="ctl00_MainPlaceHolder_btnSearch" value="Search"></td>
      </tr>
    </table>
  </form>
  <p style="color:#5b6775;margin-top:12px">Enter a member number to open the servicing workspace.</p>
</div>`,
  });
}

/** Frameset workspace. The interesting content lives in the detail frame. */
export function workspaceFrameset(tenant: string, memberId: string): string {
  return `<!DOCTYPE html>
<html><head><title>Member Workspace ${memberId}</title></head>
<frameset rows="34,*" frameborder="1" border="1">
  <frame name="hdr" src="/frame/header?memberId=${encodeURIComponent(memberId)}" scrolling="no">
  <frame name="detail" src="/frame/member?memberId=${encodeURIComponent(memberId)}">
</frameset>
</html>`;
}

export function headerFrame(tenant: string, memberId: string): string {
  return chrome({
    title: "hdr",
    tenant,
    body: `<div style="padding:6px 10px;background:#dfe5ec;border-bottom:1px solid #a9b5c4">
      <span class="navlink"><a href="/" target="_top">Member Search</a></span>
      <span class="navlink">Workspace: ${memberId}</span>
    </div>`,
  });
}

export interface DetailView {
  tenant: string;
  memberId: string;
  fullName: string;
  branch: string;
  joinedOn: string;
  maskedSsn: string;
  accounts: { accountNumber: string; type: string; balance: string; status: string }[];
  notice?: { kind: "err" | "warn" | "ok"; text: string };
}

/** Member detail. Nested tables, index-bearing ids, span-as-button. */
export function memberDetailFrame(v: DetailView): string {
  const rows = v.accounts
    .map(
      (a, i) => `
      <tr>
        <td>${a.accountNumber}</td>
        <td>${a.type}</td>
        <td align="right" id="ctl00_MainPlaceHolder_grdAccounts_ctl0${i + 2}_lblBalance">${a.balance}</td>
        <td>${a.status}</td>
        <td><a href="/accounts/${encodeURIComponent(a.accountNumber)}?memberId=${encodeURIComponent(
          v.memberId
        )}" id="ctl00_MainPlaceHolder_grdAccounts_ctl0${i + 2}_lnkView">View</a></td>
      </tr>`
    )
    .join("");

  return chrome({
    title: `Member ${v.memberId}`,
    tenant: v.tenant,
    body: `
<div class="panel">
  <h2>Member Profile</h2>
  ${v.notice ? `<div class="${v.notice.kind}" role="alert">${v.notice.text}</div>` : ""}
  <table class="layout"><tr><td width="55%" valign="top">
    <table class="grid">
      <tr><th>Member ID</th><td>${v.memberId}</td></tr>
      <tr><th>Name</th><td>${v.fullName}</td></tr>
      <tr><th>Branch</th><td>${v.branch}</td></tr>
      <tr><th>Joined</th><td>${v.joinedOn}</td></tr>
      <tr><th>SSN</th><td>${v.maskedSsn}</td></tr>
    </table>
  </td><td valign="top">
    <table class="grid">
      <tr><th colspan="5">Accounts</th></tr>
      <tr><th>Account</th><th>Type</th><th>Balance</th><th>Status</th><th></th></tr>
      ${rows}
    </table>
  </td></tr></table>
  <div style="margin-top:12px">
    <form method="POST" action="/members/${encodeURIComponent(v.memberId)}/subaccount" style="display:inline">
      <input type="submit" class="btn" id="ctl00_MainPlaceHolder_btnOpenSub" value="Open Sub-Account">
    </form>
    <span style="margin-left:10px;color:#5b6775">Opening a sub-account requires confirmation.</span>
  </div>
</div>`,
  });
}

export function accountDetailFrame(v: {
  tenant: string;
  memberId: string;
  accountNumber: string;
  type: string;
  balance: string;
  status: string;
  openedOn: string;
}): string {
  return chrome({
    title: `Account ${v.accountNumber}`,
    tenant: v.tenant,
    body: `
<div class="panel">
  <h2>Account Detail</h2>
  <table class="grid">
    <tr><th>Account Number</th><td>${v.accountNumber}</td></tr>
    <tr><th>Account Type</th><td>${v.type}</td></tr>
    <tr><th>Current Balance</th><td id="ctl00_MainPlaceHolder_lblCurrentBalance">${v.balance}</td></tr>
    <tr><th>Status</th><td>${v.status}</td></tr>
    <tr><th>Opened</th><td>${v.openedOn}</td></tr>
  </table>
  <p style="margin-top:10px"><a href="/frame/member?memberId=${encodeURIComponent(
    v.memberId
  )}">Back to Member Profile</a></p>
</div>`,
  });
}

/** Confirmation interstitial for the irreversible action. */
export function confirmSubAccount(tenant: string, memberId: string): string {
  return chrome({
    title: "Confirm Sub-Account",
    tenant,
    body: `
<div class="panel">
  <h2>Confirm New Sub-Account</h2>
  <div class="warn" role="alert">This action opens a new account and cannot be undone from this screen.</div>
  <form method="POST" action="/members/${encodeURIComponent(memberId)}/subaccount/confirm">
    <table class="layout" style="width:auto">
      <tr>
        <td><label for="ctl00_MainPlaceHolder_txtNickname">Sub-Account Nickname</label></td>
        <td><input type="text" id="ctl00_MainPlaceHolder_txtNickname" name="nickname" size="24"></td>
      </tr>
    </table>
    <p>
      <input type="submit" class="btn" id="ctl00_MainPlaceHolder_btnConfirm" value="Confirm and Open">
      <a href="/frame/member?memberId=${encodeURIComponent(memberId)}" style="margin-left:12px">Cancel</a>
    </p>
  </form>
</div>`,
  });
}

export function sessionExpired(tenant: string): string {
  return chrome({
    title: "Session Expired",
    tenant,
    body: `
<div class="panel">
  <h2>Session Expired</h2>
  <div class="err" role="alert">Your session has timed out due to inactivity. Please sign in again.</div>
  <p><a href="/?resume=1" id="ctl00_lnkSignIn">Return to sign in</a></p>
</div>`,
  });
}

export function permissionDenied(tenant: string, memberId: string): string {
  return chrome({
    title: "Not Authorized",
    tenant,
    body: `
<div class="panel">
  <h2>Not Authorized</h2>
  <div class="err" role="alert">You do not have permission to view member ${memberId}. This record is restricted.</div>
  <p><a href="/">Return to Member Search</a></p>
</div>`,
  });
}

export function appError(tenant: string): string {
  return chrome({
    title: "Application Error",
    tenant,
    body: `
<div class="panel">
  <h2>Application Error</h2>
  <div class="err" role="alert">An unexpected error occurred (ref 0x8007F1A2). Contact the service desk.</div>
</div>`,
  });
}
