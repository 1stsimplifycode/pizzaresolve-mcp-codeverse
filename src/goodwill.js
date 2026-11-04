// PizzaResolve goodwill coupons with cross-conversation memory (Team CodeVerse).
// An agent issues a personal "sorry" code after a service failure it fixed. The ledger row remembers WHO got it,
// for WHICH order, WHY, and in WHICH Talkdesk interaction / platform session. In a later conversation (new
// interaction, new verification) another agent finds that promise and honours it, deterministically.
// Ledger row  GWC-<order>: kind GOODWILL_COUPON, ref = code, status ISSUED | REDEEMED, evidence = issuing interaction id,
// customer_note = issuing platform session id, session = our verification session, summary = JSON (terms + redemption).
import crypto from "node:crypto";
import { s, rupees, ist } from "./engine.js";
import { readCoupon } from "./spoken.js";

const up = (v) => s(v).toUpperCase();
const parse = (x) => { try { return JSON.parse(s(x)) || {}; } catch { return {}; } };
const cleanId = (v) => (/^[A-Za-z0-9-]{6,80}$/.test(s(v)) ? s(v) : "");
export const GOODWILL = Object.freeze({ VALUE_PAISE: 10000, MIN_SUBTOTAL_PAISE: 30000, VALID_DAYS: 14, PREFIX: "TREAT" });
// Only orders where something really went wrong (and a record proves it) earn a goodwill code.
const FAILURE_KINDS = new Set(["EXECUTED_REDELIVERY", "EXECUTED_REPLACEMENT", "EXECUTED_REFUND", "EXECUTED_COUPON_CORRECTION", "DELIVERY_INVESTIGATION", "ORDER_ISSUE", "REFUND_REQUEST", "ITEM_REFUND_REQUEST", "REPLACEMENT_REQUEST"]);
const dateIst = (iso) => { const d = new Date(s(iso)); return Number.isFinite(d.getTime()) ? new Date(d.getTime() + 330 * 60000).toISOString().slice(0, 10) : s(iso).slice(0, 10); };

export function installGoodwill(Svc) {
  const P = Svc.prototype;

  // ---------- issue a personal goodwill code (Delivery / Order Issues agents) ----------
  P.issueGoodwillCoupon = async function ({ session_id, reference, reason = "", conversation_id = "", platform_session_id = "" }) {
    const ctx = await this.authorise(session_id, reference);
    if (ctx.err) return ctx.err;
    const o = ctx.b.order;
    if (!o) return { action: "ISSUE_GOODWILL_COUPON", outcome: "NOT_ELIGIBLE", reason_code: "NO_ORDER", customer_message: "I can only offer a goodwill code on an order in our system." };
    const key = "GWC-" + o.key;
    const existing = ctx.ledger.find((l) => l.key === key);
    if (existing) {
      const m = parse(existing.value.summary);
      return { action: "ISSUE_GOODWILL_COUPON", outcome: "ALREADY_ISSUED", duplicate_prevented: true, coupon_code: s(existing.value.ref), status: up(existing.value.status),
        issued_in_interaction: s(existing.value.evidence) || null, expires_at: s(existing.value.expires_at),
        customer_message: "You already have a goodwill code for this order: " + s(existing.value.ref) + " (" + rupees(GOODWILL.VALUE_PAISE) + " off your next order of " + rupees(m.min_subtotal_paise || GOODWILL.MIN_SUBTOTAL_PAISE) + " or more, valid until " + dateIst(existing.value.expires_at) + ")." };
    }
    const proof = ctx.ledger.filter((l) => s(l.value.order_id) === o.key && FAILURE_KINDS.has(up(l.value.kind)));
    if (!proof.length) return { action: "ISSUE_GOODWILL_COUPON", outcome: "NOT_ELIGIBLE", reason_code: "NO_SERVICE_FAILURE_ON_RECORD",
      customer_message: "I can only give a goodwill code when something went wrong with an order and we've put it right, and I don't see that on this order yet." };
    // Short, easy-to-say code ("treat four eight two"); unique across issued codes.
    const taken = new Set(ctx.ledger.filter((l) => up(l.value.kind) === "GOODWILL_COUPON").map((l) => up(l.value.ref)));
    const h = crypto.createHash("sha256").update(o.key + "|" + ctx.sess.customer_id).digest();
    let code = ""; for (let i = 0; i < 20 && (!code || taken.has(code)); i++) code = GOODWILL.PREFIX + String(100 + ((h.readUInt32BE(0) + i * 7919) % 900));
    const now = this.now(), exp = new Date(now + GOODWILL.VALID_DAYS * 86400000).toISOString();
    const iid = cleanId(conversation_id), psid = cleanId(platform_session_id);
    const terms = { code, value_paise: GOODWILL.VALUE_PAISE, min_subtotal_paise: GOODWILL.MIN_SUBTOTAL_PAISE, single_use: true, bound_to_customer: true,
      issued_for_order: o.key, issued_reason: s(reason).replace(/[^\w\s,.-]/g, "").slice(0, 80) || up(proof[0].value.kind), proof: proof.map((p) => p.key).slice(0, 5) };
    const w = await this.commitRow("ledger", key, { kind: "GOODWILL_COUPON", status: "ISSUED", ref: code, order_id: o.key, customer_id: ctx.sess.customer_id,
      amount_paise: String(GOODWILL.VALUE_PAISE), reason: terms.issued_reason, evidence: iid, customer_note: psid, session: ctx.sess.id,
      summary: JSON.stringify(terms), created_at: this.iso(), expires_at: exp });
    if (!w.verified) return { action: "ISSUE_GOODWILL_COUPON", outcome: "FAILED", step_failed: "SAVE_CODE", customer_message: "I tried to create a goodwill code but couldn't confirm it was saved, so I won't give you a code that might not work. Please ask me again in a moment." };
    this.log({ tool: "issue_goodwill_coupon", ref: o.key, result: "ISSUED", interaction: iid });
    return { action: "ISSUE_GOODWILL_COUPON", outcome: "ISSUED", coupon_code: code, value_paise: GOODWILL.VALUE_PAISE, min_subtotal_paise: GOODWILL.MIN_SUBTOTAL_PAISE, expires_at: exp,
      remembered: { interaction_id: iid || null, platform_session_id: psid || null, verification_session: ctx.sess.id, ledger_key: key }, verified_by_read_back: true,
      customer_message: "As an apology, here's a personal code for you: " + code + ". It takes " + rupees(GOODWILL.VALUE_PAISE) + " off your next order of " + rupees(GOODWILL.MIN_SUBTOTAL_PAISE) + " or more, once, until " + dateIst(exp) + ". It's linked to your account, so if it ever doesn't work, just tell us and we'll sort it out." };
  };

  // ---------- later conversation: "the code you gave me doesn't work" (Offers & Coupons agent) ----------
  // Finds the promise (by code, or the customer's latest code if they don't remember it), explains exactly why it
  // didn't apply, and when the customer is entitled, honours it on the order they name: discount + refund, verified.
  P.honourGoodwillCoupon = async function ({ session_id, reference, coupon_code = "", conversation_id = "", platform_session_id = "" }) {
    const ctx = await this.authorise(session_id, reference);
    if (ctx.err) return ctx.err;
    const o = ctx.b.order;
    const out = (outcome, reason_code, say, extra = {}) => ({ action: "HONOUR_GOODWILL_COUPON", outcome, reason_code, customer_message: say, ...extra });
    if (!o) return out("NOT_APPLIED", "NO_ORDER", "Which order did you try to use the code on? Please give me its order number.");
    const all = ctx.ledger.filter((l) => up(l.value.kind) === "GOODWILL_COUPON");
    const code = up(readCoupon(coupon_code)).replace(/[^A-Z0-9]/g, "");
    let row = code ? all.find((l) => up(l.value.ref) === code) : null;
    if (code && !row) return out("NOT_FOUND", "NOT_A_GOODWILL_CODE", "I can't find a code called " + code + " among the codes our team has given out. If it's a public offer code, I can check it as a normal coupon instead.", { fallback: "check_coupon" });
    if (row && s(row.value.customer_id) !== ctx.sess.customer_id) return out("NOT_APPLIED", "NOT_LINKED_TO_ACCOUNT", "That code isn't linked to the account you verified, so I can't apply it. Personal codes only work for the person they were given to.");
    if (!row) {
      const mine = all.filter((l) => s(l.value.customer_id) === ctx.sess.customer_id).sort((a, b) => s(b.value.created_at).localeCompare(s(a.value.created_at)));
      row = mine.find((l) => up(l.value.status) === "ISSUED") || mine[0];
      if (!row) return out("NOT_FOUND", "NO_GOODWILL_CODE_ON_ACCOUNT", "I don't see any goodwill code given to your account. Do you have the code itself? I can check it.");
    }
    const t = parse(row.value.summary), c = up(row.value.ref);
    const issued = { coupon_code: c, issued_at: s(row.value.created_at), issued_for_order: s(row.value.order_id), issued_reason: s(row.value.reason),
      issued_in_interaction: s(row.value.evidence) || null, issued_in_platform_session: s(row.value.customer_note) || null, expires_at: s(row.value.expires_at) };
    const when = "on " + dateIst(issued.issued_at) + " at " + ist(issued.issued_at) + ", after the problem with order " + issued.issued_for_order;
    if (up(row.value.status) === "REDEEMED") {
      const r = s(t.redeemed_on_order);
      return out(r === o.key ? "ALREADY_APPLIED" : "NOT_APPLIED", r === o.key ? "ALREADY_HONOURED_ON_THIS_ORDER" : "ALREADY_USED", r === o.key
        ? "Good news: " + c + " is already applied to order " + o.key + ", and the " + rupees(Number(row.value.amount_paise)) + " went back to your payment (transaction " + s(t.processor_ref) + ")."
        : "The code " + c + " we gave you " + when + " was already used on order " + r + ", and it's single-use, so it can't be used again.", { issued });
    }
    if (Date.parse(issued.expires_at) < this.now()) return out("NOT_APPLIED", "EXPIRED", "The code " + c + " we gave you " + when + " expired on " + dateIst(issued.expires_at) + ", so checkout rejected it.", { issued });
    if (o.key === issued.issued_for_order) return out("NOT_APPLIED", "SAME_ORDER", "The code " + c + " is for your next order, not the order it was given for. Which new order did you try it on?", { issued });
    const d = await this.domainBundle(ctx);
    if (!d.details) return out("NOT_APPLIED", "NO_ORDER_DETAILS", "I can't see the bill for order " + o.key + " right now, so I can't apply the code yet. Nothing has changed.", { issued });
    if (up(o.value.status) === "CANCELLED") return out("NOT_APPLIED", "ORDER_CANCELLED", "Order " + o.key + " was cancelled, so there's nothing to discount. Your code " + c + " is still valid for your next order.", { issued });
    const subtotal = Number(d.details.value.subtotal_paise) || Number(o.value.total_paise) || 0;
    const min = Number(t.min_subtotal_paise) || GOODWILL.MIN_SUBTOTAL_PAISE;
    if (subtotal < min) return out("NOT_APPLIED", "BELOW_MINIMUM", "The code " + c + " needs an order of " + rupees(min) + " or more, and order " + o.key + " came to " + rupees(subtotal) + ", so checkout couldn't apply it. It's still valid for a bigger order until " + dateIst(issued.expires_at) + ".", { issued });
    const other = up(d.details.value.coupon_code);
    if (other && other !== c && (Number(d.details.value.discount_paise) || 0) > 0) return out("NOT_APPLIED", "ANOTHER_COUPON_USED", "Order " + o.key + " already used the coupon " + other + ", and codes can't be combined, so " + c + " is still unused and valid for your next order.", { issued });
    if (d.refunds.some((r) => !["FAILED", "REJECTED"].includes(up(r.value.status)) && !s(r.key).startsWith("RF-GWC-"))) return out("NOT_APPLIED", "ORDER_ALREADY_REFUNDED", "Order " + o.key + " already has a refund on it, so I won't add a discount on top. Your code " + c + " is still valid for your next order.", { issued });
    // Entitled: the promise is on record, terms are met, checkout simply didn't apply it. Honour it now.
    const value = Number(row.value.amount_paise) || GOODWILL.VALUE_PAISE;
    const g = await this.gate(ctx, "COUPON", { amount_paise: value, evidence: "PROOF" });
    if (g) return g;
    const pay = ctx.b.payments.find((p) => ["CAPTURED", "SETTLED"].includes(up(p.value.status)));
    const bill = await this.patchRow("details", o.key, { coupon_code: c, discount_paise: String((Number(d.details.value.discount_paise) || 0) + value), remedy_status: "GOODWILL_HONOURED:" + c });
    if (!bill.verified) return out("FAILED", "UPDATE_BILL_FAILED", "I couldn't update the bill for order " + o.key + ", so I haven't changed anything. Asking again is safe.", { issued });
    const rk = "RF-GWC-" + o.key;
    const rf = await this.commitRow("refunds", rk, { order_id: o.key, payment_id: pay ? pay.key : "", status: "SETTLED", amount_paise: String(value), at: this.iso(),
      processor_ref: "SBXTXN-" + crypto.createHash("sha256").update(rk).digest("hex").slice(0, 10).toUpperCase() });
    if (!rf.verified) return out("PARTIAL", "REFUND_UNCONFIRMED", "I've applied " + c + " to order " + o.key + ", but I couldn't confirm the " + rupees(value) + " refund yet, so I won't say it's done. Asking again is safe.", { issued, recovery: "Call honour_goodwill_coupon again; it is idempotent." });
    const iid = cleanId(conversation_id), psid = cleanId(platform_session_id);
    const redeemed = { ...t, redeemed_on_order: o.key, redeemed_at: this.iso(), redeemed_in_interaction: iid, redeemed_in_platform_session: psid, refund_id: rk, processor_ref: s(rf.row.value.processor_ref) };
    await this.patchRow("ledger", row.key, { status: "REDEEMED", summary: JSON.stringify(redeemed).slice(0, 900) }).catch(() => {});
    await this.audit("EXEC-GWC-" + o.key, { kind: "EXECUTED_GOODWILL_HONOURED", status: "SETTLED", ref: c, order_id: o.key, customer_id: ctx.sess.customer_id, amount_paise: String(value),
      reason: "issued in " + (issued.issued_in_interaction || "unknown interaction") + " for " + issued.issued_for_order, evidence: iid, session: ctx.sess.id });
    this.log({ tool: "honour_goodwill_coupon", ref: o.key, result: "HONOURED", issued_in: issued.issued_in_interaction, now_in: iid });
    return out("APPLIED", "HONOURED_FROM_EARLIER_CONVERSATION", "I found it: we gave you " + c + " " + when + ". Checkout didn't apply it to order " + o.key + ", so I've applied it now: " + rupees(value) + " off, refunded to your payment (transaction " + s(rf.row.value.processor_ref) + "). The code is now used.",
      { issued, now: { interaction_id: iid || null, platform_session_id: psid || null }, refund_id: rk, refund_paise: value, processor_ref: s(rf.row.value.processor_ref), verified_by_read_back: true });
  };
}
