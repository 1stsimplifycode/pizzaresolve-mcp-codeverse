// PizzaResolve_MCP_Codeverse - deterministic reconciliation and policy engine.
// Pure functions only: no I/O, no clock reads (callers pass `now`).
// The language model never decides money movement; it only relays what this engine returns.

export const DECISIONS = Object.freeze({
  RESOLVED_VERIFIED: "RESOLVED_VERIFIED",
  ACTION_REQUIRED: "ACTION_REQUIRED",
  ACTION_PENDING: "ACTION_PENDING",
  INSUFFICIENT_EVIDENCE: "INSUFFICIENT_EVIDENCE",
  CONFLICTING_RECORDS: "CONFLICTING_RECORDS",
  ESCALATION_REQUIRED: "ESCALATION_REQUIRED",
  SECURITY_BLOCKED: "SECURITY_BLOCKED",
});

// Higher = more severe; the overall decision is the most severe finding.
const SEVERITY = {
  RESOLVED_VERIFIED: 0, ACTION_PENDING: 1, ACTION_REQUIRED: 2, INSUFFICIENT_EVIDENCE: 3,
  CONFLICTING_RECORDS: 4, ESCALATION_REQUIRED: 5, SECURITY_BLOCKED: 6,
};

export const POLICY = Object.freeze({
  ORDER_SYNC_GRACE_MIN: 15,      // a captured payment may legitimately precede the order row
  DELIVERY_GRACE_MIN: 15,        // minutes after promised_at before an order counts as overdue
  COURIER_STALL_MIN: 30,         // no courier event for this long while overdue = stalled
  DUPLICATE_WINDOW_MIN: 10,      // two captures of the same amount for one checkout within this window
  REFUND_SLA_DAYS: 7,            // processor refund older than this without settlement = stale
  GPS_MATCH_M: 75,               // delivery scan within this distance counts as at the address
  MAX_FAILED_VERIFICATIONS: 3,   // per reference, rolling window
  LOCKOUT_WINDOW_MIN: 30,
  SESSION_TTL_MIN: 30,
});

const CAPTURED = new Set(["CAPTURED", "SETTLED"]);
const KNOWN_PAYMENT = new Set(["AUTHORIZED", "CAPTURED", "SETTLED", "FAILED", "REVERSED", "VOIDED"]);
const ORDER_STATES = ["PLACED", "ACCEPTED", "PREPARING", "READY", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED"];
const COURIER_ORDER = ["ASSIGNED", "PICKED_UP", "OUT_FOR_DELIVERY", "DELIVERED"];
const INJECTION = /ignore (all |previous |prior )?instructions|system prompt|you are now|issue (a )?(full )?refund|disregard|override|\bassistant:|\bsystem:/i;

// ---------- small helpers ----------
export const s = (v) => (v === undefined || v === null ? "" : String(v)).trim();
const up = (v) => s(v).toUpperCase();
const int = (v) => { const n = parseInt(s(v), 10); return Number.isFinite(n) ? n : NaN; };
const t = (v) => { const ms = Date.parse(s(v)); return Number.isFinite(ms) ? ms : NaN; };
const mins = (a, b) => (a - b) / 60000;
export const rupees = (paise) => "Rs " + (paise / 100).toFixed(2).replace(/\.00$/, "");
const spell = (ref) => s(ref); // references are short; spelled as-is

function ev(ref, source, fact) { return { ref, source, fact }; }

export function hasInjection(text) { return INJECTION.test(s(text)); }

// ---------- identity ----------
// Knowledge-based synthetic verification (order/payment reference + phone last 4 + postcode).
// This is NOT strong authentication; it is labelled as such everywhere it is reported.
export function checkIdentity({ customer, phoneLast4, postcode, requester }) {
  const who = s(requester).toLowerCase();
  if (who && who !== "self") return { ok: false, code: "THIRD_PARTY_REQUEST" };
  if (!customer) return { ok: false, code: "DETAILS_NOT_VERIFIED" };
  const cv = customer.value || customer;
  if (up(cv.status) === "FLAGGED") return { ok: false, code: "ACCOUNT_FLAGGED" };
  const p4 = s(phoneLast4).replace(/\D/g, "").slice(-4);
  const pc = s(postcode).replace(/\s/g, "").toUpperCase();
  if (p4.length !== 4 || !pc) return { ok: false, code: "DETAILS_NOT_VERIFIED" };
  if (p4 !== s(cv.phone_last4) || pc !== s(cv.postcode).replace(/\s/g, "").toUpperCase())
    return { ok: false, code: "DETAILS_NOT_VERIFIED" };
  return { ok: true, code: "VERIFIED_SYNTHETIC_KBA" };
}

export function countRecentFailures(attemptRows, reference, now) {
  const ref = up(reference);
  return attemptRows.filter((r) =>
    up(r.value.kind) === "VERIFY_ATTEMPT" && up(r.value.ref) === ref && up(r.value.status) === "FAILED" &&
    mins(now, t(r.value.created_at)) <= POLICY.LOCKOUT_WINDOW_MIN).length;
}

// ---------- payment specialist ----------
export function analysePayments({ order, payments, refunds, ledger, now, paymentsAvailable }) {
  const findings = [];
  const evidence = [];
  const actions = [];
  if (!paymentsAvailable) {
    findings.push({ issue: "PAYMENT_SYSTEM_UNAVAILABLE", decision: "INSUFFICIENT_EVIDENCE",
      say: "Our payment system is not responding right now, so I can't confirm anything about the charges on this order. Nothing has been changed." });
    evidence.push(ev("SYSTEM:PAYMENTS", "PAYMENTS", "unavailable (timeout or injected fault)"));
    return { findings, evidence, actions, refundable: [] };
  }
  const malformed = payments.filter((p) => !KNOWN_PAYMENT.has(up(p.value.status)) || !Number.isFinite(int(p.value.amount_paise)));
  for (const p of malformed) {
    evidence.push(ev(p.key, "PAYMENTS", "status '" + (s(p.value.status) || "null") + "' is not a recognised payment state"));
  }
  if (malformed.length) {
    findings.push({ issue: "AMBIGUOUS_PAYMENT_STATE", decision: "INSUFFICIENT_EVIDENCE",
      say: "One of the payment records for this order has an unclear status, so I can't tell yet whether that charge went through. I won't assume either way." });
  }
  // A replayed gateway webhook can create a second row for the SAME charge. Rows sharing a gateway_ref
  // are one transaction; only distinct gateway references can be a double charge.
  const seenRef = new Map();
  const replayed = [];
  for (const p of payments.slice().sort((a, b) => t(a.value.event_at) - t(b.value.event_at))) {
    const g = s(p.value.gateway_ref);
    if (g && seenRef.has(g)) replayed.push(p); else if (g) seenRef.set(g, p);
  }
  if (replayed.length) {
    for (const p of replayed) evidence.push(ev(p.key, "PAYMENTS", "duplicate record of gateway transaction " + s(p.value.gateway_ref) + " (same charge, counted once)"));
    findings.push({ issue: "DUPLICATE_PAYMENT_EVENT_IGNORED", decision: "RESOLVED_VERIFIED",
      say: "One of the payment records is a repeated notification of the same transaction, not a second charge, so it isn't counted twice." });
  }
  const captured = payments.filter((p) => !replayed.includes(p) && CAPTURED.has(up(p.value.status)) && Number.isFinite(int(p.value.amount_paise)))
    .sort((a, b) => t(a.value.event_at) - t(b.value.event_at));
  const authorizedOnly = payments.filter((p) => !replayed.includes(p) && up(p.value.status) === "AUTHORIZED");
  for (const p of payments) {
    if (malformed.includes(p) || replayed.includes(p)) continue;
    evidence.push(ev(p.key, "PAYMENTS", up(p.value.status) + " " + rupees(int(p.value.amount_paise)) + " at " + s(p.value.event_at)));
  }
  for (const p of authorizedOnly) {
    findings.push({ issue: "PAYMENT_AUTHORIZED_NOT_CAPTURED", decision: "ACTION_PENDING", ref: p.key,
      say: "Your bank has placed a hold of " + rupees(int(p.value.amount_paise)) + " for this payment, but it was never captured by us. A hold that isn't captured is released by your bank automatically; I can't release it from here, and I won't raise a refund for money we didn't take." });
  }

  // Refund bookkeeping per payment: processor records + our own refund requests.
  const refundedOrPending = {};
  const add = (pid, amt) => { refundedOrPending[pid] = (refundedOrPending[pid] || 0) + amt; };
  for (const r of refunds) {
    const st = up(r.value.status);
    const pid = s(r.value.payment_id);
    const amt = int(r.value.amount_paise);
    const ageD = (now - t(r.value.at)) / 86400000;
    evidence.push(ev(r.key, "REFUND_PROCESSOR", st + " " + (Number.isFinite(amt) ? rupees(amt) : "?") + (s(r.value.processor_ref) ? " ref " + s(r.value.processor_ref) : " no processor ref")));
    if (st === "SETTLED" && s(r.value.processor_ref)) {
      add(pid, amt);
      findings.push({ issue: "REFUND_SETTLED", decision: "RESOLVED_VERIFIED", ref: r.key,
        say: "The refund of " + rupees(amt) + " is marked settled by our refund processor, reference " + spell(r.value.processor_ref) + ". Banks can take a few days to show it." });
    } else if (st === "SETTLED") {
      add(pid, amt);
      findings.push({ issue: "REFUND_SETTLED_WITHOUT_PROOF", decision: "ESCALATION_REQUIRED", ref: r.key,
        say: "Our records mark a refund as settled, but there is no processor confirmation reference, so I can't confirm the money was sent." });
    } else if (st === "REJECTED") {
      findings.push({ issue: "REFUND_REJECTED", decision: "ESCALATION_REQUIRED", ref: r.key,
        say: "A refund was requested for this order, but the refund processor rejected it, so no money has been returned. A person needs to review why before anything is re-issued." });
    } else if (st === "FAILED") {
      findings.push({ issue: "REFUND_FAILED", decision: "ESCALATION_REQUIRED", ref: r.key,
        say: "A refund was started for this order, but the refund processor reports that it failed, so the money has not been returned. This needs a person to re-issue it safely." });
    } else if (st === "INITIATED" || st === "PROCESSING") {
      add(pid, amt);
      if (ageD > POLICY.REFUND_SLA_DAYS) {
        findings.push({ issue: "REFUND_STALE", decision: "ESCALATION_REQUIRED", ref: r.key,
          say: "A refund of " + rupees(amt) + " was started " + Math.floor(ageD) + " days ago and still has no settlement confirmation, which is longer than it should take. Started does not mean the money has reached you." });
      } else {
        findings.push({ issue: "REFUND_IN_PROGRESS", decision: "ACTION_PENDING", ref: r.key,
          say: "A refund of " + rupees(amt) + " is in progress with the refund processor; it was started " + Math.max(0, Math.floor(ageD)) + " days ago and is not settled yet." });
      }
    } else {
      findings.push({ issue: "REFUND_STATE_UNKNOWN", decision: "INSUFFICIENT_EVIDENCE", ref: r.key,
        say: "There is a refund record for this order, but its status is unclear, so I can't confirm it." });
    }
  }
  const ourReqs = ledger.filter((l) => up(l.value.kind) === "REFUND_REQUEST");
  for (const l of ourReqs) {
    add(s(l.value.payment_id), int(l.value.amount_paise) || 0);
    evidence.push(ev(l.key, "PIZZARESOLVE_LEDGER", "refund request " + up(l.value.status) + " " + rupees(int(l.value.amount_paise) || 0) + " created " + s(l.value.created_at)));
    findings.push({ issue: "REFUND_REQUEST_ON_FILE", decision: "ACTION_PENDING", ref: l.key,
      say: "A refund request for " + rupees(int(l.value.amount_paise) || 0) + " is already on file, reference " + l.key + ". It has not been paid out yet; it is waiting for the refund team." });
  }

  const refundable = [];
  const remaining = (p) => Math.max(0, int(p.value.amount_paise) - (refundedOrPending[p.key] || 0));

  if (!order) {
    // Ghost order: money captured, no order row.
    for (const p of captured) {
      const age = mins(now, t(p.value.event_at));
      if (age < POLICY.ORDER_SYNC_GRACE_MIN) {
        findings.push({ issue: "ORDER_SYNC_PENDING", decision: "ACTION_PENDING", ref: p.key,
          say: "Your payment went through " + Math.max(0, Math.round(age)) + " minutes ago. The restaurant system can take up to " + POLICY.ORDER_SYNC_GRACE_MIN + " minutes to show a new order, so a missing order right now does not mean it was lost." });
      } else if (remaining(p) > 0) {
        findings.push({ issue: "GHOST_ORDER", decision: "ACTION_REQUIRED", ref: p.key,
          say: "Your payment of " + rupees(int(p.value.amount_paise)) + " was captured, but the restaurant system has no order for it after " + Math.round(age) + " minutes. So you were charged for an order the kitchen never received." });
        refundable.push({ payment_id: p.key, amount_paise: remaining(p), reason: "GHOST_ORDER" });
      }
    }
    if (!captured.length && !malformed.length && !authorizedOnly.length) {
      findings.push({ issue: "NO_CAPTURED_PAYMENT", decision: "RESOLVED_VERIFIED",
        say: "I can't see a completed charge for this payment reference; it was not captured, so no money was taken for it." });
    }
  } else {
    const total = int(order.value.total_paise);
    if (captured.length > 1) {
      const first = captured[0];
      const dups = captured.slice(1).filter((p) => int(p.value.amount_paise) === int(first.value.amount_paise) &&
        mins(t(p.value.event_at), t(first.value.event_at)) <= POLICY.DUPLICATE_WINDOW_MIN);
      if (dups.length) {
        for (const d of dups) {
          if (remaining(d) > 0) refundable.push({ payment_id: d.key, amount_paise: remaining(d), reason: "DUPLICATE_CHARGE" });
        }
        const open = dups.filter((d) => remaining(d) > 0);
        findings.push({ issue: "DUPLICATE_CHARGE", decision: open.length ? "ACTION_REQUIRED" : "ACTION_PENDING", ref: dups.map((d) => d.key).join(","),
          say: "You were charged twice for this order: " + captured.length + " successful charges of " + rupees(int(first.value.amount_paise)) + " for one order of " + rupees(total) + "." +
            (open.length ? "" : " A refund for the extra charge is already on file.") });
      } else {
        findings.push({ issue: "MULTIPLE_CHARGES_UNCLEAR", decision: "ESCALATION_REQUIRED",
          say: "There is more than one charge on this order, but they don't look like a simple duplicate, so a person needs to check them." });
      }
    } else if (captured.length === 0 && !malformed.length && !authorizedOnly.length) {
      findings.push({ issue: "NO_CAPTURED_PAYMENT", decision: "RESOLVED_VERIFIED",
        say: "I can't see a completed charge on this order, so no money was taken for it." });
    }
  }
  return { findings, evidence, actions, refundable };
}

// ---------- delivery specialist ----------
export function analyseDelivery({ order, events, reported, now, deliveryAvailable }) {
  const findings = [];
  const evidence = [];
  const flags = [];
  if (!order) return { findings, evidence, flags, recovery: [] };
  if (!deliveryAvailable) {
    findings.push({ issue: "DELIVERY_SYSTEM_UNAVAILABLE", decision: "INSUFFICIENT_EVIDENCE",
      say: "Our delivery tracking system is not responding right now, so I can't confirm where your order is." });
    evidence.push(ev("SYSTEM:DELIVERY", "DELIVERY", "unavailable (timeout or injected fault)"));
    return { findings, evidence, flags, recovery: [] };
  }
  const status = up(order.value.status);
  const promised = t(order.value.promised_at);
  evidence.push(ev(order.key, "ORDERS", "order " + status + ", promised by " + s(order.value.promised_at)));
  if (!ORDER_STATES.includes(status)) {
    findings.push({ issue: "ORDER_STATE_UNKNOWN", decision: "INSUFFICIENT_EVIDENCE",
      say: "The order system shows a status I don't recognise for this order, so I can't confirm where it is." });
    return { findings, evidence, flags, recovery: [] };
  }
  const evs = events.filter((e) => Number.isFinite(t(e.value.at))).sort((a, b) => t(a.value.at) - t(b.value.at));
  for (const e of events) {
    if (hasInjection(e.value.detail)) flags.push({ ref: e.key, flag: "UNTRUSTED_TEXT_IGNORED" });
  }
  for (const e of evs) evidence.push(ev(e.key, up(e.value.source), up(e.value.event) + " at " + s(e.value.at) + (s(e.value.distance_m) ? ", " + s(e.value.distance_m) + " m from address" : "")));
  const courier = evs.filter((e) => up(e.value.source) === "COURIER");
  const lastCourier = courier[courier.length - 1];
  const deliveredEv = courier.find((e) => up(e.value.event) === "DELIVERED");
  const photo = evs.find((e) => up(e.value.source) === "POD" && up(e.value.event) === "PHOTO");
  // Event-order sanity: a courier step that regresses after DELIVERED is a conflict.
  let regression = false;
  if (deliveredEv) {
    regression = courier.some((e) => t(e.value.at) > t(deliveredEv.value.at) && COURIER_ORDER.indexOf(up(e.value.event)) < COURIER_ORDER.indexOf("DELIVERED") && COURIER_ORDER.indexOf(up(e.value.event)) >= 0);
  }
  const notReceived = reported.includes("NOT_RECEIVED") || reported.includes("WRONG_ADDRESS");
  const itemsClaim = reported.includes("MISSING_ITEMS") || reported.includes("WRONG_ITEMS");
  const kitchen = evs.filter((e) => up(e.value.source) === "KITCHEN");
  // Cross-system disagreement: order system and courier system must agree on delivery.
  const statusSaysDelivered = status === "DELIVERED";
  if (statusSaysDelivered !== !!deliveredEv && status !== "CANCELLED") {
    findings.push({ issue: "ORDER_COURIER_DISAGREE", decision: "CONFLICTING_RECORDS",
      say: statusSaysDelivered ? "The restaurant system marks this order delivered, but the courier system has no delivery record for it, so the two systems disagree and I can't treat it as delivered."
        : "The courier system recorded a delivery, but the restaurant system still shows the order as " + status.toLowerCase().replace(/_/g, " ") + ", so the two systems disagree." });
  }
  if (status === "CANCELLED") {
    findings.push({ issue: "ORDER_CANCELLED", decision: "RESOLVED_VERIFIED", say: "The restaurant system shows this order as cancelled." });
    return { findings, evidence, flags, recovery: [] };
  }
  if (status === "DELIVERED" || deliveredEv) {
    const dist = deliveredEv ? int(deliveredEv.value.distance_m) : NaN;
    const gpsAtAddress = Number.isFinite(dist) && dist <= POLICY.GPS_MATCH_M;
    if (regression) {
      findings.push({ issue: "EVENT_ORDER_CONFLICT", decision: "CONFLICTING_RECORDS",
        say: "The courier records for this order are out of sequence (a pickup was logged after the delivery), so I can't rely on the delivered status." });
    }
    if (notReceived) {
      const strength = (gpsAtAddress ? "the courier's location was at your address" : Number.isFinite(dist) ? "the courier's location was " + dist + " m from your address" : "there is no location data") +
        (photo ? " and there is a delivery photo" : " and there is no delivery photo");
      findings.push({ issue: "DELIVERY_DISPUTED", decision: "CONFLICTING_RECORDS",
        evidence_strength: gpsAtAddress && photo ? "STRONG" : gpsAtAddress || photo ? "PARTIAL" : "WEAK",
        say: "The courier marked this order as delivered, but you say it never arrived. For this delivery " + strength + ". A delivered status alone doesn't prove you received it, so I won't treat this as resolved." });
      return { findings, evidence, flags, recovery: ["OPEN_DELIVERY_INVESTIGATION"], dispute: { gpsAtAddress, photo: !!photo } };
    }
    if (itemsClaim) {
      findings.push({ issue: "ITEMS_CLAIM_UNVERIFIABLE", decision: "ESCALATION_REQUIRED",
        say: "Our systems record what was ordered (" + s(order.value.items) + ") but not what was inside the bag, so I can't verify missing or wrong items myself. This needs a person to check with the restaurant; I won't promise a refund or re-delivery before they confirm it." });
    }
    if (!regression && !itemsClaim && statusSaysDelivered && deliveredEv) findings.push({ issue: "DELIVERED", decision: "RESOLVED_VERIFIED",
      say: "The courier recorded this order as delivered at " + s(deliveredEv ? deliveredEv.value.at : order.value.promised_at) + (photo ? ", with a delivery photo." : ".") });
    return { findings, evidence, flags, recovery: [] };
  }
  const overdueBy = mins(now, promised);
  if (!Number.isFinite(promised)) {
    findings.push({ issue: "PROMISE_TIME_MISSING", decision: "INSUFFICIENT_EVIDENCE", say: "I can't see the promised delivery time for this order, so I can't tell whether it is late." });
    return { findings, evidence, flags, recovery: [] };
  }
  if (overdueBy <= POLICY.DELIVERY_GRACE_MIN) {
    findings.push({ issue: "ON_THE_WAY", decision: "ACTION_PENDING",
      say: "Your order is " + status.toLowerCase().replace(/_/g, " ") + " and is due by " + s(order.value.promised_at) + (overdueBy > 0 ? " (it's running " + Math.round(overdueBy) + " minutes late)." : ".") });
    return { findings, evidence, flags, recovery: [] };
  }
  const sinceCourier = lastCourier ? mins(now, t(lastCourier.value.at)) : Infinity;
  if (!lastCourier || sinceCourier > POLICY.COURIER_STALL_MIN) {
    const kAccepted = kitchen.some((e) => up(e.value.event) === "ACCEPTED");
    const kReady = kitchen.some((e) => up(e.value.event) === "READY");
    const where = !kAccepted ? "the restaurant has not confirmed receiving the order"
      : !lastCourier && kReady ? "the food was ready at the restaurant but no delivery partner has been assigned"
      : !lastCourier ? "the restaurant accepted it but there is no courier activity at all"
      : "the courier hasn't reported any progress since " + up(lastCourier.value.event).toLowerCase().replace(/_/g, " ") + " " + Math.round(sinceCourier) + " minutes ago";
    findings.push({ issue: !kAccepted ? "KITCHEN_NOT_CONFIRMED" : "DELIVERY_STALLED", decision: "ACTION_REQUIRED", overdue_min: Math.round(overdueBy),
      say: "Your order is " + Math.round(overdueBy) + " minutes past its promised time and " + where + ". I can't see where it is, so I won't guess." });
    return { findings, evidence, flags, recovery: ["OPEN_DELIVERY_INVESTIGATION", "REQUEST_REFUND"] };
  }
  findings.push({ issue: "DELIVERY_LATE_MOVING", decision: "ACTION_PENDING", overdue_min: Math.round(overdueBy),
    say: "Your order is " + Math.round(overdueBy) + " minutes late, but the courier reported '" + up(lastCourier.value.event).toLowerCase().replace(/_/g, " ") + "' " + Math.round(sinceCourier) + " minutes ago, so it is still moving." });
  return { findings, evidence, flags, recovery: ["OPEN_DELIVERY_INVESTIGATION"] };
}

// ---------- orchestration of the specialists ----------
export function reconcile({ order, payments, events, refunds, ledger, reported = [], now, paymentsAvailable = true, deliveryAvailable = true }) {
  const rep = reported.map(up);
  const pay = analysePayments({ order, payments, refunds, ledger, now, paymentsAvailable });
  const del = analyseDelivery({ order, events, reported: rep, now, deliveryAvailable });
  const findings = [...pay.findings, ...del.findings];
  const evidence = [...pay.evidence, ...del.evidence];
  const authorized = [];
  const existingEsc = ledger.filter((l) => up(l.value.kind) === "ESCALATION");
  const existingInv = ledger.filter((l) => up(l.value.kind) === "DELIVERY_INVESTIGATION");

  for (const r of pay.refundable) authorized.push({ action: "REQUEST_REFUND", payment_id: r.payment_id, amount_paise: r.amount_paise, reason: r.reason });
  if (del.recovery.includes("REQUEST_REFUND") && order && paymentsAvailable) {
    // Overdue/stalled delivery: full refund of the (single) captured payment is permitted if nothing is already pending.
    const capturedPays = payments.filter((p) => CAPTURED.has(up(p.value.status))).sort((a, b) => t(a.value.event_at) - t(b.value.event_at));
    const first = capturedPays[0];
    if (first && !authorized.some((a) => a.payment_id === first.key)) {
      const pending = ledger.some((l) => up(l.value.kind) === "REFUND_REQUEST" && s(l.value.payment_id) === first.key) ||
        refunds.some((r) => s(r.value.payment_id) === first.key && up(r.value.status) !== "FAILED");
      if (!pending) authorized.push({ action: "REQUEST_REFUND", payment_id: first.key, amount_paise: int(first.value.amount_paise), reason: "DELIVERY_STALLED" });
    }
  }
  if (del.recovery.includes("OPEN_DELIVERY_INVESTIGATION") && !existingInv.length) authorized.push({ action: "OPEN_DELIVERY_INVESTIGATION", order_id: order.key });
  for (const l of existingInv) {
    evidence.push(ev(l.key, "PIZZARESOLVE_LEDGER", "delivery investigation " + up(l.value.status) + " created " + s(l.value.created_at)));
    findings.push({ issue: "INVESTIGATION_ON_FILE", decision: "ACTION_PENDING", ref: l.key,
      say: "A delivery investigation is already open for this order, reference " + l.key + "." });
  }
  for (const l of existingEsc) {
    evidence.push(ev(l.key, "PIZZARESOLVE_LEDGER", "human review request " + up(l.value.status) + " created " + s(l.value.created_at)));
    findings.push({ issue: "HUMAN_REVIEW_ON_FILE", decision: "ACTION_PENDING", ref: l.key,
      say: "This case is already queued for human review, reference " + l.key + ". It has not been picked up by a person yet as far as our records show." });
  }

  let decision = "RESOLVED_VERIFIED";
  for (const f of findings) if (SEVERITY[f.decision] > SEVERITY[decision]) decision = f.decision;
  if (!findings.length) decision = "INSUFFICIENT_EVIDENCE";
  const needsHuman = findings.some((f) => f.decision === "ESCALATION_REQUIRED" || f.decision === "CONFLICTING_RECORDS") || rep.includes("WANTS_HUMAN");
  if (needsHuman && !existingEsc.length) authorized.push({ action: "RECORD_HUMAN_REVIEW", order_id: order ? order.key : null });

  const reasonCode = findings.slice().sort((a, b) => SEVERITY[b.decision] - SEVERITY[a.decision]).map((f) => f.issue).join("+") || "NO_FINDINGS";
  const flags = del.flags || [];
  let message = findings.map((f) => f.say).join(" ");
  if (!findings.length) message = "I couldn't find enough information in our systems to confirm what happened, so I won't guess.";
  const offer = [];
  if (authorized.some((a) => a.action === "REQUEST_REFUND")) {
    const amt = authorized.filter((a) => a.action === "REQUEST_REFUND").reduce((x, a) => x + a.amount_paise, 0);
    offer.push("I can raise a refund request for " + rupees(amt) + " now");
  }
  if (authorized.some((a) => a.action === "OPEN_DELIVERY_INVESTIGATION")) offer.push("I can open a delivery investigation");
  if (authorized.some((a) => a.action === "RECORD_HUMAN_REVIEW")) offer.push("I can record this for review by a person (I can't transfer you live from this chat)");
  if (offer.length) message += " " + offer.join(", and ") + ". Would you like me to?";
  return { decision, reason_code: reasonCode, findings: findings.map(({ say, ...f }) => f), evidence, authorized_actions: authorized, flags, customer_message: message.trim() };
}

export function maxSeverity(a, b) { return SEVERITY[a] >= SEVERITY[b] ? a : b; }
