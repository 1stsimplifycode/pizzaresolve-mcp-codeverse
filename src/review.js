// PizzaResolve human review console (Team CodeVerse): the human side of Human–AI collaboration.
// Auth: REVIEWER_KEY (env) -> HMAC-signed, HttpOnly, SameSite=Strict cookie carrying the reviewer's name.
// Every button posts to the backend, which re-validates state and executes the real operation.
import crypto from "node:crypto";

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const KEY = () => process.env.REVIEWER_KEY || "";
const sign = (payload) => crypto.createHmac("sha256", KEY()).update(payload).digest("base64url");

export function makeCookie(actor) {
  const payload = Buffer.from(JSON.stringify({ a: actor, exp: Date.now() + 4 * 3600e3 })).toString("base64url");
  return "pzrev=" + payload + "." + sign(payload) + "; HttpOnly; Secure; SameSite=Strict; Path=/review; Max-Age=14400";
}
export function readCookie(req) {
  if (!KEY()) return null;
  const m = /(?:^|;\s*)pzrev=([^;]+)/.exec(String(req.headers.cookie || ""));
  if (!m) return null;
  const [payload, sig] = m[1].split(".");
  const want = sign(payload || "");
  if (!sig || sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try { const o = JSON.parse(Buffer.from(payload, "base64url").toString()); return o.exp > Date.now() ? o.a : null; } catch { return null; }
}
export function keyOk(k) {
  const want = KEY(); if (!want) return false;
  const a = Buffer.from(String(k || "")), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const css = `:root{--bg:#fff;--fg:#1d1b20;--muted:#5f5b66;--line:#e3dfe8;--card:#faf8fc;--accent:#5b1fd6;--ok:#1b7a3a;--warn:#9a5b00;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#141218;--fg:#ece6f0;--muted:#b5adbd;--line:#3a3540;--card:#1d1a22;--accent:#b79cff;--ok:#7fd99a;--warn:#f0b65c;--bad:#ff8a80}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}main{max-width:980px;margin:24px auto;padding:0 16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:0}p.m,small{color:var(--muted)}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin:14px 0}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.pill{font-size:12px;padding:2px 8px;border-radius:99px;border:1px solid var(--line)}
.AWAITING_HUMAN_REVIEW{color:var(--warn)}.RESOLVED{color:var(--ok)}.FAILED,.REJECTED{color:var(--bad)}
button{font:inherit;padding:6px 12px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg);cursor:pointer}button.p{background:var(--accent);color:#fff;border-color:var(--accent)}
input,select{font:inherit;padding:6px 8px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg);max-width:100%}
pre{white-space:pre-wrap;word-break:break-word;font-size:12px;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px;margin:6px 0}
table{border-collapse:collapse;width:100%}td{border-bottom:1px solid var(--line);padding:4px 6px;font-size:13px;vertical-align:top}.msg{border-left:4px solid var(--accent);padding:8px 12px;margin:12px 0;background:var(--card)}`;
const shell = (body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PizzaResolve Review</title><style>${css}</style></head><body><main>${body}</main></body></html>`;

export function loginPage(msg = "") {
  return shell(`<h1>PizzaResolve review console</h1><p class="m">Team CodeVerse. Human side of the Human–AI resolution system. Synthetic data only.</p>
${msg ? `<div class="msg">${esc(msg)}</div>` : ""}${KEY() ? "" : `<div class="msg">Reviewer access is not configured yet (REVIEWER_KEY is not set on the server).</div>`}
<form class="card" method="post" action="/review/login"><div class="row"><label>Your name <input name="actor" required maxlength="40"></label>
<label>Reviewer key <input name="key" type="password" required></label><button class="p">Sign in</button></div></form>`);
}

const OPS = ["REFUND", "REPLACEMENT", "REDELIVERY", "COUPON"];
export function consolePage(actor, cases, metrics, msg = "") {
  const list = cases.map((c) => {
    const pending = c.meta.pending;
    const ev = c.ev || {};
    const hist = (c.meta.hist || []).slice().reverse().map((h) => `<tr><td>${esc(h.t)}</td><td>${esc(h.by)}</td><td>${esc(h.op || "")}</td><td>${esc(h.mode || "")} ${esc(h.outcome || "")}</td></tr>`).join("");
    const form = (action, label, cls = "", extra = "") => `<form method="post" action="/review/decide" style="display:inline"><input type="hidden" name="case_id" value="${esc(c.key)}"><input type="hidden" name="action" value="${action}">${extra}<button class="${cls}">${label}</button></form>`;
    return `<section class="card"><div class="row"><h2>${esc(c.key)}</h2><span class="pill ${esc(c.status)}">${esc(String(c.status || "").replace(/_/g, " "))}</span><span class="pill">mode: ${esc(c.decision || "")}</span><span class="pill">owner: ${esc(c.meta.owner_name || c.meta.owner || "AI")}</span></div>
<p class="m">Customer ${esc(c.customer_id)} · reference ${esc(c.ref)} · order ${esc(c.order_id || "-")}</p>
${pending ? `<p><b>AI proposal:</b> ${esc(pending.op)}${pending.amount_paise ? " · Rs " + (pending.amount_paise / 100).toFixed(2) : ""} · proposed ${esc(pending.proposed_at)}</p>` : ""}
${ev.reasons ? `<p><b>Why a human is needed:</b> ${esc(ev.reasons.join("; "))}</p>` : ""}${ev.ai_summary ? `<p><b>AI investigation:</b> ${esc(ev.ai_summary)}</p>` : ""}${ev.customer_reason ? `<p><b>Customer said:</b> ${esc(ev.customer_reason)}</p>` : ""}
<details><summary>Evidence package</summary><pre>${esc(JSON.stringify(ev, null, 2))}</pre></details>
${c.meta.last_decision ? `<p class="m">Last decision: ${esc(c.meta.last_decision.result)} by ${esc(c.meta.last_decision.by)} → ${esc(c.meta.last_decision.outcome || "")}. ${esc(c.meta.last_decision.message || c.meta.last_decision.note || "")}</p>` : ""}
<div class="row">${pending ? form("APPROVE", "Approve &amp; execute " + esc(pending.op), "p") : ""}
<form method="post" action="/review/decide" class="row" style="display:inline-flex"><input type="hidden" name="case_id" value="${esc(c.key)}"><input type="hidden" name="action" value="APPROVE"><select name="op">${OPS.map((o) => `<option>${o}</option>`).join("")}</select><button>Approve alternative remedy</button></form></div>
<form method="post" action="/review/decide" class="row" style="margin-top:8px"><input type="hidden" name="case_id" value="${esc(c.key)}"><input name="note" placeholder="Note for AI / reason" maxlength="300" style="flex:1;min-width:200px">
<button name="action" value="REJECT">Reject</button><button name="action" value="REQUEST_EVIDENCE">Request more evidence</button><button name="action" value="TAKE_OWNERSHIP">Take ownership</button><button name="action" value="RETURN_TO_AI">Return to AI</button></form>
<details><summary>History</summary><table>${hist}</table></details></section>`;
  }).join("");
  const m = Object.entries(metrics).map(([k, v]) => `<tr><td>${esc(k.replace(/_/g, " "))}</td><td>${esc(typeof v === "object" ? JSON.stringify(v) : v)}</td></tr>`).join("");
  return shell(`<div class="row" style="justify-content:space-between"><div><h1>PizzaResolve review console</h1><p class="m">Signed in as ${esc(actor)}. AI investigates and executes; you approve, reject, redirect or take over. Every action runs on the backend and is re-validated.</p></div></div>
${msg ? `<div class="msg">${esc(msg)}</div>` : ""}<details class="card"><summary><b>Collaboration metrics (live from ledger)</b></summary><table>${m}</table></details>${list || `<p class="m">No cases yet.</p>`}`);
}
