// TelecomResolve service layer: the five agent-callable tools for a FICTIONAL operator (CodeVerse Telecom).
// All access, money and docket decisions are deterministic code; the language model only relays customer_message.
import crypto from "node:crypto";
import { checkIdentity, countRecentFailures, POLICY } from "../engine.js";
import { reconcileTelecom, TPOLICY, ISSUES, CATEGORIES, rupees, hasInjection } from "./engine.js";
import { UnknownOutcome } from "../store.js";

const s = (v) => (v === undefined || v === null ? "" : String(v)).trim();
const up = (v) => s(v).toUpperCase();
const mins = (a, b) => (a - b) / 60000;
const LOCKED_MSG = "For security, I can't check this account any further right now. Please try again later, or contact us from your registered number.";
const NOT_VERIFIED_MSG = "I couldn't verify those details. I need your account number (like ACC-50001) or a recharge transaction ID (like TXN-7001), the last 4 digits of your mobile number, and the PIN code on the account.";
const UNAVAILABLE_MSG = "I can't reach our account systems right now, so I can't confirm anything. Nothing has been changed. Please try again shortly.";
const THIRD_PARTY_MSG = "I can only discuss an account with the account holder. The account holder can contact us directly, and I'm happy to help with an account of your own.";
const scrub = (txt) => { const n = s(txt).replace(/\d[\d\s-]{3,}\d/g, "[digits removed]").replace(/\S+@\S+/g, "[email removed]").slice(0, 200); return hasInjection(n) ? "[removed: instruction-like text]" : n; };

export function normaliseTelRef(raw) {
  const r = up(raw).replace(/\s+/g, "");
  const m = /^(ACC|TXN|VAS)-?(\d{4,6}[A-Z]?)$/.exec(r);
  return m ? m[1] + "-" + m[2] : null;
}

export class TelecomService {
  constructor(store, { now = () => Date.now(), log = () => {} } = {}) { this.store = store; this.now = now; this.log = log; }
  iso() { return new Date(this.now()).toISOString(); }

  async faults() {
    try { return (await this.store.list("config")).filter((r) => up(r.key).startsWith("FAULT-") && up(r.value.mode) !== "OFF"); } catch { return []; }
  }

  // Resolve a reference to the subscriber account and everything on it. Throws StoreUnavailable.
  async bundle(ref) {
    const [subs, recharges] = await Promise.all([this.store.list("subscribers"), this.store.list("recharges")]);
    let accountId = null, focusTxn = null;
    if (ref.startsWith("ACC-")) accountId = subs.some((x) => x.key === ref) ? ref : null;
    else if (ref.startsWith("TXN-")) { const r = recharges.find((x) => x.key === ref); if (r) { accountId = s(r.value.account_id); focusTxn = ref; } }
    else if (ref.startsWith("VAS-")) { const sv = (await this.store.list("services")).find((x) => x.key === ref); if (sv) accountId = s(sv.value.account_id); }
    const subscriber = accountId ? subs.find((x) => x.key === accountId) || null : null;
    if (!subscriber) return null;
    return { subscriber, accountId, focusTxn, recharges: recharges.filter((r) => s(r.value.account_id) === accountId) };
  }

  async session(sessionId, ledger) {
    const sid = up(sessionId);
    if (!/^VS-[A-Z2-7]{10}$/.test(sid)) return null;
    const row = ledger.find((l) => l.key === sid && up(l.value.kind) === "SESSION");
    if (!row) return null;
    if (Date.parse(row.value.expires_at) < this.now()) return { expired: true };
    return { id: sid, account_id: s(row.value.account_id) };
  }

  async writeOnce(key, value, sameAs) {
    try {
      const r = await this.store.create("ledger", key, value);
      if (r.status === "CREATED") return { outcome: "CREATED", row: r.row };
      return { outcome: "ALREADY_EXISTS", row: await this.store.getByKey("ledger", key) };
    } catch (e) {
      if (!(e instanceof UnknownOutcome)) throw e;
      try {
        const existing = await this.store.getByKey("ledger", key);
        if (existing && sameAs(existing.value)) return { outcome: "CONFIRMED_AFTER_TIMEOUT", row: existing };
        if (existing) return { outcome: "ALREADY_EXISTS", row: existing };
        return { outcome: "UNKNOWN" };
      } catch { return { outcome: "UNKNOWN" }; }
    }
  }

  // ---------- tool 1: identity ----------
  async verifySubscriber({ reference, mobile_last4, pincode, requester = "self", conversation_id = "" }) {
    const ref = normaliseTelRef(reference);
    const now = this.now();
    if (!ref) return { verified: false, decision: "INSUFFICIENT_EVIDENCE", reason_code: "INVALID_REFERENCE", customer_message: "Please give your account number (like ACC-50001) or the recharge transaction ID from your payment message (like TXN-7001)." };
    let ledger, b;
    try { [ledger, b] = await Promise.all([this.store.list("ledger"), this.bundle(ref)]); }
    catch { return { verified: false, decision: "INSUFFICIENT_EVIDENCE", reason_code: "SYSTEM_UNAVAILABLE", customer_message: UNAVAILABLE_MSG }; }
    const lockRef = b ? b.accountId : ref;   // lock the account, not just the reference typed
    if (countRecentFailures(ledger, lockRef, now) >= POLICY.MAX_FAILED_VERIFICATIONS) { this.log({ tool: "verify_subscriber", result: "LOCKED" }); return { verified: false, decision: "SECURITY_BLOCKED", reason_code: "TOO_MANY_ATTEMPTS", customer_message: LOCKED_MSG }; }
    const cid = /^[A-Za-z0-9-]{8,64}$/.test(s(conversation_id)) ? s(conversation_id) : "";
    if (ledger.some((l) => up(l.value.kind) === "THIRD_PARTY_CLAIM" && up(l.value.ref) === up(lockRef) && mins(now, Date.parse(l.value.created_at)) <= POLICY.LOCKOUT_WINDOW_MIN)) {
      this.log({ tool: "verify_subscriber", result: "THIRD_PARTY_PAUSE" });
      return { verified: false, decision: "SECURITY_BLOCKED", reason_code: "THIRD_PARTY_LOCK", customer_message: "This account was recently asked about by someone who said it wasn't theirs, so for security I can't verify it right now. The account holder can try again in 30 minutes or contact us from the registered number." };
    }
    if (cid && ledger.some((l) => l.key === "DENY-" + cid)) return { verified: false, decision: "SECURITY_BLOCKED", reason_code: "THIRD_PARTY_LOCK", customer_message: THIRD_PARTY_MSG };
    const who = s(requester).toLowerCase();
    if (who && !/^(self|me|myself|mine|own|owner|account holder)$/.test(who)) {
      if (cid) { try { await this.store.create("ledger", "DENY-" + cid, { kind: "CONVERSATION_DENY", ref: lockRef, reason: "THIRD_PARTY_REQUEST", created_at: this.iso() }); } catch { /* refusal either way */ } }
      try { await this.store.create("ledger", "TPC-" + lockRef + "-" + now + "-" + crypto.randomBytes(2).toString("hex").toUpperCase(), { kind: "THIRD_PARTY_CLAIM", ref: lockRef, status: "FAILED", reason: "THIRD_PARTY_REQUEST", session: cid, created_at: this.iso() }); } catch { /* best effort */ }
      this.log({ tool: "verify_subscriber", result: "THIRD_PARTY_BLOCKED" });
      return { verified: false, decision: "SECURITY_BLOCKED", reason_code: "THIRD_PARTY_REQUEST", customer_message: THIRD_PARTY_MSG };
    }
    const idc = checkIdentity({ customer: b && b.subscriber, phoneLast4: mobile_last4, postcode: pincode, requester: "self" });
    if (!idc.ok) {
      try { await this.store.create("ledger", "ATT-" + lockRef + "-" + now + "-" + crypto.randomBytes(2).toString("hex").toUpperCase(), { kind: "VERIFY_ATTEMPT", ref: lockRef, status: "FAILED", reason: idc.code, session: cid, created_at: this.iso() }); } catch { /* best effort */ }
      const fails = countRecentFailures(ledger, lockRef, now) + 1;
      this.log({ tool: "verify_subscriber", result: "FAILED", code: idc.code, fails });
      if (fails >= POLICY.MAX_FAILED_VERIFICATIONS) return { verified: false, decision: "SECURITY_BLOCKED", reason_code: "TOO_MANY_ATTEMPTS", customer_message: LOCKED_MSG };
      if (idc.code === "ACCOUNT_FLAGGED") return { verified: false, decision: "ESCALATION_REQUIRED", reason_code: idc.code, customer_message: "I can't verify this account automatically. A person needs to check it; I can't share any account details here." };
      return { verified: false, decision: "SECURITY_BLOCKED", reason_code: "DETAILS_NOT_VERIFIED", attempts_left: POLICY.MAX_FAILED_VERIFICATIONS - fails, customer_message: NOT_VERIFIED_MSG };
    }
    const sid = "VS-" + base32(crypto.randomBytes(7)).slice(0, 10);
    const exp = new Date(now + POLICY.SESSION_TTL_MIN * 60000).toISOString();
    try { const r = await this.store.create("ledger", sid, { kind: "SESSION", ref, account_id: b.accountId, status: "ACTIVE", created_at: this.iso(), expires_at: exp }); if (r.status !== "CREATED") throw new Error("collision"); }
    catch { return { verified: false, decision: "INSUFFICIENT_EVIDENCE", reason_code: "SESSION_NOT_CREATED", customer_message: "I matched your details but couldn't start a secure session, so I can't continue. Please try again in a moment." }; }
    this.log({ tool: "verify_subscriber", result: "VERIFIED", session: sid });
    return { verified: true, session_id: sid, reference: ref, account_id: b.accountId, verification_level: "SYNTHETIC_KNOWLEDGE_BASED (reference + mobile last 4 + PIN code; a real operator would use OTP to the registered number)", expires_at: exp,
      customer_message: "Thanks " + s(b.subscriber.value.first_name) + ", you're verified." };
  }

  async authorise(session_id, reference) {
    const ref = normaliseTelRef(reference);
    if (!ref) return { err: { decision: "INSUFFICIENT_EVIDENCE", reason_code: "INVALID_REFERENCE", customer_message: "Which account or transaction is this about? Please give the account number or transaction ID." } };
    let ledger, b;
    try { [ledger, b] = await Promise.all([this.store.list("ledger"), this.bundle(ref)]); }
    catch { return { err: { decision: "INSUFFICIENT_EVIDENCE", reason_code: "SYSTEM_UNAVAILABLE", customer_message: UNAVAILABLE_MSG } }; }
    const sess = await this.session(session_id, ledger);
    if (!sess) return { err: { decision: "SECURITY_BLOCKED", reason_code: "NOT_VERIFIED", customer_message: "I need to verify you first. Please give your account number or transaction ID, the last 4 digits of your mobile number, and your PIN code." } };
    if (sess.expired) return { err: { decision: "SECURITY_BLOCKED", reason_code: "SESSION_EXPIRED", customer_message: "For security, your verification has expired. Please verify again." } };
    if (!b || b.accountId !== sess.account_id) { this.log({ tool: "authorise", result: "CROSS_ACCOUNT_BLOCKED" }); return { err: { decision: "SECURITY_BLOCKED", reason_code: "REFERENCE_NOT_IN_VERIFIED_ACCOUNT", customer_message: "That reference isn't on the account you verified, so I can't share anything about it." } }; }
    return { ref, b, ledger: ledger.filter((l) => s(l.value.account_id) === b.accountId), sess };
  }

  async evaluate(ctx, reported, note = "") {
    const faults = await this.faults();
    const billingDown = faults.some((f) => up(f.key) === "FAULT-BILLING" && ["ALL", ctx.b.accountId].includes(up(f.value.scope)));
    const netDown = faults.some((f) => up(f.key) === "FAULT-NETWORK" && ["ALL", ctx.b.accountId].includes(up(f.value.scope)));
    let services = [], refunds = [], network = [], billingAvailable = !billingDown, networkAvailable = !netDown;
    try { services = (await this.store.list("services")).filter((x) => s(x.value.account_id) === ctx.b.accountId); } catch { billingAvailable = false; }
    try { refunds = (await this.store.list("refunds")).filter((x) => s(x.value.account_id) === ctx.b.accountId); } catch { billingAvailable = false; }
    try { network = await this.store.list("network"); } catch { networkAvailable = false; }
    const r = reconcileTelecom({ subscriber: ctx.b.subscriber, recharges: ctx.b.recharges, services, refunds, network, ledger: ctx.ledger, reported, focusTxn: ctx.b.focusTxn, now: this.now(), billingAvailable, networkAvailable, note });
    r.injected_fault = billingDown || netDown ? "YES (synthetic outage configured in TC_Config_Codeverse)" : "NO";
    return r;
  }

  // ---------- tool 2: investigation (security, recharge, billing/VAS, network specialists) ----------
  async investigateComplaint({ session_id, reference, reported_issues = [], customer_text = "" }) {
    const ctx = await this.authorise(session_id, reference);
    if (ctx.err) return ctx.err;
    const reported = (Array.isArray(reported_issues) ? reported_issues : [reported_issues]).map(up).filter((x) => ISSUES.includes(x));
    const r = await this.evaluate(ctx, reported, customer_text);
    this.log({ tool: "investigate_complaint", decision: r.decision, reason: r.reason_code });
    return { reference: ctx.ref, account_id: ctx.b.accountId, ...r };
  }

  // ---------- tool 3: idempotent refund request ----------
  async requestRefund({ session_id, reference, txn_id }) {
    const ctx = await this.authorise(session_id, reference);
    if (ctx.err) return ctx.err;
    const r = await this.evaluate(ctx, []);
    const allowed = r.authorized_actions.filter((a) => a.action === "REQUEST_REFUND");
    const want = up(txn_id) || (allowed.length === 1 ? allowed[0].txn_id : "") || (ctx.b.focusTxn || "");
    const requests = ctx.ledger.filter((l) => up(l.value.kind) === "REFUND_REQUEST");
    // Already requested (this or an earlier session)? Return it; never create a second request.
    const existing = (want && requests.find((l) => up(l.value.txn_id) === want)) || (!want && !allowed.length && requests[0]);
    if (existing) {
      return { action: "REQUEST_REFUND", outcome: "ALREADY_REQUESTED", duplicate_prevented: true, request_ref: existing.key, status: up(existing.value.status), money_moved: false,
        customer_message: "A refund request for " + rupees(Number(existing.value.amount_paise)) + " is already on file, reference " + existing.key + ". I haven't created another one. It is waiting for the refund team; no money has been paid out yet." };
    }
    const pick = allowed.find((a) => a.txn_id === want) || null;
    if (!pick) {
      if (r.decision === "SECURITY_BLOCKED") return { action: "REQUEST_REFUND", outcome: "NOT_AUTHORIZED", reason_code: "SECURITY_HOLD", customer_message: r.customer_message };
      return { action: "REQUEST_REFUND", outcome: "NOT_AUTHORIZED", reason_code: allowed.length > 1 ? "TXN_ID_REQUIRED" : "POLICY_DOES_NOT_ALLOW_REFUND",
        customer_message: allowed.length > 1 ? "There is more than one charge I could refund; which transaction is it (" + allowed.map((a) => a.txn_id).join(" or ") + ")?" : "Based on what our systems show, I can't raise a refund for this. " + r.customer_message.split(" I can raise")[0] };
    }
    const key = "REFREQ-" + pick.txn_id;
    const value = { kind: "REFUND_REQUEST", status: "REQUESTED", account_id: ctx.b.accountId, txn_id: pick.txn_id, ref: ctx.ref, amount_paise: String(pick.amount_paise), reason: pick.reason, evidence: r.evidence.map((e) => e.ref).join(","), session: ctx.sess.id, created_at: this.iso() };
    let w; try { w = await this.writeOnce(key, value, (v) => s(v.txn_id) === pick.txn_id && s(v.amount_paise) === String(pick.amount_paise)); } catch { w = { outcome: "UNKNOWN" }; }
    this.log({ tool: "request_refund", key, outcome: w.outcome });
    if (w.outcome === "CREATED" || w.outcome === "CONFIRMED_AFTER_TIMEOUT") return { action: "REQUEST_REFUND", outcome: "REQUESTED", request_ref: key, amount_paise: pick.amount_paise, status: "REQUESTED", money_moved: false, ledger_row_id: w.row && w.row.id,
      customer_message: "I've raised a refund request for " + rupees(pick.amount_paise) + ", reference " + key + ". This is a request, not a completed refund: no live payment processor is connected, so the refund team still has to send it. Asking again won't create a second refund." };
    if (w.outcome === "ALREADY_EXISTS") return { action: "REQUEST_REFUND", outcome: "ALREADY_REQUESTED", duplicate_prevented: true, request_ref: key, money_moved: false, customer_message: "A refund request for this charge already exists, reference " + key + ". I haven't created another one." };
    return { action: "REQUEST_REFUND", outcome: "UNKNOWN", money_moved: false, customer_message: "I tried to raise the refund request but couldn't confirm it was saved, so I won't say it was. Please ask me to check again; that won't create a duplicate." };
  }

  // ---------- tool 4: complaint registration with a docket number (any verified customer may register one) ----------
  async registerComplaint({ session_id, reference, category, summary = "" }) {
    const ctx = await this.authorise(session_id, reference);
    if (ctx.err) return ctx.err;
    const cat = up(category);
    if (!CATEGORIES.includes(cat)) return { action: "REGISTER_COMPLAINT", outcome: "INVALID_CATEGORY", customer_message: "Which kind of complaint is it: recharge, billing, value-added service, network, data speed, spam calls, porting, SIM, or other?" };
    const docket = "CMP-" + ctx.b.accountId.replace("ACC-", "") + "-" + cat;
    const existing = ctx.ledger.find((l) => l.key === docket);
    if (existing) return { action: "REGISTER_COMPLAINT", outcome: "ALREADY_REGISTERED", duplicate_prevented: true, docket_number: docket, status: up(existing.value.status), target_resolution_by: s(existing.value.target_by),
      customer_message: "You already have an open " + cat.toLowerCase().replace("_", " ") + " complaint, docket number " + docket + ", registered " + s(existing.value.created_at).slice(0, 10) + ". Target resolution date: " + s(existing.value.target_by).slice(0, 10) + ". I haven't opened a duplicate." };
    const r = await this.evaluate(ctx, []);
    const days = TPOLICY.TARGET_DAYS[cat];
    const target = new Date(this.now() + days * 86400000).toISOString();
    const value = { kind: "COMPLAINT", status: "OPEN", category: cat, account_id: ctx.b.accountId, ref: ctx.ref, target_by: target, findings: r.reason_code.slice(0, 160), evidence: r.evidence.map((e) => e.ref).join(",").slice(0, 300),
      customer_note: scrub(summary), channel: "AI_AGENT_CHAT", human_access: "CALLBACK_AVAILABLE", session: ctx.sess.id, created_at: this.iso() };
    let w; try { w = await this.writeOnce(docket, value, (v) => up(v.category) === cat); } catch { w = { outcome: "UNKNOWN" }; }
    this.log({ tool: "register_complaint", key: docket, outcome: w.outcome });
    if (w.outcome === "CREATED" || w.outcome === "CONFIRMED_AFTER_TIMEOUT") return { action: "REGISTER_COMPLAINT", outcome: "REGISTERED", docket_number: docket, target_resolution_by: target, ledger_row_id: w.row && w.row.id,
      customer_message: "I've registered your complaint. Your docket number is " + docket + ". Our target is to resolve it by " + target.slice(0, 10) + " (" + days + " day" + (days > 1 ? "s" : "") + ", our service policy). Please keep the docket number: if you're not satisfied with the resolution you can appeal with it, and you can ask for a callback from a person at any time." };
    if (w.outcome === "ALREADY_EXISTS") return { action: "REGISTER_COMPLAINT", outcome: "ALREADY_REGISTERED", duplicate_prevented: true, docket_number: docket, customer_message: "That complaint is already registered, docket number " + docket + "." };
    return { action: "REGISTER_COMPLAINT", outcome: "UNKNOWN", customer_message: "I couldn't confirm the complaint was saved, so I won't give you a docket number yet. Please ask me to try again; that won't create a duplicate." };
  }

  // ---------- tool 5: human callback request (truthful: no live transfer in this channel) ----------
  async requestCallback({ session_id, reference, reason = "" }) {
    const ctx = await this.authorise(session_id, reference);
    if (ctx.err) return ctx.err;
    const key = "CB-" + ctx.b.accountId.replace("ACC-", "");
    const existing = ctx.ledger.find((l) => l.key === key);
    if (existing) return { action: "REQUEST_CALLBACK", outcome: "ALREADY_REQUESTED", duplicate_prevented: true, callback_ref: key, live_transfer: "NOT_AVAILABLE",
      customer_message: "A callback from a person is already requested, reference " + key + ", with everything we've checked, so you won't need to repeat yourself. I can't transfer you live from this chat." };
    const r = await this.evaluate(ctx, ["WANTS_HUMAN"]);
    const urgent = /RECENT_SIM_SWAP|REFUND_FAILED/.test(r.reason_code) || /fraud|didn'?t ask|not me|stolen|hacked/i.test(s(reason));
    const dockets = ctx.ledger.filter((l) => ["COMPLAINT", "REFUND_REQUEST"].includes(up(l.value.kind))).map((l) => l.key).join(",") || "none";
    const value = { kind: "CALLBACK_REQUEST", status: "QUEUED", priority: urgent ? "URGENT_FRAUD_DESK" : "NORMAL", account_id: ctx.b.accountId, ref: ctx.ref,
      summary: ("Verified subscriber (synthetic KBA). Decision " + r.decision + ". Findings: " + r.reason_code + ". On file: " + dockets + ".").slice(0, 480), customer_note: scrub(reason), session: ctx.sess.id, created_at: this.iso() };
    let w; try { w = await this.writeOnce(key, value, (v) => s(v.account_id) === ctx.b.accountId); } catch { w = { outcome: "UNKNOWN" }; }
    this.log({ tool: "request_callback", key, outcome: w.outcome, priority: value.priority });
    if (w.outcome === "CREATED" || w.outcome === "CONFIRMED_AFTER_TIMEOUT") return { action: "REQUEST_CALLBACK", outcome: "QUEUED", callback_ref: key, priority: value.priority, live_transfer: "NOT_AVAILABLE", summary: value.summary, ledger_row_id: w.row && w.row.id,
      customer_message: "I've requested a callback from a person" + (urgent ? ", marked urgent for the fraud team" : "") + ", reference " + key + ". They'll call your registered number with everything we've checked, so you won't have to repeat it. I can't transfer you live from this chat and I can't promise an exact time." };
    if (w.outcome === "ALREADY_EXISTS") return { action: "REQUEST_CALLBACK", outcome: "ALREADY_REQUESTED", duplicate_prevented: true, callback_ref: key, live_transfer: "NOT_AVAILABLE", customer_message: "A callback is already requested, reference " + key + "." };
    return { action: "REQUEST_CALLBACK", outcome: "UNKNOWN", live_transfer: "NOT_AVAILABLE", customer_message: "I couldn't confirm the callback request was saved, so I won't say it was. Please ask me to try again." };
  }
}

function base32(buf) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, val = 0, out = "";
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += A[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += A[(val << (5 - bits)) & 31];
  return out;
}
