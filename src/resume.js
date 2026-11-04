// PizzaResolve conversation resume (Team CodeVerse).
// A customer who closed a conversation can come back in a NEW conversation (new Talkdesk interaction) and continue:
// order/CASE reference + ONE detail (postcode, phone last 4, or the caller's number on voice) re-opens a session,
// provided the same customer was fully verified in the last RESUME_WINDOW_DAYS. The reply carries the history so the
// agent can say "welcome back, last time we..." instead of starting from scratch. Lockout and money gates unchanged.
import crypto from "node:crypto";
import { s, rupees, ist, countRecentFailures, POLICY } from "./engine.js";
import { normaliseRef } from "./service.js";
import { readPhoneLast4, readPostcode } from "./spoken.js";

const up = (v) => s(v).toUpperCase();
const t = (v) => { const ms = Date.parse(s(v)); return Number.isFinite(ms) ? ms : NaN; };
const cleanId = (v) => (/^[A-Za-z0-9-]{6,80}$/.test(s(v)) ? s(v) : "");
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const newSid = () => "VS-" + [...crypto.randomBytes(10)].map((b) => B32[b % 32]).join("").slice(0, 10);
const when = (iso) => { const d = new Date(s(iso)); return Number.isFinite(d.getTime()) ? new Date(d.getTime() + 330 * 60000).toISOString().slice(0, 10) + " " + ist(iso) : s(iso); };
export const RESUME = Object.freeze({ WINDOW_DAYS: 7, MAX_ITEMS: 6 });

// One plain sentence per remembered fact, newest first.
function describe(row, refundsById) {
  const v = row.value, k = up(v.kind), o = s(v.order_id), amt = Number(v.amount_paise) || 0;
  const meta = (() => { try { return JSON.parse(s(v.summary)) || {}; } catch { return {}; } })();
  switch (k) {
    case "GOODWILL_COUPON": return up(v.status) === "REDEEMED"
      ? "apology code " + s(v.ref) + " (given after the problem with " + o + ") was used on " + s(meta.redeemed_on_order)
      : "apology code " + s(v.ref) + " was given after the problem with " + o + ", Rs " + (amt / 100) + " off, not used yet, valid until " + s(v.expires_at).slice(0, 10);
    case "EXECUTED_GOODWILL_HONOURED": return "code " + s(v.ref) + " was applied to " + o + " and " + rupees(amt) + " refunded";
    case "EXECUTED_REFUND": return rupees(amt) + " was refunded for " + o + (s(v.reason) ? " (transaction " + s(v.reason) + ")" : "");
    case "EXECUTED_REPLACEMENT": {
      const m = /ordered (.*?); packed (.*)$/.exec(s(v.summary)) || [];
      return "a free replacement pizza" + (m[1] ? " (" + m[1].replace(/^\[|\]$/g, "") + ")" : "") + " was sent as order " + s(v.reason) + " for " + o + (m[2] ? ", because " + m[2].replace(/^\[|\]$/g, "") + " was packed instead" : "");
    }
    case "EXECUTED_REDELIVERY": return "a priority redelivery was booked for " + o;
    case "EXECUTED_COUPON_CORRECTION": return "the coupon on " + o + " was corrected and " + rupees(amt) + " refunded";
    case "REFUND_REQUEST": return "a refund request of " + rupees(amt) + " for " + o + " is " + s(v.status).toLowerCase().replace(/_/g, " ");
    case "DELIVERY_INVESTIGATION": return "a delivery investigation for " + o + " is " + s(v.status).toLowerCase();
    case "ORDER_ISSUE": return "your complaint about " + s(v.reason).toLowerCase().replace(/_/g, " ") + " on " + o + " was checked (" + s(v.decision).toLowerCase().replace(/_/g, " ") + ")";
    case "ESCALATION": return "your case on " + o + " was sent to our team (" + s(v.status).toLowerCase().replace(/_/g, " ") + ")";
    case "ADDRESS_CHANGE": return "the delivery address of " + o + " was " + (up(v.status) === "APPLIED" ? "changed" : "asked to be changed");
    case "CASE": {
      const st = up(v.status);
      if (st === "AWAITING_HUMAN_REVIEW") return "case " + row.key + ": a " + rupees(amt) + " " + s(v.reason).toLowerCase() + " is waiting for a team member's approval";
      if (st === "RESOLVED") return "case " + row.key + " is resolved" + (meta.last_decision && meta.last_decision.message ? ": " + s(meta.last_decision.message).slice(0, 140) : "");
      if (st === "REJECTED") return "case " + row.key + ": a team member decided against the proposed fix";
      return null;
    }
    case "APPROVAL": return "a team member (" + s(v.decision) + ") approved the " + s(v.reason).toLowerCase() + " for " + s(v.ref);
    case "PROMO_ADJUSTMENT_REQUEST": return "a discount correction of " + rupees(amt) + " for " + o + " was requested";
    case "CANCELLATION_REQUEST": return "a cancellation was requested for " + o;
    default: return null;
  }
}

export function installResume(Svc) {
  const P = Svc.prototype;
  // The first tool reply in a resumed conversation opens with "Yes, I remember, we spoke at <time>..." (once).
  Object.defineProperty(P, "resumeGreetings", { get() { if (!this._rg) this._rg = new Map(); return this._rg; } });
  P.takeResumeGreeting = function (sessionId) {
    const k = String(sessionId || "").trim().toUpperCase(); const g = this.resumeGreetings.get(k);
    if (g) this.resumeGreetings.delete(k); return g || "";
  };

  P.resumeConversation = async function ({ reference = "", postcode = "", phone_last4 = "", caller_id = "", conversation_id = "", platform_session_id = "" }) {
    const out = (resumed, reason_code, say, extra = {}) => ({ action: "RESUME_CONVERSATION", resumed, reason_code, customer_message: say, ...extra });
    const ref = normaliseRef(reference);
    if (!ref) return out(false, "NEED_REFERENCE", "Welcome back! Which order is this about? Just tell me the order number or your case reference.");
    const now = this.now();
    let ledger, b, customers, orders, refunds;
    try { [ledger, b, customers, orders, refunds] = await Promise.all([this.store.list("ledger"), this.bundle(ref), this.store.list("customers"), this.store.list("orders"), this.store.list("refunds").catch(() => [])]); }
    catch { return out(false, "SYSTEM_UNAVAILABLE", "I can't reach our order systems right now, so I can't pick up your earlier conversation. Nothing has been changed. Please try again shortly."); }
    if (countRecentFailures(ledger, ref, now) >= POLICY.MAX_FAILED_VERIFICATIONS) return out(false, "TOO_MANY_ATTEMPTS", "For security, I can't check this order any further right now. Please try again later or contact us from the phone number on the account.");
    const cid = cleanId(conversation_id), psid = cleanId(platform_session_id);
    if (cid && ledger.some((l) => l.key === "DENY-" + cid)) return out(false, "THIRD_PARTY_LOCK", "Earlier in this conversation this order was described as belonging to someone else, so I can't continue it here.");
    const customer = b && b.customerIds.length === 1 ? customers.find((c) => c.key === b.customerIds[0]) : null;
    // Only a customer who was fully verified recently can resume with one detail; otherwise normal verification.
    const since = now - RESUME.WINDOW_DAYS * 86400000;
    const priorSessions = customer ? ledger.filter((l) => up(l.value.kind) === "SESSION" && s(l.value.customer_id) === customer.key && t(l.value.created_at) >= since).sort((a, c) => s(c.value.created_at).localeCompare(s(a.value.created_at))) : [];
    if (!customer || !priorSessions.length) return out(false, "NEED_FULL_VERIFICATION", "I couldn't find a recent conversation to pick up for this order, so let's verify you quickly: the last 4 digits of the phone on the account and the delivery postcode.", { next_step_for_ai: "Use verify_customer with the reference, phone last 4 and postcode." });
    // Factors: postcode, phone last 4, or the platform caller id (voice). At least one must match, none may be wrong.
    const cv = customer.value;
    const pc = postcode ? readPostcode(postcode).replace(/\s/g, "") : "";
    const p4 = phone_last4 ? readPhoneLast4(phone_last4) : "";
    const callerDigits = s(caller_id).replace(/\D/g, "");
    const factors = [];
    if (pc) factors.push({ name: "postcode", ok: pc === s(cv.postcode).replace(/\s/g, "") });
    if (p4) factors.push({ name: "phone_last4", ok: p4 === s(cv.phone_last4) });
    if (callerDigits.length >= 7 && callerDigits.slice(-4) === s(cv.phone_last4)) factors.push({ name: "caller_id", ok: true });
    if (!factors.length) return out(false, "NEED_ONE_DETAIL", "Welcome back! To pick up where we left off, just confirm your delivery postcode.", { next_step_for_ai: "Ask only for the postcode (or phone last 4), then call resume_conversation again." });
    if (factors.some((f) => !f.ok && f.name !== "caller_id") || up(cv.status) !== "ACTIVE") {
      try { await this.store.create("ledger", "ATT-" + ref + "-" + now + "-" + crypto.randomBytes(2).toString("hex").toUpperCase(), { kind: "VERIFY_ATTEMPT", ref, status: "FAILED", reason: "RESUME_DETAILS_WRONG", session: cid, created_at: this.iso() }); } catch { /* best effort */ }
      const left = POLICY.MAX_FAILED_VERIFICATIONS - countRecentFailures(ledger, ref, now) - 1;
      return out(false, left <= 0 ? "TOO_MANY_ATTEMPTS" : "DETAILS_NOT_VERIFIED", left <= 0 ? "For security, I can't check this order any further right now. Please try again later or contact us from the phone number on the account." : "That detail doesn't match what we have, so I can't continue the earlier conversation. Could you check it and try again?");
    }
    // New session for this conversation, linked to the earlier ones.
    const sid = newSid(), exp = new Date(now + POLICY.SESSION_TTL_MIN * 60000).toISOString();
    try {
      const r = await this.store.create("ledger", sid, { kind: "SESSION", ref, customer_id: customer.key, status: "ACTIVE", reason: "RESUMED", decision: factors.filter((f) => f.ok).map((f) => f.name).join("+"),
        evidence: cid, customer_note: psid, summary: JSON.stringify({ resumed_from: priorSessions.slice(0, 3).map((x) => x.key) }).slice(0, 300), created_at: this.iso(), expires_at: exp });
      if (r.status !== "CREATED") throw new Error("collision");
    } catch { return out(false, "SESSION_NOT_CREATED", "I found your earlier conversation but couldn't open a secure session. Please try again in a moment."); }
    // What we remember, across all of this customer's orders.
    const mine = new Set(orders.filter((o) => s(o.value.customer_id) === customer.key).map((o) => o.key));
    const facts = ledger.filter((l) => (mine.has(s(l.value.order_id)) || s(l.value.customer_id) === customer.key) && t(l.value.created_at) >= since)
      .sort((a, c) => s(c.value.created_at).localeCompare(s(a.value.created_at)))
      .map((l) => ({ at: s(l.value.created_at), order_id: s(l.value.order_id) || null, kind: up(l.value.kind), text: describe(l) }))
      .filter((f) => f.text);
    const seen = new Set(); const items = facts.filter((f) => !seen.has(f.text) && seen.add(f.text)).slice(0, RESUME.MAX_ITEMS);
    const prevInteractions = [...new Set([...priorSessions.map((x) => s(x.value.evidence)), ...ledger.filter((l) => up(l.value.kind) === "GOODWILL_COUPON" && s(l.value.customer_id) === customer.key).map((l) => s(l.value.evidence))].filter(Boolean))].slice(0, 5);
    // The last conversation: the most recent earlier session that has something on record, and what happened in it.
    const bySession = (sidKey) => ledger.filter((l) => s(l.value.session) === sidKey && l.key !== sidKey).map((l) => describe(l)).filter(Boolean);
    // Prefer the last conversation about the order the customer names; fall back to the latest one on the account.
    const aboutRef = (x) => s(x.value.ref) === ref || ledger.some((l) => s(l.value.session) === x.key && s(l.value.order_id) === ref);
    const pool = priorSessions.filter(aboutRef).length ? priorSessions.filter(aboutRef) : priorSessions;
    const refItems = [...new Set(facts.filter((f) => f.order_id === ref).map((f) => f.text))];
    const lastConv = { x: pool[0], did: [...new Set([...bySession(pool[0].key), ...refItems])] };
    const lcAt = s(lastConv.x.value.created_at), lcRef = s(lastConv.x.value.ref);
    const dayIst = (ms) => new Date(ms + 330 * 60000).toISOString().slice(0, 10);
    const dayWord = dayIst(t(lcAt)) === dayIst(now) ? "today" : dayIst(t(lcAt)) === dayIst(now - 86400000) ? "yesterday" : "on " + dayIst(t(lcAt));
    const clock12 = (iso) => { const d = new Date(t(iso) + 330 * 60000); let h = d.getUTCHours(); const m = String(d.getUTCMinutes()).padStart(2, "0"); const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12; return h + ":" + m + " " + ap; };
    const spokeAt = dayWord + " at " + clock12(lcAt) + " (IST)";
    const previous_conversation = { at: lcAt, at_ist: spokeAt, we_spoke_at: spokeAt, order: lcRef, interaction_id: s(lastConv.x.value.evidence) || null, discussed: lastConv.did.slice(0, 4) };
    const others = items.filter((i) => !lastConv.did.includes(i.text)).slice(0, 2);
    const last = items[0] ? items[0].at : lcAt;
    this.log({ tool: "resume_conversation", ref, result: "RESUMED", session: sid, previous: prevInteractions.length });
    const remember = "Yes, I spoke to you " + spokeAt + " about order " + lcRef + ".";
    this.resumeGreetings.set(sid, remember);
    const say = "Welcome back " + s(cv.first_name) + "! " + remember.slice(0, -1) +
      (lastConv.did.length ? ": " + lastConv.did.slice(0, 3).join("; ") + "." : ".") +
      (others.length ? " Also on your account: " + others.map((i) => i.text).join("; ") + "." : "") + " What would you like to follow up on?";
    const pick = (re) => [...new Set(facts.filter((f) => re.test(f.kind)).map((f) => f.text))].slice(0, 5);
    const sessAt = new Map(priorSessions.map((x) => [x.key, x]));
    const conversations = priorSessions.slice(0, 5).map((x) => ({ at: s(x.value.created_at), at_ist: when(x.value.created_at), order: s(x.value.ref), interaction_id: s(x.value.evidence) || null,
      what_happened: [...new Set(bySession(x.key))] })).filter((c) => c.what_happened.length || c.order === ref);
    const customer_summary = {
      customer_id: customer.key, first_name: s(cv.first_name),
      issues_resolved: pick(/^EXECUTED_|^CASE$/), coupon_codes: pick(/^GOODWILL_COUPON$|^EXECUTED_GOODWILL_HONOURED$|^EXECUTED_COUPON_CORRECTION$/),
      replacements: pick(/^EXECUTED_REPLACEMENT$/), refunds: pick(/^EXECUTED_REFUND$|^REFUND_REQUEST$|^EXECUTED_GOODWILL_HONOURED$/),
      open_items: [...new Set(facts.filter((f) => /waiting for a team member|is open|is requested|not used yet/.test(f.text)).map((f) => f.text))].slice(0, 4) };
    void sessAt;
    return out(true, "RESUMED", say, {
      verified: true, session_id: sid, reference: ref, expires_at: exp,
      verification_level: "RETURNING_CUSTOMER (reference + " + factors.filter((f) => f.ok).map((f) => f.name).join(" + ") + "; fully verified in an earlier conversation within " + RESUME.WINDOW_DAYS + " days)",
      previous_conversation, conversations, customer_summary,
      previous_context: { customer_summary, conversations, last_contact: last, previous_interactions: prevInteractions, previous_conversations: priorSessions.slice(0, 3).map((x) => ({ at: s(x.value.created_at), order: s(x.value.ref), interaction_id: s(x.value.evidence) || null })), items },
      reply_rule: "Start your reply with: '" + remember + "' and then what was done, in the customer's language.",
      next_step_for_ai: "The customer is verified for this conversation: use ONLY this session_id (" + sid + ") for every tool; older sessions have expired. Do not ask them to repeat the problem; use previous_context." });
  };
}
