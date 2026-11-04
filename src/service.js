// PizzaResolve service layer: the five agent-callable tools.
// Every decision about access or money is made here (deterministically), never by the language model.
import crypto from "node:crypto";
import { reconcile, checkIdentity, countRecentFailures, POLICY, rupees, s, hasInjection } from "./engine.js";
import { StoreUnavailable, UnknownOutcome } from "./store.js";
import { installMultiAgent } from "./multiagent.js";
import { installExecution } from "./execution.js";
import { installCollab } from "./collab.js";
import { installGoodwill } from "./goodwill.js";
import { spokenDigits, readDigits, readPhoneLast4, readPostcode } from "./spoken.js";

const up = (v) => s(v).toUpperCase();
const mins = (a, b) => (a - b) / 60000;
const LOCKED_MSG = "For security, I can't check this order any further right now. Please try again later or contact us from the phone number on the account.";
const NOT_VERIFIED_MSG = "I couldn't verify those details. To look at an order I need the order or payment reference, the last 4 digits of the phone number on the account, and the delivery postcode.";
const UNAVAILABLE_MSG = "I can't reach our order systems right now, so I can't confirm anything about this order. Nothing has been changed. Please try again shortly.";

// Voice channels: speech-to-text gives words, not digits; src/spoken.js reads them with fixed rules.
export { spokenDigits };
export function normaliseRef(raw) {
  const r = up(raw).replace(/\s+/g, "");
  const m = /^(ORD|PAY)-?(\d{4,6}[A-Z]?)$/.exec(r);
  if (m) return m[1] + "-" + m[2];
  // Spoken form: detect the prefix word, then read digits from words.
  const t = up(raw);
  if (/[^\p{L}\p{M}\p{N}\s\-.,]/u.test(String(raw || "")) || String(raw || "").length > 80) return null; // letters/digits in any script only: blocks injection
  const kind = /\b(PAY|PAYMENT|P\s*A\s*Y)\b/.test(t) ? "PAY" : "ORD";
  const stripped = t.replace(/\b(ORDER|ORD|O\s*R\s*D|PAYMENT|PAY|P\s*A\s*Y|NUMBER|NO|ID|REFERENCE|REF|DASH|HYPHEN|IS|MY|THE)\b/g, " ");
  const d = readDigits(stripped, 4);
  return /^\d{4,6}$/.test(d) ? kind + "-" + d : null;
}

export class PizzaService {
  constructor(store, { now = () => Date.now(), log = () => {} } = {}) {
    this.store = store;
    this.now = now;
    this.log = log;
  }

  iso() { return new Date(this.now()).toISOString(); }

  // ---------- shared lookups ----------
  async faults() {
    try { return (await this.store.list("config")).filter((r) => up(r.key).startsWith("FAULT-") && up(r.value.mode) !== "OFF"); }
    catch { return []; }
  }
  faultFor(faults, system, refs) {
    return faults.some((f) => up(f.key) === "FAULT-" + system && (up(f.value.scope) === "ALL" || refs.includes(up(f.value.scope))));
  }

  // Resolve a reference into the record bundle the specialists need. Throws StoreUnavailable.
  async bundle(ref) {
    const [orders, payments] = await Promise.all([this.store.list("orders"), this.store.list("payments")]);
    let order = null, anchorPay = null;
    if (ref.startsWith("ORD-")) order = orders.find((o) => o.key === ref) || null;
    else {
      anchorPay = payments.find((p) => p.key === ref) || null;
      if (anchorPay) {
        order = orders.find((o) => o.key === s(anchorPay.value.order_id)) ||
          orders.find((o) => s(o.value.checkout_id) && s(o.value.checkout_id) === s(anchorPay.value.checkout_id)) || null;
      }
    }
    if (!order && !anchorPay) return null;
    const checkout = order ? s(order.value.checkout_id) : s(anchorPay.value.checkout_id);
    const pays = payments.filter((p) => (order && s(p.value.order_id) === order.key) || (checkout && s(p.value.checkout_id) === checkout) || (anchorPay && p.key === anchorPay.key));
    const customerIds = new Set([order && s(order.value.customer_id), ...pays.map((p) => s(p.value.customer_id))].filter(Boolean));
    return { order, payments: pays, checkout, customerIds: [...customerIds], refs: [ref, order && order.key, ...pays.map((p) => p.key)].filter(Boolean).map(up) };
  }

  async session(sessionId, ledgerRows) {
    const sid = up(sessionId);
    if (!/^VS-[A-Z2-7]{10}$/.test(sid)) return null;
    const row = (ledgerRows || (await this.store.list("ledger"))).find((l) => l.key === sid && up(l.value.kind) === "SESSION");
    if (!row) return null;
    if (Date.parse(row.value.expires_at) < this.now()) return { expired: true };
    return { id: sid, customer_id: s(row.value.customer_id) };
  }

  // Idempotent write: unique key enforced by the data store (duplicate -> 409).
  async writeOnce(key, value, sameAs) {
    try {
      const r = await this.store.create("ledger", key, value);
      if (r.status === "CREATED") return { outcome: "CREATED", row: r.row };
      const existing = await this.store.getByKey("ledger", key);
      return { outcome: "ALREADY_EXISTS", row: existing };
    } catch (e) {
      if (!(e instanceof UnknownOutcome)) throw e;
      // Timeout / 5xx: the write may or may not have landed. Never assume; re-read.
      try {
        const existing = await this.store.getByKey("ledger", key);
        if (existing && sameAs(existing.value)) return { outcome: "CONFIRMED_AFTER_TIMEOUT", row: existing };
        if (existing) return { outcome: "ALREADY_EXISTS", row: existing };
        return { outcome: "UNKNOWN" };
      } catch { return { outcome: "UNKNOWN" }; }
    }
  }

  // ---------- tool 1: identity & order association ----------
  async verifyCustomer({ reference, phone_last4, postcode, requester = "self", conversation_id = "" }) {
    let ref = normaliseRef(reference);
    // Voice: spoken phone digits / postcode arrive as words.
    if (phone_last4) phone_last4 = readPhoneLast4(phone_last4);
    if (postcode) postcode = readPostcode(postcode);
    // A bare number could be an order or a payment: if no such order exists, try the payment.
    if (ref && ref.startsWith("ORD-") && !/^(ORD|O\s*R\s*D|ORDER)/i.test(String(reference).trim())) {
      try { const b0 = await this.bundle(ref); if (!b0) ref = "PAY-" + ref.slice(4); } catch { /* fall through to normal path */ }
    }
    const now = this.now();
    if (!ref) return { verified: false, decision: "INSUFFICIENT_EVIDENCE", reason_code: "INVALID_REFERENCE", customer_message: "Please give your order number (like ORD-7001) or the payment reference from your bank message (like PAY-9001)." };
    let ledger, b, customers;
    try {
      [ledger, b, customers] = await Promise.all([this.store.list("ledger"), this.bundle(ref), this.store.list("customers")]);
    } catch (e) {
      return { verified: false, decision: "INSUFFICIENT_EVIDENCE", reason_code: "SYSTEM_UNAVAILABLE", customer_message: UNAVAILABLE_MSG };
    }
    if (countRecentFailures(ledger, ref, now) >= POLICY.MAX_FAILED_VERIFICATIONS) {
      this.log({ tool: "verify_customer", ref, result: "LOCKED" });
      return { verified: false, decision: "SECURITY_BLOCKED", reason_code: "TOO_MANY_ATTEMPTS", customer_message: LOCKED_MSG };
    }
    // Conversation-scoped controls (PZ-D1): the Talkdesk interaction id is supplied by the platform, not the caller.
    // A third-party claim is sticky for the whole conversation; "actually it's mine" afterwards is refused.
    const cid = /^[A-Za-z0-9-]{8,64}$/.test(s(conversation_id)) ? s(conversation_id) : "";
    const THIRD_PARTY_MSG = "I can only discuss an order with the account holder. The account holder can contact us directly, and I'm happy to help with any order of your own.";
    // Reference-scoped pause: works even when the platform does not supply a conversation id.
    const recentThirdParty = ledger.some((l) => up(l.value.kind) === "THIRD_PARTY_CLAIM" && up(l.value.ref) === ref && mins(now, Date.parse(l.value.created_at)) <= POLICY.LOCKOUT_WINDOW_MIN);
    if (recentThirdParty) {
      this.log({ tool: "verify_customer", ref, result: "THIRD_PARTY_PAUSE" });
      return { verified: false, decision: "SECURITY_BLOCKED", reason_code: "THIRD_PARTY_LOCK", customer_message: "This order was recently asked about by someone who said it wasn't theirs, so for security I can't verify it right now. The account holder can try again in 30 minutes or contact us from the phone number on the account." };
    }
    if (cid && ledger.some((l) => l.key === "DENY-" + cid)) {
      this.log({ tool: "verify_customer", ref, result: "CONVERSATION_DENIED" });
      return { verified: false, decision: "SECURITY_BLOCKED", reason_code: "THIRD_PARTY_LOCK", customer_message: "Earlier in this conversation this order was described as belonging to someone else, so I can't verify it here. The account holder can contact us directly in a new conversation." };
    }
    if (cid && ledger.filter((l) => up(l.value.kind) === "VERIFY_ATTEMPT" && s(l.value.session) === cid && up(l.value.status) === "FAILED").length >= POLICY.MAX_FAILED_VERIFICATIONS) {
      this.log({ tool: "verify_customer", ref, result: "CONVERSATION_LOCKED" });
      return { verified: false, decision: "SECURITY_BLOCKED", reason_code: "TOO_MANY_ATTEMPTS", customer_message: LOCKED_MSG };
    }
    const who = s(requester).toLowerCase();
    if (who && !/^(self|me|myself|mine|own|owner|account holder)$/.test(who)) {
      if (cid) { try { await this.store.create("ledger", "DENY-" + cid, { kind: "CONVERSATION_DENY", ref, reason: "THIRD_PARTY_REQUEST", created_at: this.iso() }); } catch { /* reply stays a refusal either way */ } }
      try { await this.store.create("ledger", "TPC-" + ref + "-" + now + "-" + crypto.randomBytes(2).toString("hex").toUpperCase(), { kind: "THIRD_PARTY_CLAIM", ref, status: "FAILED", reason: "THIRD_PARTY_REQUEST", session: cid, created_at: this.iso() }); } catch { /* best effort */ }
      this.log({ tool: "verify_customer", ref, result: "THIRD_PARTY_BLOCKED", sticky: !!cid });
      return { verified: false, decision: "SECURITY_BLOCKED", reason_code: "THIRD_PARTY_REQUEST", customer_message: THIRD_PARTY_MSG };
    }
    let customer = null;
    if (b && b.customerIds.length === 1) customer = customers.find((c) => c.key === b.customerIds[0]) || null;
    const conflictOwner = b && b.customerIds.length > 1;
    const idc = conflictOwner ? { ok: false, code: "OWNERSHIP_CONFLICT" } : checkIdentity({ customer, phoneLast4: phone_last4, postcode, requester: "self" });
    if (!idc.ok) {
      // Same reply for unknown reference and wrong details: no enumeration oracle.
      const attKey = "ATT-" + ref + "-" + now + "-" + crypto.randomBytes(2).toString("hex").toUpperCase();
      try { await this.store.create("ledger", attKey, { kind: "VERIFY_ATTEMPT", ref, status: "FAILED", reason: idc.code, session: cid, created_at: this.iso() }); } catch { /* lockout counting is best-effort; reply stays non-disclosing */ }
      const fails = countRecentFailures(ledger, ref, now) + 1;
      this.log({ tool: "verify_customer", ref, result: "FAILED", code: idc.code, fails });
      if (fails >= POLICY.MAX_FAILED_VERIFICATIONS) return { verified: false, decision: "SECURITY_BLOCKED", reason_code: "TOO_MANY_ATTEMPTS", customer_message: LOCKED_MSG };
      if (idc.code === "ACCOUNT_FLAGGED" || idc.code === "OWNERSHIP_CONFLICT") return { verified: false, decision: "ESCALATION_REQUIRED", reason_code: idc.code, customer_message: "I can't verify this order automatically. A person needs to check it; I can't share any order details here." };
      return { verified: false, decision: "SECURITY_BLOCKED", reason_code: "DETAILS_NOT_VERIFIED", attempts_left: POLICY.MAX_FAILED_VERIFICATIONS - fails, customer_message: NOT_VERIFIED_MSG };
    }
    const sid = "VS-" + base32(crypto.randomBytes(7)).slice(0, 10);
    const exp = new Date(now + POLICY.SESSION_TTL_MIN * 60000).toISOString();
    try {
      const r = await this.store.create("ledger", sid, { kind: "SESSION", ref, customer_id: customer.key, status: "ACTIVE", created_at: this.iso(), expires_at: exp });
      if (r.status !== "CREATED") throw new Error("session collision");
    } catch {
      return { verified: false, decision: "INSUFFICIENT_EVIDENCE", reason_code: "SESSION_NOT_CREATED", customer_message: "I matched your details but couldn't start a secure session, so I can't continue. Please try again in a moment." };
    }
    this.log({ tool: "verify_customer", ref, result: "VERIFIED", session: sid });
    return { verified: true, session_id: sid, reference: ref, verification_level: "SYNTHETIC_KNOWLEDGE_BASED (reference + phone last 4 + postcode; not strong authentication)", expires_at: exp,
      customer_message: "Thanks " + s(customer.value.first_name) + ", you're verified for this order." };
  }

  async authorise(session_id, reference) {
    const ref = normaliseRef(reference);
    if (!ref) return { err: { decision: "INSUFFICIENT_EVIDENCE", reason_code: "INVALID_REFERENCE", customer_message: "Which order is this about? Please give the order number or payment reference." } };
    let ledger, b;
    try { [ledger, b] = await Promise.all([this.store.list("ledger"), this.bundle(ref)]); }
    catch { return { err: { decision: "INSUFFICIENT_EVIDENCE", reason_code: "SYSTEM_UNAVAILABLE", customer_message: UNAVAILABLE_MSG } }; }
    const sess = await this.session(session_id, ledger);
    if (!sess) return { err: { decision: "SECURITY_BLOCKED", reason_code: "NOT_VERIFIED", customer_message: "I need to verify you before I can look at an order. Please give the order or payment reference, the last 4 digits of the account phone number, and the delivery postcode." } };
    if (sess.expired) return { err: { decision: "SECURITY_BLOCKED", reason_code: "SESSION_EXPIRED", customer_message: "For security, your verification has expired. Please verify again with your reference, phone last 4 digits and postcode." } };
    if (!b || !b.customerIds.includes(sess.customer_id) || b.customerIds.length !== 1) {
      this.log({ tool: "authorise", ref, result: "CROSS_CUSTOMER_BLOCKED", session: sess.id });
      return { err: { decision: "SECURITY_BLOCKED", reason_code: "REFERENCE_NOT_IN_VERIFIED_ACCOUNT", customer_message: "I can't find that reference on the account you verified, so I can't share anything about it. If it is your order on another account, please verify with that order's details." } };
    }
    return { ref, b, ledger, sess };
  }

  async evaluate(ctx, reported) {
    const faults = await this.faults();
    const payFault = this.faultFor(faults, "PAYMENTS", ctx.b.refs);
    const delFault = this.faultFor(faults, "DELIVERY", ctx.b.refs);
    let events = [], refunds = [], paymentsAvailable = !payFault, deliveryAvailable = !delFault;
    try { events = (await this.store.list("events")).filter((e) => ctx.b.order && s(e.value.order_id) === ctx.b.order.key); } catch { deliveryAvailable = false; }
    try { refunds = (await this.store.list("refunds")).filter((r) => ctx.b.refs.includes(up(r.value.payment_id)) || (ctx.b.order && s(r.value.order_id) === ctx.b.order.key)); } catch { paymentsAvailable = false; }
    const related = (ctx.ledger.filter((l) => ["REFUND_REQUEST", "ESCALATION", "DELIVERY_INVESTIGATION"].includes(up(l.value.kind)) && (ctx.b.refs.includes(up(l.value.order_id)) || ctx.b.refs.includes(up(l.value.payment_id)) || ctx.b.refs.includes(up(l.value.ref)))));
    let packing = null;
    try { const d = ctx.b.order ? await this.store.getByKey("details", ctx.b.order.key) : null; if (d) packing = { ordered: s(d.value.ordered_items || d.value.line_items), packed: s(d.value.packed_items), stage: s(d.value.stage) }; } catch { /* no packing record */ }
    const r = reconcile({ order: ctx.b.order, payments: ctx.b.payments, events, refunds, ledger: related, reported, now: this.now(), paymentsAvailable, deliveryAvailable, packing });
    r.injected_fault = payFault || delFault ? "YES (synthetic outage configured in PZ_Config_Codeverse)" : "NO";
    return r;
  }

  // ---------- tool 2: orchestrated investigation (payment + delivery specialists) ----------
  async investigateOrder({ session_id, reference, reported_issues = [] }) {
    const ctx = await this.authorise(session_id, reference);
    if (ctx.err) return ctx.err;
    const reported = (Array.isArray(reported_issues) ? reported_issues : [reported_issues]).map(up).filter((x) => ["NOT_RECEIVED", "LATE", "CHARGED_TWICE", "ORDER_MISSING", "REFUND_NOT_RECEIVED", "WANTS_HUMAN", "WRONG_ADDRESS", "MISSING_ITEMS", "WRONG_ITEMS", "OTHER"].includes(x));
    const r = await this.evaluate(ctx, reported);
    this.log({ tool: "investigate_order", ref: ctx.ref, decision: r.decision, reason: r.reason_code });
    return { reference: ctx.ref, order_id: ctx.b.order ? ctx.b.order.key : null, ...r };
  }

  // ---------- tool 3: payment & refund specialist (idempotent refund request) ----------
  async requestRefund({ session_id, reference, payment_id }) {
    const ctx = await this.authorise(session_id, reference);
    if (ctx.err) return ctx.err;
    const r = await this.evaluate(ctx, []);
    const allowed = r.authorized_actions.filter((a) => a.action === "REQUEST_REFUND");
    let pick = payment_id ? allowed.find((a) => a.payment_id === up(payment_id)) : allowed.length === 1 ? allowed[0] : null;
    const pid = up(payment_id) || (allowed[0] && allowed[0].payment_id);
    const key = pid ? "REFREQ-" + pid : null;
    // Already requested (this or an earlier session)? Return the existing request instead of creating a second one.
    // With no payment id and nothing left to authorise, any refund request already on file for this order counts.
    const existing = (key && ctx.ledger.find((l) => l.key === key)) ||
      (!payment_id && !allowed.length && ctx.ledger.find((l) => up(l.value.kind) === "REFUND_REQUEST" && ctx.b.refs.includes(up(l.value.payment_id))));
    const existingKey = existing && existing.key;
    if (existing) {
      return { action: "REQUEST_REFUND", outcome: "ALREADY_REQUESTED", duplicate_prevented: true, request_ref: existingKey, status: up(existing.value.status), amount_paise: Number(existing.value.amount_paise),
        customer_message: "A refund request for " + rupees(Number(existing.value.amount_paise)) + " is already on file, reference " + existingKey + ", created " + s(existing.value.created_at) + ". I haven't created another one. It is waiting for the refund team; no money has been paid out yet." };
    }
    if (!pick) {
      return { action: "REQUEST_REFUND", outcome: "NOT_AUTHORIZED", decision: r.decision, reason_code: allowed.length > 1 ? "PAYMENT_ID_REQUIRED" : "POLICY_DOES_NOT_ALLOW_REFUND",
        customer_message: allowed.length > 1 ? "There is more than one charge I could refund; which payment reference is it?" : "Based on what our systems show, I can't raise a refund for this right now. " + r.customer_message.split(" I can raise")[0] };
    }
    const value = { kind: "REFUND_REQUEST", status: "REQUESTED", order_id: ctx.b.order ? ctx.b.order.key : "", payment_id: pick.payment_id, ref: ctx.ref, customer_id: ctx.sess.customer_id,
      amount_paise: String(pick.amount_paise), reason: pick.reason, evidence: r.evidence.map((e) => e.ref).join(","), session: ctx.sess.id, created_at: this.iso() };
    let w;
    try { w = await this.writeOnce(key, value, (v) => s(v.payment_id) === pick.payment_id && s(v.amount_paise) === String(pick.amount_paise)); }
    catch { w = { outcome: "UNKNOWN" }; }
    this.log({ tool: "request_refund", ref: ctx.ref, key, outcome: w.outcome });
    if (w.outcome === "CREATED" || w.outcome === "CONFIRMED_AFTER_TIMEOUT") {
      return { action: "REQUEST_REFUND", outcome: "REQUESTED", request_ref: key, amount_paise: pick.amount_paise, status: "REQUESTED", money_moved: false, ledger_row_id: w.row && w.row.id,
        customer_message: "I've raised a refund request for " + rupees(pick.amount_paise) + ", reference " + key + ". This is a request, not a completed refund: there is no live refund processor connected, so the refund team still has to send it. Asking again won't create a second refund." };
    }
    if (w.outcome === "ALREADY_EXISTS") {
      return { action: "REQUEST_REFUND", outcome: "ALREADY_REQUESTED", duplicate_prevented: true, request_ref: key, status: w.row ? up(w.row.value.status) : "UNKNOWN",
        customer_message: "A refund request for this charge already exists, reference " + key + ". I haven't created another one." };
    }
    return { action: "REQUEST_REFUND", outcome: "UNKNOWN", request_ref: null, money_moved: false,
      customer_message: "I tried to raise the refund request but couldn't confirm whether it was saved, so I won't say it was. Please ask me to check again in a minute; checking again will not create a duplicate." };
  }

  // ---------- tool 4: delivery specialist recovery action ----------
  async openDeliveryInvestigation({ session_id, reference }) {
    const ctx = await this.authorise(session_id, reference);
    if (ctx.err) return ctx.err;
    if (!ctx.b.order) return { action: "OPEN_DELIVERY_INVESTIGATION", outcome: "NOT_AUTHORIZED", reason_code: "NO_ORDER", customer_message: "There is no order in the restaurant system for this payment, so there is no delivery to investigate." };
    const key = "INV-" + ctx.b.order.key;
    const existing = ctx.ledger.find((l) => l.key === key);
    if (existing) return { action: "OPEN_DELIVERY_INVESTIGATION", outcome: "ALREADY_OPEN", duplicate_prevented: true, investigation_ref: key, customer_message: "A delivery investigation is already open for this order, reference " + key + "." };
    // Asking for an investigation is the customer disputing receipt / progress; evaluate with that claim.
    const r = await this.evaluate(ctx, ["NOT_RECEIVED"]);
    const allowed = r.authorized_actions.some((a) => a.action === "OPEN_DELIVERY_INVESTIGATION");
    if (!allowed) return { action: "OPEN_DELIVERY_INVESTIGATION", outcome: "NOT_AUTHORIZED", reason_code: "POLICY_DOES_NOT_ALLOW", customer_message: "Our records don't show a delivery problem that needs an investigation yet. " + r.customer_message.split(" I can")[0] };
    const value = { kind: "DELIVERY_INVESTIGATION", status: "OPEN", order_id: ctx.b.order.key, ref: ctx.ref, customer_id: ctx.sess.customer_id, reason: r.reason_code.slice(0, 120), evidence: r.evidence.map((e) => e.ref).join(","), session: ctx.sess.id, created_at: this.iso() };
    let w; try { w = await this.writeOnce(key, value, (v) => s(v.order_id) === ctx.b.order.key); } catch { w = { outcome: "UNKNOWN" }; }
    this.log({ tool: "open_delivery_investigation", ref: ctx.ref, key, outcome: w.outcome });
    if (w.outcome === "CREATED" || w.outcome === "CONFIRMED_AFTER_TIMEOUT") return { action: "OPEN_DELIVERY_INVESTIGATION", outcome: "OPENED", investigation_ref: key, ledger_row_id: w.row && w.row.id,
      customer_message: "I've opened a delivery investigation, reference " + key + ". The delivery team will check the courier and restaurant records. I can't promise a replacement until they confirm it with the restaurant." };
    if (w.outcome === "ALREADY_EXISTS") return { action: "OPEN_DELIVERY_INVESTIGATION", outcome: "ALREADY_OPEN", duplicate_prevented: true, investigation_ref: key, customer_message: "A delivery investigation is already open for this order, reference " + key + "." };
    return { action: "OPEN_DELIVERY_INVESTIGATION", outcome: "UNKNOWN", customer_message: "I couldn't confirm that the investigation was saved, so I won't say it was. Please ask me to check again." };
  }

  // ---------- tool 5: human escalation (truthful: records a review request, never a live transfer) ----------
  async recordHumanReview({ session_id, reference, customer_request = "" }) {
    const ctx = await this.authorise(session_id, reference);
    if (ctx.err) return ctx.err;
    const key = "ESC-" + (ctx.b.order ? ctx.b.order.key : ctx.ref);
    const existing = ctx.ledger.find((l) => l.key === key);
    if (existing) return { action: "RECORD_HUMAN_REVIEW", outcome: "ALREADY_QUEUED", duplicate_prevented: true, review_ref: key, live_transfer: "NOT_AVAILABLE",
      customer_message: "Your case is already queued for review by a person, reference " + key + ", so you won't need to repeat what you've told me. I can't transfer you to a live agent from this chat." };
    // PZ-D2: carry the customer's own claims into the human summary (deterministic keyword inference).
    const said = s(customer_request).toLowerCase();
    const claims = ["WANTS_HUMAN"];
    if (/not (been )?(received|delivered|arrived)|never (came|arrived|got)|nobody came|no one came|didn'?t (get|receive|arrive)|did not (get|receive|arrive)|not delivered/.test(said)) claims.push("NOT_RECEIVED");
    if (/twice|double|two charges|charged 2|duplicate/.test(said)) claims.push("CHARGED_TWICE");
    if (/late|delay|waiting|still not here/.test(said)) claims.push("LATE");
    if (/missing|left out/.test(said)) claims.push("MISSING_ITEMS");
    if (/wrong (item|pizza|order)/.test(said)) claims.push("WRONG_ITEMS");
    if (/refund/.test(said) && /not (received|got)|haven'?t (received|got)|still waiting/.test(said)) claims.push("REFUND_NOT_RECEIVED");
    const r = await this.evaluate(ctx, claims);
    // Data minimisation: strip digit runs (phones, cards, postcodes) and emails before persisting.
    const note = s(customer_request).replace(/\d[\d\s-]{3,}\d/g, "[digits removed]").replace(/\S+@\S+/g, "[email removed]").slice(0, 200);
    const value = { kind: "ESCALATION", status: "QUEUED_FOR_HUMAN_REVIEW", order_id: ctx.b.order ? ctx.b.order.key : "", ref: ctx.ref, customer_id: ctx.sess.customer_id,
      reason: r.reason_code.slice(0, 120), decision: r.decision, evidence: r.evidence.map((e) => e.ref).join(","),
      summary: ("Verified customer (synthetic KBA). Decision " + r.decision + ". Findings: " + r.reason_code + ". Actions on file: " + (ctx.ledger.filter((l) => ctx.b.refs.includes(up(l.value.order_id)) || ctx.b.refs.includes(up(l.value.payment_id))).filter((l) => ["REFUND_REQUEST", "DELIVERY_INVESTIGATION"].includes(up(l.value.kind))).map((l) => l.key).join(",") || "none") + ".").slice(0, 480),
      customer_note: hasInjection(note) ? "[removed: instruction-like text]" : note, session: ctx.sess.id, created_at: this.iso() };
    let w; try { w = await this.writeOnce(key, value, (v) => s(v.ref) === ctx.ref); } catch { w = { outcome: "UNKNOWN" }; }
    this.log({ tool: "record_human_review", ref: ctx.ref, key, outcome: w.outcome });
    if (w.outcome === "CREATED" || w.outcome === "CONFIRMED_AFTER_TIMEOUT") return { action: "RECORD_HUMAN_REVIEW", outcome: "QUEUED", review_ref: key, live_transfer: "NOT_AVAILABLE", ledger_row_id: w.row && w.row.id, summary: value.summary,
      customer_message: "I've recorded your case for review by a person, reference " + key + ", with everything we've checked so you won't have to repeat it. I can't transfer you to a live agent from this chat, and I can't say exactly when they'll pick it up." };
    if (w.outcome === "ALREADY_EXISTS") return { action: "RECORD_HUMAN_REVIEW", outcome: "ALREADY_QUEUED", duplicate_prevented: true, review_ref: key, live_transfer: "NOT_AVAILABLE", customer_message: "Your case is already queued for review by a person, reference " + key + "." };
    return { action: "RECORD_HUMAN_REVIEW", outcome: "UNKNOWN", live_transfer: "NOT_AVAILABLE", customer_message: "I couldn't confirm that your case was recorded for review, so I won't say it was. Please ask me to try again." };
  }
}

installMultiAgent(PizzaService);
installExecution(PizzaService);
installCollab(PizzaService);
installGoodwill(PizzaService);

function base32(buf) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, val = 0, out = "";
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += A[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += A[(val << (5 - bits)) & 31];
  return out;
}
