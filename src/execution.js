// PizzaResolve business execution layer (Team CodeVerse).
// Each operation: authorise -> policy check -> idempotent state change in the sandbox system of record
// (Talkdesk Data Tables: PZ_Refunds / PZ_Orders / PZ_Fulfilment_Events / PZ_Order_Details) -> fresh read-back
// -> audit row. "Sandbox" = the synthetic processor/fulfilment system for this demo; no real bank or courier is touched.
import crypto from "node:crypto";
import { s, rupees } from "./engine.js";
import { analyseCoupon } from "./domains.js";
import { TRUSTED } from "./collab.js";

const up = (v) => s(v).toUpperCase();
const sbxRef = (prefix, seed) => prefix + "-" + crypto.createHash("sha256").update(seed).digest("hex").slice(0, 10).toUpperCase();
const norm = (x) => up(x).replace(/[^A-Z0-9]/g, "");
const ok = (o) => o === "CREATED" || o === "CONFIRMED_AFTER_TIMEOUT";

export function installExecution(Svc) {
  const P = Svc.prototype;

  // Create a row once (409 => already exists), then re-read it. Never reports success without the read-back.
  P.commitRow = async function (table, key, value) {
    let outcome = "UNKNOWN";
    try { const r = await this.store.create(table, key, value); outcome = r.status === "CREATED" ? "CREATED" : "ALREADY_EXISTS"; }
    catch { outcome = "UNKNOWN"; }
    let row = null; try { row = await this.store.getByKey(table, key); } catch { /* read failed */ }
    if (outcome === "UNKNOWN" && row) outcome = "CONFIRMED_AFTER_TIMEOUT";
    return { outcome, row, verified: !!row };
  };
  // Full-row update with read-back verification of the fields we changed.
  P.patchRow = async function (table, key, patch) {
    const cur = await this.store.getByKey(table, key);
    if (!cur) return { verified: false, reason: "ROW_NOT_FOUND" };
    try { await this.store.update(table, key, { ...cur.value, ...patch }); } catch { /* verify below */ }
    const after = await this.store.getByKey(table, key);
    const verified = !!after && Object.entries(patch).every(([k, v]) => s(after.value[k]) === s(v));
    return { verified, before: cur.value, after: after && after.value };
  };
  P.audit = async function (key, value) {
    try { await this.store.create("ledger", key, { created_at: this.iso(), ...value }); } catch { /* audit is best effort */ }
  };

  // ---------- Refund agent: execute a sandbox refund (not just a request) ----------
  P.executeRefund = async function ({ _ctx, session_id, reference, payment_id = "" }) {
    const ctx = _ctx && TRUSTED.has(_ctx) ? _ctx : await this.authorise(session_id, reference);
    if (ctx.err) return ctx.err;
    const r = await this.evaluate(ctx, []);
    const allowed = r.authorized_actions.filter((a) => a.action === "REQUEST_REFUND");
    let pid = up(payment_id) || (allowed[0] && allowed[0].payment_id) || "";
    // A refund already approved by policy earlier (REFREQ-<pid>) can be executed now.
    const prior = ctx.ledger.find((l) => up(l.value.kind) === "REFUND_REQUEST" && (!pid || up(l.value.payment_id) === pid) && ctx.b.refs.includes(up(l.value.payment_id)));
    if (!pid && prior) pid = up(prior.value.payment_id);
    const act = allowed.find((a) => a.payment_id === pid);
    const amount = act ? Number(act.amount_paise) : prior ? Number(prior.value.amount_paise) : 0;
    if (!amount) {
      const done = (await this.store.list("refunds")).find((x) => ctx.b.refs.includes(up(x.value.payment_id)) && (!pid || up(x.value.payment_id) === pid) && !["FAILED", "REJECTED"].includes(up(x.value.status)));
      if (done) return { action: "EXECUTE_REFUND", outcome: "ALREADY_REFUNDED", duplicate_prevented: true, refund_id: done.key, status: up(done.value.status), amount_paise: Number(done.value.amount_paise), processor_ref: s(done.value.processor_ref),
        customer_message: "This payment has already been refunded: " + rupees(Number(done.value.amount_paise)) + ", refund " + done.key + " (status " + up(done.value.status).toLowerCase() + "). I haven't refunded it twice." };
    }
    if (!pid || !amount) return { action: "EXECUTE_REFUND", outcome: "NOT_AUTHORIZED", reason_code: "POLICY_DOES_NOT_ALLOW_REFUND", money_moved: false,
      customer_message: "Based on the payment and order records, a refund isn't allowed for this right now, so I haven't refunded anything. " + s(r.customer_message).split(" I can")[0] };
    // Duplicate protection: any non-failed refund for this payment already in the processor table.
    const refunds = (await this.store.list("refunds")).filter((x) => up(x.value.payment_id) === pid && !["FAILED", "REJECTED"].includes(up(x.value.status)));
    if (refunds.length) {
      const x = refunds[0];
      return { action: "EXECUTE_REFUND", outcome: "ALREADY_REFUNDED", duplicate_prevented: true, refund_id: x.key, status: up(x.value.status), amount_paise: Number(x.value.amount_paise), processor_ref: s(x.value.processor_ref),
        customer_message: "This payment has already been refunded: " + rupees(Number(x.value.amount_paise)) + ", refund " + x.key + " (status " + up(x.value.status).toLowerCase() + "). I haven't refunded it twice." };
    }
    const g = await this.gate(ctx, "REFUND", { amount_paise: amount, payment_id: pid, evidence: "PROOF" });
    if (g) return g;
    const key = "RF-SBX-" + pid;
    const txn = sbxRef("SBXTXN", key);
    const w = await this.commitRow("refunds", key, { order_id: ctx.b.order ? ctx.b.order.key : "", payment_id: pid, status: "SETTLED", amount_paise: String(amount), at: this.iso(), processor_ref: txn });
    const settled = w.verified && up(w.row.value.status) === "SETTLED" && up(w.row.value.payment_id) === pid;
    this.log({ tool: "execute_refund", ref: ctx.ref, key, outcome: w.outcome, settled });
    if (!settled) return { action: "EXECUTE_REFUND", outcome: "UNKNOWN", money_moved: "UNCONFIRMED",
      customer_message: "I sent the refund to the payment system but couldn't confirm it went through, so I won't say it did. Asking me again is safe and won't refund you twice." };
    if (prior) { try { await this.patchRow("ledger", prior.key, { status: "SETTLED" }); } catch { /* advisory */ } }
    await this.audit("EXEC-REFUND-" + pid, { kind: "EXECUTED_REFUND", status: "SETTLED", ref: ctx.ref, order_id: ctx.b.order ? ctx.b.order.key : "", payment_id: pid, customer_id: ctx.sess.customer_id, amount_paise: String(amount), reason: txn, session: ctx.sess.id });
    return { action: "EXECUTE_REFUND", outcome: w.outcome === "ALREADY_EXISTS" ? "ALREADY_REFUNDED" : "REFUNDED", refund_id: key, processor_ref: txn, amount_paise: amount, status: "SETTLED", money_moved: "SANDBOX_PROCESSOR", verified_by_read_back: true,
      customer_message: "Done. I've refunded " + rupees(amount) + " for payment " + pid + ". The refund is confirmed in our payment system (transaction " + txn + "). Your bank usually shows it within 5 to 7 working days." };
  };

  // ---------- Order Issues agent: create a linked replacement order + kitchen task ----------
  P.createReplacementOrder = async function ({ _ctx, session_id, reference }) {
    const ctx = _ctx && TRUSTED.has(_ctx) ? _ctx : await this.authorise(session_id, reference);
    if (ctx.err) return ctx.err;
    const o = ctx.b.order;
    if (!o) return { action: "CREATE_REPLACEMENT", outcome: "NOT_AUTHORIZED", reason_code: "NO_ORDER", customer_message: "There's no order for this reference, so there's nothing to replace." };
    const d = (await this.store.list("details")).find((x) => x.key === o.key);
    const ordered = d ? s(d.value.ordered_items || d.value.line_items) : s(o.value.items), packed = d ? s(d.value.packed_items) : "";
    if (up((d && d.value.stage) || o.value.status) !== "DELIVERED") return { action: "CREATE_REPLACEMENT", outcome: "NOT_ELIGIBLE", reason_code: "NOT_DELIVERED_YET", customer_message: "This order hasn't been delivered yet, so a replacement isn't needed. Let me know once it arrives if anything is wrong." };
    const proven = !!packed && norm(ordered) !== norm(packed);
    const newKey = o.key + "R";
    const rs = up(d ? d.value.remedy_status : "");
    if (rs && rs !== "NONE" && !rs.includes(newKey)) return { action: "CREATE_REPLACEMENT", outcome: "ALREADY_REMEDIED", duplicate_prevented: true, reason_code: "OTHER_REMEDY_ON_FILE", customer_message: "A remedy is already on file for this order (" + rs.toLowerCase() + "), so I won't add a second one." };
    // No proof in the kitchen record => exceptional replacement: AI prepares it, a human must approve (server-enforced).
    const g = await this.gate(ctx, "REPLACEMENT", { amount_paise: 0, evidence: proven ? "PROOF" : "CLAIM_ONLY" });
    if (g) return g;
    const now = this.now(), eta = new Date(now + 35 * 60000).toISOString();
    // Step 1: replacement order (no charge), linked by key suffix and checkout id.
    const w1 = await this.commitRow("orders", newKey, { customer_id: s(o.value.customer_id), checkout_id: s(o.value.checkout_id), status: "PREPARING", total_paise: "0", items: ordered, placed_at: new Date(now).toISOString(), promised_at: eta, version: "1" });
    if (!w1.verified) return { action: "CREATE_REPLACEMENT", outcome: "FAILED", step_failed: "CREATE_ORDER", customer_message: "I couldn't create the replacement order in the restaurant system, so nothing has been changed. Please try again; it's safe to retry." };
    // Step 2: order details for the replacement.
    const w2 = await this.commitRow("details", newKey, { customer_id: s(o.value.customer_id), ordered_items: ordered, packed_items: "", address_line: d ? s(d.value.address_line) : "", postcode: d ? s(d.value.postcode) : "", stage: "PREPARING", coupon_code: "", subtotal_paise: "0", discount_paise: "0", address_version: "1", remedy_status: "REPLACEMENT_FOR:" + o.key });
    // Step 3: kitchen fulfilment task (dependent on step 1). One retry, then report partial state truthfully.
    let w3 = await this.commitRow("events", "EVT-" + newKey + "-1", { order_id: newKey, source: "KITCHEN", event: "ACCEPTED", at: new Date(now).toISOString(), detail: "Free replacement for " + o.key + " (wrong item)", courier_id: "", distance_m: "" });
    if (!w3.verified) w3 = await this.commitRow("events", "EVT-" + newKey + "-1", { order_id: newKey, source: "KITCHEN", event: "ACCEPTED", at: new Date(now).toISOString(), detail: "Free replacement for " + o.key + " (wrong item)", courier_id: "", distance_m: "" });
    const link = d ? await this.patchRow("details", o.key, { remedy_status: "REPLACED:" + newKey }) : { verified: false };
    this.log({ tool: "create_replacement_order", ref: ctx.ref, newKey, order: w1.outcome, task: w3.outcome });
    await this.audit("EXEC-REPL-" + o.key, { kind: "EXECUTED_REPLACEMENT", status: w3.verified ? "KITCHEN_ACCEPTED" : "PARTIAL_NO_KITCHEN_TASK", ref: ctx.ref, order_id: o.key, customer_id: ctx.sess.customer_id, amount_paise: "0", reason: newKey, summary: "ordered " + ordered + "; packed " + packed, session: ctx.sess.id });
    if (!w3.verified) return { action: "CREATE_REPLACEMENT", outcome: "PARTIAL", replacement_order: newKey, kitchen_task: "NOT_CONFIRMED", recovery: "Call create_replacement_order again; it resumes from the missing step without creating a second order.",
      customer_message: "I've created your free replacement order " + newKey + ", but the kitchen hasn't confirmed it yet. I'm not going to say it's being made until it is; ask me again in a moment and I'll finish it." };
    return { action: "CREATE_REPLACEMENT", outcome: w1.outcome === "ALREADY_EXISTS" ? "ALREADY_CREATED" : "CREATED", replacement_order: newKey, linked_to: o.key, kitchen_task: "EVT-" + newKey + "-1", status: "PREPARING", eta, charge_paise: 0,
      original_linked: link.verified, details_created: w2.verified, verified_by_read_back: true,
      customer_message: (w1.outcome === "ALREADY_EXISTS" ? "Your free replacement is already on its way: " : "Sorry about that. I've placed a free replacement: ") + ordered + ", order " + newKey + ". The kitchen has accepted it and it should reach you by about " + eta.slice(11, 16) + " UTC. You won't be charged." };
  };

  // ---------- Delivery agent: priority redelivery task + new ETA ----------
  P.createRedeliveryTask = async function ({ _ctx, session_id, reference }) {
    const ctx = _ctx && TRUSTED.has(_ctx) ? _ctx : await this.authorise(session_id, reference);
    if (ctx.err) return ctx.err;
    const o = ctx.b.order;
    if (!o) return { action: "CREATE_REDELIVERY", outcome: "NOT_AUTHORIZED", reason_code: "NO_ORDER", customer_message: "There's no order for this reference, so there's no delivery to fix." };
    const st = up(o.value.status);
    if (["DELIVERED", "CANCELLED"].includes(st)) return { action: "CREATE_REDELIVERY", outcome: "NOT_ELIGIBLE", reason_code: "ORDER_" + st, customer_message: "This order is marked " + st.toLowerCase() + ", so I can't send it out again automatically." };
    const late = (this.now() - Date.parse(o.value.promised_at)) / 60000;
    if (!(late > 15)) return { action: "CREATE_REDELIVERY", outcome: "NOT_ELIGIBLE", reason_code: "NOT_LATE_YET", customer_message: "Your order is still within its delivery time, so it's on track. I'll be able to step in if it runs more than 15 minutes late." };
    const g = await this.gate(ctx, "REDELIVERY", { amount_paise: 0, evidence: "PROOF" });
    if (g) return g;
    const key = "EVT-" + o.key + "-REDISPATCH";
    const eta = new Date(this.now() + 30 * 60000).toISOString();
    const w = await this.commitRow("events", key, { order_id: o.key, source: "DISPATCH", event: "REDELIVERY_ASSIGNED", at: this.iso(), detail: "Priority redelivery from store, new ETA " + eta, courier_id: "RID-SBX-PRIORITY", distance_m: "" });
    if (!w.verified) return { action: "CREATE_REDELIVERY", outcome: "FAILED", customer_message: "I couldn't book a new delivery in the dispatch system just now, so nothing has changed. Please try again; it won't book twice." };
    const existed = w.outcome === "ALREADY_EXISTS";
    const p = existed ? { verified: true } : await this.patchRow("orders", o.key, { promised_at: eta, version: String((Number(o.value.version) || 1) + 1) });
    const etaShown = existed ? s((w.row.value.detail.match(/ETA (\S+)/) || [])[1]) : eta;
    await this.audit("EXEC-REDELIVERY-" + o.key, { kind: "EXECUTED_REDELIVERY", status: p.verified ? "ASSIGNED" : "PARTIAL_ETA_NOT_UPDATED", ref: ctx.ref, order_id: o.key, customer_id: ctx.sess.customer_id, amount_paise: "0", reason: key, session: ctx.sess.id });
    return { action: "CREATE_REDELIVERY", outcome: existed ? "ALREADY_ASSIGNED" : "ASSIGNED", task: key, courier: "RID-SBX-PRIORITY", new_eta: etaShown, order_eta_updated: p.verified, delivered: false,
      customer_message: (existed ? "A priority delivery is already booked for your order" : "I'm really sorry for the wait. I've booked a priority delivery for your order") + ", with a new arrival time around " + etaShown.slice(11, 16) + " UTC. It isn't delivered yet; I'll only call it delivered once the courier confirms." };
  };

  // ---------- Coupon agent: apply the correct discount and refund the difference ----------
  P.applyCouponCorrection = async function ({ _ctx, session_id, reference, coupon_code = "" }) {
    const ctx = _ctx && TRUSTED.has(_ctx) ? _ctx : await this.authorise(session_id, reference);
    if (ctx.err) return ctx.err;
    const [d, promotions, orders] = await Promise.all([this.domainBundle(ctx), this.store.list("promotions"), this.store.list("orders")]);
    const r = analyseCoupon({ order: ctx.b.order, details: d.details, promotions, code: coupon_code, customerOrders: orders.filter((o) => s(o.value.customer_id) === ctx.sess.customer_id), ledger: d.related, refunds: d.refunds });
    const act = r.authorized_actions.find((a) => a.action === "REQUEST_PROMO_ADJUSTMENT");
    if (!act) return { action: "APPLY_COUPON_CORRECTION", outcome: "NOT_APPLIED", decision: r.decision, reason_code: r.reason_code, money_moved: false, customer_message: r.customer_message };
    const o = ctx.b.order, pay = ctx.b.payments.find((p) => ["CAPTURED", "SETTLED"].includes(up(p.value.status)));
    const expected = Number(r.bill.discount_expected_paise);
    const g = await this.gate(ctx, "COUPON", { amount_paise: Number(act.amount_paise), evidence: "PROOF" });
    if (g) return g;
    const upd = await this.patchRow("details", o.key, { discount_paise: String(expected), remedy_status: "COUPON_CORRECTED:" + act.coupon });
    if (!upd.verified) return { action: "APPLY_COUPON_CORRECTION", outcome: "FAILED", step_failed: "UPDATE_BILL", money_moved: false, customer_message: "I couldn't update the bill in the order system, so I haven't changed anything. Please try again." };
    const key = "RF-CPN-" + o.key;
    const w = await this.commitRow("refunds", key, { order_id: o.key, payment_id: pay ? pay.key : "", status: "SETTLED", amount_paise: String(act.amount_paise), at: this.iso(), processor_ref: sbxRef("SBXTXN", key) });
    await this.audit("EXEC-COUPON-" + o.key, { kind: "EXECUTED_COUPON_CORRECTION", status: w.verified ? "SETTLED" : "BILL_FIXED_REFUND_UNCONFIRMED", ref: ctx.ref, order_id: o.key, customer_id: ctx.sess.customer_id, amount_paise: String(act.amount_paise), reason: act.coupon, session: ctx.sess.id });
    if (!w.verified) return { action: "APPLY_COUPON_CORRECTION", outcome: "PARTIAL", bill_corrected: true, refund: "NOT_CONFIRMED", recovery: "Call apply_coupon_correction again; the refund step is idempotent.",
      customer_message: "I've corrected the discount on your bill, but I couldn't confirm the " + rupees(act.amount_paise) + " refund yet, so I won't say it's done. Asking again is safe." };
    return { action: "APPLY_COUPON_CORRECTION", outcome: "APPLIED", coupon: act.coupon, discount_paise: expected, refund_id: key, refund_paise: act.amount_paise, processor_ref: w.row.value.processor_ref, verified_by_read_back: true,
      customer_message: "Fixed. " + act.coupon + " is now applied: " + rupees(expected) + " off, and I've refunded the " + rupees(act.amount_paise) + " difference to your payment (transaction " + w.row.value.processor_ref + ")." };
  };

  // ---------- Final check: compare the case's goal with the authoritative state ----------
  P.verifyOutcome = async function ({ session_id, reference }) {
    const ctx = await this.authorise(session_id, reference);
    if (ctx.err) return ctx.err;
    const oid = ctx.b.order ? ctx.b.order.key : "";
    const [refunds, events, details, orders] = await Promise.all([this.store.list("refunds"), this.store.list("events"), this.store.list("details"), this.store.list("orders")]);
    const state = {
      refunds: refunds.filter((x) => ctx.b.refs.includes(up(x.value.payment_id)) || (oid && s(x.value.order_id) === oid)).map((x) => ({ id: x.key, status: up(x.value.status), amount: rupees(Number(x.value.amount_paise)) })),
      replacement: orders.filter((x) => oid && x.key === oid + "R").map((x) => ({ id: x.key, status: up(x.value.status) }))[0] || null,
      delivery_tasks: events.filter((e) => s(e.value.order_id) === oid && up(e.value.source) === "DISPATCH").map((e) => ({ id: e.key, event: up(e.value.event) })),
      address: (() => { const x = details.find((r) => r.key === oid); return x ? { line: s(x.value.address_line), postcode: s(x.value.postcode), version: s(x.value.address_version) } : null; })(),
      coupon: (() => { const x = details.find((r) => r.key === oid); return x ? { code: s(x.value.coupon_code), discount: rupees(Number(x.value.discount_paise) || 0), remedy: s(x.value.remedy_status) } : null; })(),
    };
    return { action: "VERIFY_OUTCOME", reference: ctx.ref, order_id: oid || null, authoritative_state: state,
      customer_message: "Here's what our systems confirm right now: " + [
        state.refunds.length ? state.refunds.map((x) => "refund " + x.id + " " + x.amount + " " + x.status.toLowerCase()).join("; ") : "no refund on file",
        state.replacement ? "replacement order " + state.replacement.id + " " + state.replacement.status.toLowerCase() : null,
        state.delivery_tasks.length ? "priority delivery booked" : null,
      ].filter(Boolean).join(", ") + "." };
  };

  // ---------- Orchestrated multi-step resolution (dependency-ordered, resumable) ----------
  P.executeResolution = async function ({ session_id, reference, goals = "" }) {
    const want = s(goals).toUpperCase().split(/[\s,|]+/).filter(Boolean);
    const plan = ["REFUND", "REPLACEMENT", "REDELIVERY", "COUPON"].filter((g) => want.includes(g));
    if (!plan.length) return { action: "EXECUTE_RESOLUTION", outcome: "NO_GOALS", customer_message: "What would you like me to sort out: a refund, a replacement, a faster delivery or a coupon fix?" };
    const steps = [];
    for (const g of plan) {
      const fn = { REFUND: "executeRefund", REPLACEMENT: "createReplacementOrder", REDELIVERY: "createRedeliveryTask", COUPON: "applyCouponCorrection" }[g];
      let res; try { res = await this[fn]({ session_id, reference }); } catch { res = { outcome: "FAILED", customer_message: "That step hit a system error." }; }
      if (res.reason_code === "NOT_VERIFIED" || res.decision === "SECURITY_BLOCKED") return res; // identity gate: stop everything
      steps.push({ goal: g, outcome: res.outcome, customer_message: res.customer_message });
    }
    const done = steps.filter((x) => /^(REFUNDED|ALREADY_REFUNDED|CREATED|ALREADY_CREATED|ASSIGNED|ALREADY_ASSIGNED|APPLIED)$/.test(x.outcome));
    const pending = steps.filter((x) => /^(PARTIAL|UNKNOWN|FAILED)$/.test(x.outcome));
    await this.audit("EXEC-PLAN-" + norm(reference) + "-" + Date.now().toString(36).toUpperCase(), { kind: "CASE_RESOLUTION", status: pending.length ? "PARTIAL" : done.length === steps.length ? "RESOLVED" : "RESOLVED_WITH_REFUSALS", ref: norm(reference), reason: steps.map((x) => x.goal + ":" + x.outcome).join("|").slice(0, 300) });
    return { action: "EXECUTE_RESOLUTION", outcome: pending.length ? "PARTIAL" : "COMPLETED", plan, steps, completed: done.length, pending: pending.length,
      recovery: pending.length ? "Run execute_resolution again with the same goals; finished steps are skipped (idempotent) and only the failed steps are retried." : undefined,
      customer_message: steps.map((x) => x.customer_message).join(" ") };
  };
}
