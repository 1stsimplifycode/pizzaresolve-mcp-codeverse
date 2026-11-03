// PizzaResolve multi-agent extension (Team CodeVerse).
// Adds: customer login (portal login code -> server-side session), customer context, Order Issue, Address,
// Coupon specialists, and the deterministic coordination layer (resolve_case) used by the Talkdesk Supervisor.
// All authorisation, money and state decisions are made here in code; the language model only relays results.
import crypto from "node:crypto";
import { s, rupees, hasInjection, POLICY } from "./engine.js";
import { UnknownOutcome } from "./store.js";
import { analyseOrderIssue, analyseAddressChange, analyseCoupon, validateAddress, DOMAIN_POLICY, ISSUE_TYPES } from "./domains.js";
import { hashPin } from "./seed_data.js";

const up = (v) => s(v).toUpperCase();
const SEV = { RESOLVED_VERIFIED: 0, ACTION_PENDING: 1, ACTION_REQUIRED: 2, INSUFFICIENT_EVIDENCE: 3, CONFLICTING_RECORDS: 4, ESCALATION_REQUIRED: 5, SECURITY_BLOCKED: 6 };
export const LOGIN_POLICY = Object.freeze({ CODE_TTL_MIN: 15, MAX_PIN_FAILS: 5, PIN_WINDOW_MIN: 30 });
export const DEPARTMENTS = ["PAYMENT", "DELIVERY", "ORDER_ISSUE", "ADDRESS", "COUPON", "CANCEL", "HUMAN"];
const DEPT_ALIASES = { REFUND: "PAYMENT", PAYMENTS: "PAYMENT", CHARGED_TWICE: "PAYMENT", ORDER_MISSING: "PAYMENT", REFUND_NOT_RECEIVED: "PAYMENT",
  LATE: "DELIVERY", NOT_RECEIVED: "DELIVERY", NOT_DELIVERED: "DELIVERY", WRONG_ITEM: "ORDER_ISSUE", MISSING_ITEM: "ORDER_ISSUE", WRONG_ITEMS: "ORDER_ISSUE", MISSING_ITEMS: "ORDER_ISSUE",
  DAMAGED: "ORDER_ISSUE", ADDRESS_CHANGE: "ADDRESS", WRONG_ADDRESS: "ADDRESS", PROMO: "COUPON", OFFER: "COUPON", DISCOUNT: "COUPON", CANCELLATION: "CANCEL", WANTS_HUMAN: "HUMAN", AGENT: "HUMAN" };
export const DEPT_DEADLINE_MS = Number(process.env.PZ_DEPT_DEADLINE_MS || 5000);

function base32(buf) { const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; let bits = 0, val = 0, out = ""; for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += A[(val >>> (bits - 5)) & 31]; bits -= 5; } } return out; }
const parseList = (v) => (Array.isArray(v) ? v : s(v).split(/[,;\s]+/)).map(up).filter(Boolean);
export function normaliseDepartments(v) { return [...new Set(parseList(v).map((x) => DEPT_ALIASES[x] || x).filter((x) => DEPARTMENTS.includes(x)))]; }

// Deadline wrapper: a department that does not answer in time is reported as TIMEOUT, never as success.
export async function withDeadline(promise, ms, label) {
  let timer;
  const to = new Promise((resolve) => { timer = setTimeout(() => resolve({ __timeout: true, label }), ms); if (timer.unref) timer.unref(); });
  try { return await Promise.race([promise, to]); } finally { clearTimeout(timer); }
}

export function installMultiAgent(Svc) {
  const P = Svc.prototype;

  // ---------- customer portal login (outside the chat; PIN never enters the conversation) ----------
  P.portalLogin = async function ({ login_id, pin }) {
    const id = s(login_id).toLowerCase().slice(0, 40);
    const now = this.now();
    if (!/^[a-z0-9._-]{3,40}$/.test(id) || !/^\d{4,6}$/.test(s(pin))) return { ok: false, reason: "INVALID_INPUT" };
    let accounts, ledger;
    try { [accounts, ledger] = await Promise.all([this.store.list("accounts"), this.store.list("ledger")]); } catch { return { ok: false, reason: "SYSTEM_UNAVAILABLE" }; }
    const fails = ledger.filter((l) => up(l.value.kind) === "LOGIN_FAILED" && s(l.value.ref) === id && (now - Date.parse(l.value.created_at)) / 60000 <= LOGIN_POLICY.PIN_WINDOW_MIN).length;
    if (fails >= LOGIN_POLICY.MAX_PIN_FAILS) return { ok: false, reason: "LOCKED" };
    const acc = accounts.find((a) => a.key.toLowerCase() === id);
    const good = acc && up(acc.value.status) === "ACTIVE" && crypto.timingSafeEqual(Buffer.from(hashPin(pin, s(acc.value.pin_salt)), "hex"), Buffer.from(s(acc.value.pin_hash).padEnd(64, "0").slice(0, 64), "hex"));
    if (!good) {
      try { await this.store.create("ledger", "LGF-" + now + "-" + crypto.randomBytes(3).toString("hex").toUpperCase(), { kind: "LOGIN_FAILED", ref: id, status: "FAILED", created_at: this.iso() }); } catch { /* best effort */ }
      this.log({ portal: "login", result: "FAILED" });
      return { ok: false, reason: "BAD_CREDENTIALS" };
    }
    const code = "LC-" + base32(crypto.randomBytes(6)).slice(0, 8);
    const exp = new Date(now + LOGIN_POLICY.CODE_TTL_MIN * 60000).toISOString();
    try {
      const r = await this.store.create("ledger", code, { kind: "LOGIN_CODE", status: "ISSUED", customer_id: s(acc.value.customer_id), ref: "PORTAL", created_at: this.iso(), expires_at: exp });
      if (r.status !== "CREATED") return { ok: false, reason: "RETRY" };
    } catch { return { ok: false, reason: "SYSTEM_UNAVAILABLE" }; }
    this.log({ portal: "login", result: "CODE_ISSUED" });
    return { ok: true, login_code: code, expires_at: exp };
  };

  // Single-use redemption: the unique ledger key LCU-<code> makes a second redemption impossible (409).
  P.redeemLoginCode = async function (raw) {
    const code = up(raw).replace(/\s+/g, "");
    if (!/^LC-[A-Z2-7]{8}$/.test(code)) return { err: "LOGIN_CODE_INVALID" };
    const ledger = await this.store.list("ledger");
    const row = ledger.find((l) => l.key === code && up(l.value.kind) === "LOGIN_CODE");
    if (!row) return { err: "LOGIN_CODE_INVALID" };
    if (Date.parse(row.value.expires_at) < this.now()) return { err: "LOGIN_CODE_EXPIRED" };
    const used = await this.store.create("ledger", "LCU-" + code, { kind: "LOGIN_CODE_USED", status: "USED", ref: code, customer_id: s(row.value.customer_id), created_at: this.iso() });
    if (used.status !== "CREATED") return { err: "LOGIN_CODE_USED" };
    const sid = "VS-" + base32(crypto.randomBytes(7)).slice(0, 10);
    const exp = new Date(this.now() + POLICY.SESSION_TTL_MIN * 60000).toISOString();
    const r = await this.store.create("ledger", sid, { kind: "SESSION", ref: "LOGIN", reason: "PORTAL_LOGIN", customer_id: s(row.value.customer_id), status: "ACTIVE", created_at: this.iso(), expires_at: exp });
    if (r.status !== "CREATED") return { err: "SESSION_NOT_CREATED" };
    return { sid, customer_id: s(row.value.customer_id), expires_at: exp };
  };

  // ---------- Identity & Context agent: who is the logged-in customer, what are their orders and open cases ----------
  P.customerContext = async function ({ login_code, session_id }) {
    let sid = up(session_id), customerId, created = false;
    try {
      if (s(login_code)) {
        const r = await this.redeemLoginCode(login_code);
        if (r.err) {
          this.log({ tool: "get_customer_context", result: r.err });
          return { verified: false, decision: "SECURITY_BLOCKED", reason_code: r.err, customer_message: r.err === "LOGIN_CODE_USED" ? "That login code has already been used. Please log in again on the PizzaResolve page to get a new code, or verify with your order details." : "That login code isn't valid or has expired. Please log in again to get a new code, or verify with your order number, the last 4 digits of your phone and your postcode." };
        }
        sid = r.sid; customerId = r.customer_id; created = true;
      }
      const ledger = await this.store.list("ledger");
      const sess = await this.session(sid, ledger);
      if (!sess) return { verified: false, decision: "SECURITY_BLOCKED", reason_code: "NOT_VERIFIED", customer_message: "I need to verify you first: please share your login code, or your order number, the last 4 digits of the phone on the account and your delivery postcode." };
      if (sess.expired) return { verified: false, decision: "SECURITY_BLOCKED", reason_code: "SESSION_EXPIRED", customer_message: "For security, your verification has expired. Please log in again or verify with your order details." };
      customerId = sess.customer_id;
      const sRow = ledger.find((l) => l.key === sess.id);
      const viaLogin = s(sRow && sRow.value.reason) === "PORTAL_LOGIN";
      const [customers, orders] = await Promise.all([this.store.list("customers"), this.store.list("orders")]);
      const c = customers.find((x) => x.key === customerId);
      // KBA sessions only see the order they verified; portal-login sessions see the whole account.
      let mine = orders.filter((o) => s(o.value.customer_id) === customerId);
      if (!viaLogin) { const ref = s(sRow && sRow.value.ref); mine = mine.filter((o) => o.key === ref); }
      mine = mine.sort((a, b) => Date.parse(b.value.placed_at) - Date.parse(a.value.placed_at)).slice(0, 8);
      const refs = new Set(mine.map((o) => o.key));
      const open = ledger.filter((l) => refs.has(s(l.value.order_id)) && ["REFUND_REQUEST", "DELIVERY_INVESTIGATION", "ESCALATION", "ORDER_ISSUE", "ITEM_REFUND_REQUEST", "REPLACEMENT_REQUEST", "ADDRESS_CHANGE", "PROMO_ADJUSTMENT_REQUEST", "CANCELLATION_REQUEST"].includes(up(l.value.kind)))
        .map((l) => ({ ref: l.key, kind: up(l.value.kind), status: up(l.value.status), order_id: s(l.value.order_id) }));
      this.log({ tool: "get_customer_context", result: "OK", session: sess.id, via: viaLogin ? "LOGIN" : "KBA" });
      return { verified: true, session_id: sess.id, session_created: created, authentication: viaLogin ? "PORTAL_LOGIN (PIN checked by the PizzaResolve portal; code single-use)" : "SYNTHETIC_KNOWLEDGE_BASED",
        customer: { first_name: s(c && c.value.first_name), account_status: up(c && c.value.status) || "UNKNOWN" },
        orders: mine.map((o) => ({ order_id: o.key, status: up(o.value.status), total: rupees(Number(o.value.total_paise) || 0), items: s(o.value.items), placed_at: s(o.value.placed_at) })),
        open_cases: open,
        customer_message: "Hi " + s(c && c.value.first_name) + ", you're signed in." + (mine.length ? " I can see " + mine.length + " recent order" + (mine.length > 1 ? "s" : "") + " on your account: " + mine.slice(0, 4).map((o) => o.key + " (" + up(o.value.status).toLowerCase().replace(/_/g, " ") + ")").join(", ") + ". Which one is this about?" : "") };
    } catch (e) {
      return { verified: false, decision: "INSUFFICIENT_EVIDENCE", reason_code: "SYSTEM_UNAVAILABLE", customer_message: "I can't reach our account system right now, so I can't confirm anything. Nothing has been changed." };
    }
  };

  // ---------- shared reads for the new specialists ----------
  P.domainBundle = async function (ctx) {
    const oid = ctx.b.order ? ctx.b.order.key : null;
    const [details, events, refunds] = await Promise.all([
      this.store.list("details").then((r) => r.find((d) => d.key === oid) || null),
      this.store.list("events").then((r) => r.filter((e) => s(e.value.order_id) === oid)),
      this.store.list("refunds").then((r) => r.filter((x) => s(x.value.order_id) === oid)).catch(() => []),
    ]);
    const related = ctx.ledger.filter((l) => oid && s(l.value.order_id) === oid);
    return { details, events, refunds, related };
  };
  P.freshEnough = function (ctx, maxMin) {
    const row = ctx.ledger.find((l) => l.key === ctx.sess.id);
    return row && (this.now() - Date.parse(row.value.created_at)) / 60000 <= maxMin;
  };
  P.ledgerWrite = async function (key, value) {
    let w; try { w = await this.writeOnce(key, value, (v) => s(v.order_id) === s(value.order_id) && s(v.kind) === s(value.kind)); } catch { w = { outcome: "UNKNOWN" }; }
    return w;
  };

  // ---------- Order Issue agent ----------
  P.reportOrderIssue = async function ({ session_id, reference, issue_type, item = "", description = "", remedy = "" }) {
    const ctx = await this.authorise(session_id, reference);
    if (ctx.err) return ctx.err;
    let d; try { d = await this.domainBundle(ctx); } catch { return { decision: "INSUFFICIENT_EVIDENCE", reason_code: "SYSTEM_UNAVAILABLE", customer_message: "I can't reach the order system right now, so I can't check the items. Nothing has been changed." }; }
    const r = analyseOrderIssue({ order: ctx.b.order, details: d.details, events: d.events, ledger: d.related, refunds: d.refunds, claim: { type: issue_type, item }, now: this.now() });
    const out = { reference: ctx.ref, order_id: ctx.b.order && ctx.b.order.key, ...r };
    const note = hasInjection(description) ? "[removed: instruction-like text]" : s(description).replace(/\d[\d\s-]{5,}\d/g, "[digits removed]").slice(0, 200);
    if (r.record_complaint && ctx.b.order) {
      const key = "ISSUE-" + ctx.b.order.key + "-" + up(issue_type);
      const w = await this.ledgerWrite(key, { kind: "ORDER_ISSUE", status: "LOGGED", order_id: ctx.b.order.key, ref: ctx.ref, customer_id: ctx.sess.customer_id, reason: r.reason_code, decision: r.decision,
        evidence: (r.evidence || []).map((e) => e.ref).join(","), summary: ("Claim " + up(issue_type) + (item ? " item '" + s(item).slice(0, 60) + "'" : "") + ". " + r.reason_code + (r.amount_paise ? " affected " + rupees(r.amount_paise) : "")).slice(0, 400), customer_note: note, session: ctx.sess.id, created_at: this.iso() });
      out.complaint_ref = ["CREATED", "CONFIRMED_AFTER_TIMEOUT", "ALREADY_EXISTS"].includes(w.outcome) ? key : null;
      out.complaint_record = w.outcome;
      if (out.complaint_ref) out.customer_message += " I've logged the complaint, reference " + key + ".";
      else out.customer_message += " I couldn't confirm the complaint was saved, so please ask me to try again.";
    }
    const want = up(remedy);
    if (want === "REFUND" || want === "REPLACEMENT") {
      const act = r.authorized_actions.find((a) => a.action === (want === "REFUND" ? "REQUEST_ITEM_REFUND" : "REQUEST_REPLACEMENT"));
      if (!act) { out.remedy = { outcome: "NOT_AUTHORIZED" }; out.customer_message += " I can't raise a " + want.toLowerCase() + " for this automatically."; }
      else {
        const key = (want === "REFUND" ? "ITEMREF-" : "REPL-") + ctx.b.order.key;
        const w = await this.ledgerWrite(key, { kind: want === "REFUND" ? "ITEM_REFUND_REQUEST" : "REPLACEMENT_REQUEST", status: "REQUESTED", order_id: ctx.b.order.key, ref: ctx.ref, customer_id: ctx.sess.customer_id,
          amount_paise: want === "REFUND" ? String(act.amount_paise) : "", reason: r.reason_code, evidence: (r.evidence || []).map((e) => e.ref).join(","), session: ctx.sess.id, created_at: this.iso() });
        out.remedy = { outcome: w.outcome === "CREATED" || w.outcome === "CONFIRMED_AFTER_TIMEOUT" ? "REQUESTED" : w.outcome === "ALREADY_EXISTS" ? "ALREADY_REQUESTED" : "UNKNOWN", ref: key, money_moved: false };
        out.customer_message = out.remedy.outcome === "UNKNOWN" ? "I tried to raise the request but couldn't confirm it was saved, so I won't say it was. Asking again won't create a duplicate."
          : (want === "REFUND" ? "I've raised a refund request for " + rupees(act.amount_paise) + " for the affected item" : "I've asked the restaurant to send a replacement for " + act.items.join(", ")) + ", reference " + key + "." +
            (want === "REFUND" ? " This is a request, not a completed refund." : " The restaurant still has to confirm and dispatch it, so I can't promise a time yet.") + (out.remedy.outcome === "ALREADY_REQUESTED" ? " (It was already on file, so nothing new was created.)" : "");
      }
    }
    this.log({ tool: "report_order_issue", ref: ctx.ref, decision: r.decision, reason: r.reason_code });
    return out;
  };

  // ---------- Address Modification agent ----------
  P.checkAddressChange = async function ({ session_id, reference, new_address_line = "", new_postcode = "", apply = false }) {
    const ctx = await this.authorise(session_id, reference);
    if (ctx.err) return ctx.err;
    let d, zones; try { [d, zones] = await Promise.all([this.domainBundle(ctx), this.store.list("config")]); } catch { return { decision: "INSUFFICIENT_EVIDENCE", reason_code: "SYSTEM_UNAVAILABLE", customer_message: "I can't reach the order system right now, so I can't change the address. Nothing has been changed." }; }
    const r = analyseAddressChange({ order: ctx.b.order, details: d.details, events: d.events, zones, newLine: new_address_line, newPostcode: new_postcode });
    const out = { reference: ctx.ref, order_id: ctx.b.order && ctx.b.order.key, ...r };
    const yes = apply === true || /^(true|yes|1)$/i.test(s(apply));
    if (!yes || r.reason_code !== "ADDRESS_CHANGE_ALLOWED") return out;
    if (!this.freshEnough(ctx, DOMAIN_POLICY.ADDRESS_FRESH_SESSION_MIN)) return { ...out, decision: "SECURITY_BLOCKED", reason_code: "REVERIFY_REQUIRED", applied: false, customer_message: "For security, changing an address needs a fresh verification. Please verify again and I'll make the change." };
    // Concurrency: the version-keyed ledger row is a compare-and-swap. Two concurrent changes cannot both win.
    const ver = Number(r.address_version) || 1;
    const key = "ADDR-" + ctx.b.order.key + "-V" + (ver + 1);
    let cas; try { cas = await this.store.create("ledger", key, { kind: "ADDRESS_CHANGE", status: "PENDING_APPLY", order_id: ctx.b.order.key, ref: ctx.ref, customer_id: ctx.sess.customer_id, reason: "CUSTOMER_REQUEST", summary: (r.new_address.line + ", " + r.new_address.postcode).slice(0, 200), session: ctx.sess.id, created_at: this.iso() }); }
    catch (e) { return { ...out, applied: false, outcome: "UNKNOWN", customer_message: "I couldn't confirm whether the change was saved, so I won't say it was. The current address is unchanged as far as I can confirm; please ask me to check again." }; }
    if (cas.status !== "CREATED") return { ...out, applied: false, outcome: "CONCURRENT_CHANGE", customer_message: "Another change to this order's address was made at the same moment, so I haven't applied yours. Let me know if you'd like me to check the current address." };
    const newDetails = { ...d.details.value, address_line: r.new_address.line, postcode: r.new_address.postcode, address_version: String(ver + 1) };
    let applied = false;
    try { const u = await this.store.update("details", ctx.b.order.key, newDetails); applied = u.status === "UPDATED"; } catch { applied = false; }
    let confirmed = false;
    try { const back = await this.store.getByKey("details", ctx.b.order.key); confirmed = !!back && s(back.value.postcode) === r.new_address.postcode && s(back.value.address_version) === String(ver + 1); } catch { confirmed = false; }
    try { const row = await this.store.getByKey("ledger", key); if (row) await this.store.update("ledger", key, { ...row.value, status: confirmed ? "APPLIED" : "APPLY_FAILED" }); } catch { /* status row is advisory; the details row is the source of truth */ }
    this.log({ tool: "check_address_change", ref: ctx.ref, key, applied: confirmed });
    if (!confirmed) return { ...out, applied: false, outcome: "APPLY_FAILED", change_ref: key, customer_message: "I tried to change the address but couldn't confirm the order system saved it, so please treat the old address as still current. I can record this for a person to fix." };
    return { ...out, decision: "RESOLVED_VERIFIED", reason_code: "ADDRESS_CHANGED", applied: true, outcome: "APPLIED", change_ref: key, address_version: String(ver + 1),
      customer_message: "Done: the delivery address for " + ctx.b.order.key + " is now " + r.new_address.line + ", " + r.new_address.postcode + " (change reference " + key + "). The restaurant system confirmed the update." };
  };

  // ---------- Offers & Coupons agent ----------
  P.checkCoupon = async function ({ session_id, reference, coupon_code = "", request_adjustment = false }) {
    const ctx = await this.authorise(session_id, reference);
    if (ctx.err) return ctx.err;
    let d, promotions, orders; try { [d, promotions, orders] = await Promise.all([this.domainBundle(ctx), this.store.list("promotions"), this.store.list("orders")]); } catch { return { decision: "INSUFFICIENT_EVIDENCE", reason_code: "SYSTEM_UNAVAILABLE", customer_message: "I can't reach the promotions system right now, so I can't check the coupon. Nothing has been changed." }; }
    const r = analyseCoupon({ order: ctx.b.order, details: d.details, promotions, code: coupon_code, customerOrders: orders.filter((o) => s(o.value.customer_id) === ctx.sess.customer_id), ledger: d.related, refunds: d.refunds });
    const out = { reference: ctx.ref, order_id: ctx.b.order && ctx.b.order.key, ...r };
    const yes = request_adjustment === true || /^(true|yes|1)$/i.test(s(request_adjustment));
    const act = r.authorized_actions.find((a) => a.action === "REQUEST_PROMO_ADJUSTMENT");
    if (yes && act) {
      const key = "PROMOADJ-" + ctx.b.order.key;
      const w = await this.ledgerWrite(key, { kind: "PROMO_ADJUSTMENT_REQUEST", status: "REQUESTED", order_id: ctx.b.order.key, ref: ctx.ref, customer_id: ctx.sess.customer_id, amount_paise: String(act.amount_paise), reason: r.reason_code + " " + act.coupon, session: ctx.sess.id, created_at: this.iso() });
      out.adjustment = { outcome: w.outcome === "CREATED" || w.outcome === "CONFIRMED_AFTER_TIMEOUT" ? "REQUESTED" : w.outcome === "ALREADY_EXISTS" ? "ALREADY_REQUESTED" : "UNKNOWN", ref: key, money_moved: false };
      out.customer_message = out.adjustment.outcome === "UNKNOWN" ? "I couldn't confirm the correction request was saved, so I won't say it was. Asking again won't create a duplicate."
        : "I've raised a discount correction request for " + rupees(act.amount_paise) + ", reference " + key + ". This is a request, not a completed refund; the billing team still has to send it." + (out.adjustment.outcome === "ALREADY_REQUESTED" ? " (It was already on file.)" : "");
    }
    this.log({ tool: "check_coupon", ref: ctx.ref, decision: r.decision, reason: r.reason_code });
    return out;
  };

  // ---------- Human handoff agent: explicit, independently evidenced handoff states ----------
  const baseReview = P.recordHumanReview;
  P.recordHumanReview = async function (a) {
    const r = await baseReview.call(this, a);
    if (r && r.action === "RECORD_HUMAN_REVIEW") {
      const recorded = ["QUEUED", "ALREADY_QUEUED"].includes(r.outcome);
      r.handoff = { escalation_requested: true, escalation_record: recorded ? "CREATED:" + r.review_ref : r.outcome,
        queue_handoff: "NOT_PERFORMED_BY_THIS_TOOL (Talkdesk escalation exit / Studio Assignment and Dial must do it)",
        human_agent_assigned: "NO_EVIDENCE", human_connected: "NO_EVIDENCE" };
    }
    return r;
  };

  // ---------- cancellation request (used by the coordinator; restaurant must confirm) ----------
  P.cancellationAssessment = function (order, events) {
    if (!order) return { decision: "INSUFFICIENT_EVIDENCE", reason_code: "NO_ORDER", customer_message: "There is no order to cancel for this reference.", authorized_actions: [] };
    const st = up(order.value.status);
    const picked = (events || []).some((e) => up(e.value.source) === "COURIER" && ["PICKED_UP", "OUT_FOR_DELIVERY", "DELIVERED"].includes(up(e.value.event)));
    if (["PLACED", "ACCEPTED"].includes(st) && !picked) return { decision: "ACTION_REQUIRED", reason_code: "CANCELLATION_ALLOWED", customer_message: "The order hasn't started cooking yet, so I can ask the restaurant to cancel it.", authorized_actions: [{ action: "REQUEST_CANCELLATION", order_id: order.key }] };
    if (st === "PREPARING" && !picked) return { decision: "ESCALATION_REQUIRED", reason_code: "CANCELLATION_NEEDS_RESTAURANT", customer_message: "The restaurant has already started preparing this order, so it can't be cancelled automatically. I can record a cancellation request for a person to review with the restaurant.", authorized_actions: [{ action: "REQUEST_CANCELLATION", order_id: order.key }] };
    return { decision: "RESOLVED_VERIFIED", reason_code: "CANCELLATION_NOT_POSSIBLE", customer_message: "This order has already " + (st === "DELIVERED" ? "been delivered" : st === "CANCELLED" ? "been cancelled" : "left the restaurant") + ", so it can't be cancelled.", authorized_actions: [] };
  };

  // ---------- Coordination layer: one entry point for multi-department cases ----------
  // Reads run in parallel with per-department deadlines; writes run sequentially in a safe order.
  P.resolveCase = async function ({ session_id, reference, departments = "", issue_type = "", item = "", new_address_line = "", new_postcode = "", coupon_code = "", confirm_actions = "", deadline_ms }) {
    const started = this.now();
    const t0 = Date.now();
    const ctx = await this.authorise(session_id, reference);
    if (ctx.err) return ctx.err;
    let depts = normaliseDepartments(departments);
    if (!depts.length) depts = ["PAYMENT", "DELIVERY"];
    const deadline = Number(deadline_ms) > 0 ? Math.min(Number(deadline_ms), 20000) : DEPT_DEADLINE_MS;
    const timeline = [];
    const run = (name, fn) => {
      const st = Date.now() - t0;
      const p = Promise.resolve().then(fn).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e }));
      return withDeadline(p, deadline, name).then((x) => {
        timeline.push({ department: name, started_ms: st, finished_ms: Date.now() - t0 });
        if (x && x.__timeout) return { department: name, status: "TIMEOUT", decision: "INSUFFICIENT_EVIDENCE", reason_code: "DEPARTMENT_TIMEOUT", customer_message: "One of our systems (" + name.toLowerCase().replace("_", " ") + ") didn't answer in time, so I can't confirm that part yet. Nothing was changed for it.", authorized_actions: [] };
        if (!x.ok) return { department: name, status: "ERROR", decision: "INSUFFICIENT_EVIDENCE", reason_code: "DEPARTMENT_ERROR", customer_message: "I couldn't check the " + name.toLowerCase().replace("_", " ") + " part right now, so I won't guess. Nothing was changed for it.", authorized_actions: [] };
        return { department: name, status: "OK", ...x.r };
      });
    };
    // Payment + delivery share one reconciliation (they read the same records); the others are independent.
    let evalP = null;
    const reconcileOnce = () => (evalP ||= this.evaluate(ctx, parseList(departments).filter((x) => ["NOT_RECEIVED", "LATE", "CHARGED_TWICE", "ORDER_MISSING", "REFUND_NOT_RECEIVED", "WRONG_ADDRESS", "MISSING_ITEMS", "WRONG_ITEMS"].includes(x)).concat(depts.includes("DELIVERY") ? ["LATE"] : [])));
    const pick = (r, kinds) => ({ decision: r.decision, reason_code: r.reason_code, customer_message: r.customer_message, evidence: r.evidence, authorized_actions: r.authorized_actions.filter((a) => kinds.includes(a.action)) });
    const tasks = depts.filter((d) => d !== "HUMAN").map((d) => {
      if (d === "PAYMENT") return run(d, async () => pick(await reconcileOnce(), ["REQUEST_REFUND"]));
      if (d === "DELIVERY") return run(d, async () => pick(await reconcileOnce(), ["OPEN_DELIVERY_INVESTIGATION"]));
      if (d === "ORDER_ISSUE") return run(d, async () => { const b = await this.domainBundle(ctx); return analyseOrderIssue({ order: ctx.b.order, details: b.details, events: b.events, ledger: b.related, refunds: b.refunds, claim: { type: up(issue_type) || "MISSING_ITEM", item }, now: this.now() }); });
      if (d === "ADDRESS") return run(d, async () => { const [b, zones] = await Promise.all([this.domainBundle(ctx), this.store.list("config")]); return analyseAddressChange({ order: ctx.b.order, details: b.details, events: b.events, zones, newLine: new_address_line, newPostcode: new_postcode }); });
      if (d === "COUPON") return run(d, async () => { const [b, promotions, orders] = await Promise.all([this.domainBundle(ctx), this.store.list("promotions"), this.store.list("orders")]); return analyseCoupon({ order: ctx.b.order, details: b.details, promotions, code: coupon_code, customerOrders: orders.filter((o) => s(o.value.customer_id) === ctx.sess.customer_id), ledger: b.related, refunds: b.refunds }); });
      if (d === "CANCEL") return run(d, async () => { const b = await this.domainBundle(ctx); return this.cancellationAssessment(ctx.b.order, b.events); });
      return null;
    }).filter(Boolean);
    const results = await Promise.all(tasks);
    if (depts.includes("HUMAN")) results.push({ department: "HUMAN", status: "OK", decision: "ESCALATION_REQUIRED", reason_code: "CUSTOMER_REQUESTED_HUMAN", customer_message: "", authorized_actions: [{ action: "RECORD_HUMAN_REVIEW", order_id: ctx.b.order && ctx.b.order.key }] });

    // ---- deterministic conflict resolution across departments ----
    const conflicts = [];
    const byDept = Object.fromEntries(results.map((r) => [r.department, r]));
    let actions = results.flatMap((r) => (r.authorized_actions || []).map((a) => ({ ...a, department: r.department })));
    if (byDept.CANCEL && byDept.ADDRESS && byDept.CANCEL.authorized_actions.length) {
      actions = actions.filter((a) => a.action !== "CHANGE_ADDRESS");
      conflicts.push({ code: "ADDRESS_CHANGE_SUPERSEDED_BY_CANCELLATION", say: "You asked both to cancel and to change the address; I won't change the address while a cancellation is being considered. Tell me which one you want." });
    }
    const delivered = ctx.b.order && up(ctx.b.order.value.status) === "DELIVERED";
    if (byDept.ORDER_ISSUE && byDept.DELIVERY && /NOT_RECEIVED/.test(s(departments).toUpperCase()) && byDept.ORDER_ISSUE.reason_code && /VERIFIED/.test(byDept.ORDER_ISSUE.reason_code)) {
      actions = actions.filter((a) => !["REQUEST_REFUND", "REQUEST_ITEM_REFUND", "REQUEST_REPLACEMENT"].includes(a.action));
      conflicts.push({ code: "CONTRADICTORY_CLAIMS", say: "You've said the order didn't arrive and also that items in it were wrong, so I need to check which it is before I raise anything. Did the order arrive?" });
    }
    // One compensation per order: a full refund supersedes item refunds and coupon corrections (double-compensation prevention).
    if (actions.some((a) => a.action === "REQUEST_REFUND")) {
      const dropped = actions.filter((a) => ["REQUEST_ITEM_REFUND", "REQUEST_PROMO_ADJUSTMENT"].includes(a.action));
      if (dropped.length) { actions = actions.filter((a) => !dropped.includes(a)); conflicts.push({ code: "DOUBLE_COMPENSATION_PREVENTED", say: "Because a full refund request is possible for this payment, I won't add an item refund or discount correction on top of it." }); }
    }
    const captured = ctx.b.payments.filter((p) => ["CAPTURED", "SETTLED"].includes(up(p.value.status))).reduce((x, p) => x + (Number(p.value.amount_paise) || 0), 0);
    let money = 0;
    actions = actions.filter((a) => { if (!a.amount_paise) return true; if (money + a.amount_paise > captured) { conflicts.push({ code: "COMPENSATION_CAP", say: "I can't raise more than was charged, so one request was left out." }); return false; } money += a.amount_paise; return true; });
    const ids = new Map();
    for (const a of actions) {
      const target = a.payment_id || a.order_id || ctx.ref;
      const id = a.action + ":" + target;
      if (!ids.has(id)) ids.set(id, { action_id: id, ...a });
    }
    const plan = [...ids.values()];
    let decision = "RESOLVED_VERIFIED";
    for (const r of results) if (SEV[r.decision] > SEV[decision]) decision = r.decision;
    if (conflicts.some((c) => c.code === "CONTRADICTORY_CLAIMS")) decision = SEV[decision] > SEV.INSUFFICIENT_EVIDENCE ? decision : "INSUFFICIENT_EVIDENCE";
    const partial = results.some((r) => r.status !== "OK");

    // ---- execution of the actions the customer agreed to (sequential; financial last) ----
    const confirm = new Set(parseList(confirm_actions));
    const executed = [];
    if (confirm.size) {
      const order = ["OPEN_DELIVERY_INVESTIGATION", "CHANGE_ADDRESS", "REQUEST_REPLACEMENT", "REQUEST_CANCELLATION", "RECORD_HUMAN_REVIEW", "REQUEST_ITEM_REFUND", "REQUEST_PROMO_ADJUSTMENT", "REQUEST_REFUND"];
      const todo = plan.filter((p) => confirm.has(up(p.action_id))).sort((a, b) => order.indexOf(a.action) - order.indexOf(b.action));
      for (const id of confirm) if (!plan.some((p) => up(p.action_id) === id)) executed.push({ action_id: id, outcome: "NOT_AUTHORIZED", note: "not in the current plan (re-evaluated server-side)" });
      for (const p of todo) {
        let r;
        try {
          if (p.action === "REQUEST_REFUND") r = await this.requestRefund({ session_id, reference: ctx.ref, payment_id: p.payment_id });
          else if (p.action === "OPEN_DELIVERY_INVESTIGATION") r = await this.openDeliveryInvestigation({ session_id, reference: ctx.ref });
          else if (p.action === "RECORD_HUMAN_REVIEW") r = await this.recordHumanReview({ session_id, reference: ctx.ref, customer_request: "Multi-department case: " + depts.join(", ") });
          else if (p.action === "REQUEST_ITEM_REFUND") r = await this.reportOrderIssue({ session_id, reference: ctx.ref, issue_type: issue_type || "MISSING_ITEM", item, remedy: "REFUND" });
          else if (p.action === "REQUEST_REPLACEMENT") r = await this.reportOrderIssue({ session_id, reference: ctx.ref, issue_type: issue_type || "MISSING_ITEM", item, remedy: "REPLACEMENT" });
          else if (p.action === "CHANGE_ADDRESS") r = await this.checkAddressChange({ session_id, reference: ctx.ref, new_address_line, new_postcode, apply: true });
          else if (p.action === "REQUEST_PROMO_ADJUSTMENT") r = await this.checkCoupon({ session_id, reference: ctx.ref, coupon_code, request_adjustment: true });
          else if (p.action === "REQUEST_CANCELLATION") { const w = await this.ledgerWrite("CANCEL-" + ctx.b.order.key, { kind: "CANCELLATION_REQUEST", status: "REQUESTED", order_id: ctx.b.order.key, ref: ctx.ref, customer_id: ctx.sess.customer_id, reason: "CUSTOMER_REQUEST", session: ctx.sess.id, created_at: this.iso() }); r = { outcome: w.outcome === "CREATED" || w.outcome === "CONFIRMED_AFTER_TIMEOUT" ? "REQUESTED" : w.outcome === "ALREADY_EXISTS" ? "ALREADY_REQUESTED" : "UNKNOWN", request_ref: "CANCEL-" + ctx.b.order.key, customer_message: "I've sent a cancellation request to the restaurant, reference CANCEL-" + ctx.b.order.key + ". It isn't cancelled until the restaurant confirms." }; }
        } catch (e) { r = { outcome: "UNKNOWN", customer_message: "I couldn't confirm this step." }; }
        const okOutcomes = ["REQUESTED", "OPENED", "QUEUED", "APPLIED", "ALREADY_REQUESTED", "ALREADY_OPEN", "ALREADY_QUEUED"];
        const outcome = r.outcome || (r.remedy && r.remedy.outcome) || (r.adjustment && r.adjustment.outcome) || "UNKNOWN";
        executed.push({ action_id: p.action_id, outcome, ok: okOutcomes.includes(outcome), ref: r.request_ref || r.investigation_ref || r.review_ref || r.change_ref || (r.remedy && r.remedy.ref) || (r.adjustment && r.adjustment.ref) || null, customer_message: r.customer_message });
      }
      // Partial failure recovery: if any step failed after others succeeded, record a human follow-up (compensation path).
      if (executed.some((e) => e.ok) && executed.some((e) => !e.ok && e.outcome !== "NOT_AUTHORIZED") && !executed.some((e) => e.action_id.startsWith("RECORD_HUMAN_REVIEW"))) {
        const h = await this.recordHumanReview({ session_id, reference: ctx.ref, customer_request: "Partial failure in multi-step resolution; check steps " + executed.filter((e) => !e.ok).map((e) => e.action_id).join(",") }).catch(() => ({ outcome: "UNKNOWN" }));
        executed.push({ action_id: "RECORD_HUMAN_REVIEW:AUTO_PARTIAL_FAILURE", outcome: h.outcome, ok: ["QUEUED", "ALREADY_QUEUED"].includes(h.outcome), ref: h.review_ref || null, customer_message: h.customer_message });
      }
    }

    // ---- persist the shared case state (versioned; a concurrent writer gets the next version) ----
    const caseId = "CASE-" + (ctx.b.order ? ctx.b.order.key : ctx.ref);
    const state = { case_id: caseId, departments: depts, decision, partial, conflicts: conflicts.map((c) => c.code), plan: plan.map((p) => p.action_id), executed: executed.map((e) => e.action_id + "=" + e.outcome) };
    let caseVersion = null;
    try {
      const existing = (await this.store.list("ledger")).filter((l) => l.key.startsWith(caseId + "-V")).map((l) => Number(l.key.slice(caseId.length + 2)) || 0);
      let v = (existing.length ? Math.max(...existing) : 0) + 1;
      for (let i = 0; i < 3; i++, v++) {
        const w = await this.store.create("ledger", caseId + "-V" + v, { kind: "CASE_STATE", status: executed.length ? (executed.every((e) => e.ok) ? "ACTIONS_DONE" : "ACTIONS_PARTIAL") : decision, order_id: ctx.b.order ? ctx.b.order.key : "", ref: ctx.ref, customer_id: ctx.sess.customer_id, decision, reason: results.map((r) => r.department + ":" + r.reason_code).join("|").slice(0, 300), summary: JSON.stringify(state).slice(0, 900), session: ctx.sess.id, created_at: this.iso() });
        if (w.status === "CREATED") { caseVersion = v; break; }
      }
    } catch (e) { caseVersion = null; }

    const parts = results.map((r) => r.customer_message).filter(Boolean);
    let message = parts.join(" ");
    for (const c of conflicts) message += " " + c.say;
    if (executed.length) message = executed.map((e) => e.customer_message).filter(Boolean).join(" ") + (executed.some((e) => !e.ok) ? " Some steps could not be confirmed, so I haven't claimed them." : "");
    this.log({ tool: "resolve_case", ref: ctx.ref, departments: depts.join(","), decision, partial, executed: executed.length, case_version: caseVersion, ms: Date.now() - t0 });
    return { reference: ctx.ref, case_id: caseId, case_version: caseVersion, decision, partial_results: partial, departments: results.map((r) => ({ department: r.department, status: r.status, decision: r.decision, reason_code: r.reason_code })),
      conflicts: conflicts.map((c) => c.code), plan: plan.map(({ department, ...p }) => ({ ...p, department })), executed, execution_timeline: timeline,
      customer_message: message.trim() + (plan.length && !executed.length ? " (Tell me which of these you'd like me to do.)" : "") };
  };
}
