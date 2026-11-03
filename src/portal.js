// PizzaResolve customer portal (synthetic demo accounts only). The PIN is checked here, outside the chat,
// and the customer receives a single-use login code that the Talkdesk agent redeems via get_customer_context.
const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const shell = (body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PizzaResolve Login</title>
<style>:root{--bg:#fff;--fg:#1d1b20;--muted:#5f5b66;--line:#ddd8e3;--accent:#5b1fd6}@media (prefers-color-scheme:dark){:root{--bg:#141218;--fg:#ece6f0;--muted:#b5adbd;--line:#3a3540;--accent:#b79cff}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}main{max-width:420px;margin:48px auto;padding:0 16px}h1{font-size:22px;margin:0 0 4px}p{color:var(--muted)}
label{display:block;margin-top:16px;font-weight:600}input{width:100%;box-sizing:border-box;padding:10px;margin-top:6px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font-size:16px}
button{margin-top:20px;width:100%;padding:12px;border:0;border-radius:8px;background:var(--accent);color:#fff;font-size:16px;font-weight:600}.code{font:700 28px/1.2 ui-monospace,monospace;letter-spacing:2px;padding:16px;border:2px dashed var(--accent);border-radius:10px;text-align:center;margin:16px 0}
small{color:var(--muted)}</style></head><body><main>${body}<p><small>Team CodeVerse hackathon demo. Synthetic accounts only; no real customer data.</small></p></main></body></html>`;

export function portalPage() {
  return shell(`<h1>PizzaResolve sign-in</h1><p>Sign in to get help with an order. Our support assistant will already know who you are, so you won't have to repeat your details.</p>
<form method="post" action="/portal/login" autocomplete="off"><label for="l">Login ID</label><input id="l" name="login_id" required maxlength="40" pattern="[A-Za-z0-9._-]{3,40}">
<label for="p">PIN</label><input id="p" name="pin" type="password" inputmode="numeric" required pattern="[0-9]{4,6}" maxlength="6"><button type="submit">Sign in</button></form>`);
}
export function portalResult(r) {
  if (r.ok) return shell(`<h1>You're signed in</h1><p>Open PizzaResolve chat and send this one-time code. It works once and expires in 15 minutes.</p><div class="code">${esc(r.login_code)}</div><p>Example: "Hi, my login code is ${esc(r.login_code)}, my order hasn't arrived."</p><p><a href="/portal" style="color:var(--accent)">Sign in again</a></p>`);
  const why = { BAD_CREDENTIALS: "That login ID and PIN don't match.", LOCKED: "Too many attempts. Please wait 30 minutes and try again.", RATE_LIMITED: "Too many attempts from this device. Please wait a minute.", INVALID_INPUT: "Please enter your login ID and a 4 to 6 digit PIN.", SYSTEM_UNAVAILABLE: "Our account system isn't responding. Please try again shortly.", RETRY: "Please try again." }[r.reason] || "Sign-in failed.";
  return shell(`<h1>Sign-in failed</h1><p>${esc(why)}</p><p><a href="/portal" style="color:var(--accent)">Try again</a></p>`);
}
