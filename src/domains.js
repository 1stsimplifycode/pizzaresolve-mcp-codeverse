// PizzaResolve specialist domains added for the multi-agent build (Team CodeVerse):
//   Order Issue specialist, Address Modification specialist, Coupon & Promotion specialist.
// Pure functions only (no I/O, no clock reads). Every money or state decision is made here, never by the model.
import { s, rupees, hasInjection } from "./engine.js";
import { readPostcode, readCoupon } from "./spoken.js";

const up = (v) => s(v).toUpperCase();
const int = (v) => { const n = parseInt(s(v), 10); return Number.isFinite(n) ? n : NaN; };
const t = (v) => { const ms = Date.parse(s(v)); return Number.isFinite(ms) ? ms : NaN; };
const mins = (a, b) => (a - b) / 60000;

export const DOMAIN_POLICY = Object.freeze({
  ISSUE_WINDOW_H: 24,          // item complaints accepted up to 24 h after delivery
  REPLACEMENT_WINDOW_MIN: 120, // a replacement can only be offered within 2 h of delivery
  ADDRESS_FRESH_SESSION_MIN: 15, // address changes need a verification no older than this
});

export const ISSUE_TYPES = ["WRONG_ITEM", "MISSING_ITEM", "WRONG_QUANTITY", "DAMAGED", "WRONG_CUSTOMISATION", "PARTIAL"];

function parseItems(raw, subtotalPaise) {
  if (Array.isArray(raw)) return raw;
  const txt = s(raw);
  if (!txt) return [];
  if (txt.startsWith("[")) {
    try {
      const a = JSON.parse(txt);
      if (!Array.isArray(a)) return null;
      for (const i of a) if (!i || !s(i.sku) || !Number.isFinite(Number(i.qty)) || !Number.isFinite(Number(i.unit_paise))) return null;
      return a;
    } catch { return null; }
  }
  // Talkdesk table format: "1x Paneer Tikka S (veg), 2x Coke". Unit prices are not stored there, so the
  // subtotal is split evenly per unit (deterministic, documented approximation).
  const parts = txt.split(",").map((x) => x.trim()).filter(Boolean);
  const items = [];
  for (const part of parts) {
    const m = /^(\d+)\s*x\s+(.+)$/i.exec(part);
    if (!m) return null;
    const name = m[2].trim();
    const custom = (/\(([^)]*)\)\s*$/.exec(name) || [])[1] || "";
    items.push({ sku: name.replace(/\s*\([^)]*\)\s*$/, "").toUpperCase(), name, qty: Number(m[1]), unit_paise: 0, custom });
  }
  const units = items.reduce((x, i) => x + i.qty, 0);
  const sub = Number(subtotalPaise);
  if (units && Number.isFinite(sub)) for (const i of items) i.unit_paise = Math.floor(sub / units);
  return items;
}
const ev = (ref, source, fact) => ({ ref, source, fact });

// ---------------- Order Issue specialist ----------------
// Compares what was ordered (line_items) with the kitchen pack-scan record (packed_items).
export function analyseOrderIssue({ order, details, events, ledger = [], refunds = [], claim = {}, now }) {
  const type = up(claim.type);
  const findings = [], evidence = [], actions = [];
  const done = (decision, reason_code, say, extra = {}) => ({ decision, reason_code, findings, evidence, authorized_actions: actions, customer_message: say, ...extra });
  if (!ISSUE_TYPES.includes(type)) return done("INSUFFICIENT_EVIDENCE", "ISSUE_TYPE_UNKNOWN", "Could you tell me what was wrong with the order: a wrong item, a missing item, the wrong quantity, a damaged item or the wrong customisation?");
  if (!order) return done("INSUFFICIENT_EVIDENCE", "NO_ORDER", "There is no order in the restaurant system for this reference, so there are no items to check.");
  if (!details) return done("INSUFFICIENT_EVIDENCE", "NO_ORDER_DETAILS", "I can't see the item list for this order, so I can't check what was in it. I won't guess.");
  const ordered = parseItems(details.value.line_items ?? details.value.ordered_items, details.value.subtotal_paise);
  const packed = parseItems(details.value.packed_items, details.value.subtotal_paise);
  if (!ordered || !ordered.length) return done("INSUFFICIENT_EVIDENCE", "MALFORMED_ORDER_DETAILS", "The item record for this order is unreadable, so I can't verify the complaint automatically. Nothing has been changed.");
  evidence.push(ev(order.key + ":ITEMS", "ORDERS", "ordered " + ordered.map((i) => i.qty + "x " + i.name + (i.custom ? " (" + i.custom + ")" : "")).join(", ")));
  const status = up(order.value.status);
  const courierDelivered = (events || []).filter((e) => up(e.value.source) === "COURIER" && up(e.value.event) === "DELIVERED").sort((a, b) => t(a.value.at) - t(b.value.at))[0];
  const stageDelivered = up(details.value.stage) === "DELIVERED";
  if (status !== "DELIVERED" || (!courierDelivered && !stageDelivered)) {
    return done("ACTION_PENDING", "NOT_YET_DELIVERED", "Our records don't show this order as delivered yet, so I can't log an item complaint for it. If it hasn't arrived, I can look into the delivery instead.", { route_to: "DELIVERY" });
  }
  const deliveredAt = courierDelivered ? t(courierDelivered.value.at) : t(order.value.promised_at);
  const sinceDelivery = Number.isFinite(deliveredAt) ? mins(now, deliveredAt) : 0;
  evidence.push(courierDelivered ? ev(courierDelivered.key, "COURIER", "delivered at " + s(courierDelivered.value.at)) : ev(order.key + ":STAGE", "ORDERS", "order and order-details both record DELIVERED"));
  const existingIssue = ledger.find((l) => up(l.value.kind) === "ORDER_ISSUE" && s(l.value.order_id) === order.key);
  const existingRemedy = ledger.find((l) => ["ITEM_REFUND_REQUEST", "REPLACEMENT_REQUEST"].includes(up(l.value.kind)) && s(l.value.order_id) === order.key);
  const fullRefund = ledger.some((l) => up(l.value.kind) === "REFUND_REQUEST" && s(l.value.order_id) === order.key && int(l.value.amount_paise) >= int(order.value.total_paise)) ||
    refunds.some((r) => s(r.value.order_id) === order.key && up(r.value.status) !== "FAILED" && up(r.value.status) !== "REJECTED");
  if (sinceDelivery > DOMAIN_POLICY.ISSUE_WINDOW_H * 60) {
    actions.push({ action: "RECORD_HUMAN_REVIEW", order_id: order.key });
    return done("ESCALATION_REQUIRED", "OUTSIDE_COMPLAINT_WINDOW", "This order was delivered more than " + DOMAIN_POLICY.ISSUE_WINDOW_H + " hours ago, which is outside the window I can handle automatically. I can record it for a person to review.");
  }
  if (type === "DAMAGED") {
    actions.push({ action: "RECORD_HUMAN_REVIEW", order_id: order.key });
    findings.push({ issue: "DAMAGE_NEEDS_PHOTO_EVIDENCE", decision: "ESCALATION_REQUIRED" });
    return done("ESCALATION_REQUIRED", "DAMAGE_NEEDS_PHOTO_EVIDENCE", "Our systems can't see the condition of the food, so I can't verify damage myself. I can log the complaint and record it for a person to review with a photo; I won't promise a refund before they check it.", { record_complaint: true });
  }
  if (!packed || !packed.length) {
    actions.push({ action: "RECORD_HUMAN_REVIEW", order_id: order.key });
    return done("ESCALATION_REQUIRED", "NO_PACK_SCAN", "There is no kitchen pack-scan record for this order, so I can't check what went into the bag. I can log the complaint and record it for a person to check with the restaurant.", { record_complaint: true });
  }
  evidence.push(ev(order.key + ":PACK", "KITCHEN_PACK_SCAN", "packed " + packed.map((i) => i.qty + "x " + i.name + (i.custom ? " (" + i.custom + ")" : "")).join(", ")));
  // Deterministic diff between ordered and packed.
  const byKey = (arr) => { const m = new Map(); for (const i of arr) { const k = up(i.sku); const cur = m.get(k) || { ...i, qty: 0 }; cur.qty += Number(i.qty); m.set(k, cur); } return m; };
  const om = byKey(ordered), pm = byKey(packed);
  const missing = [], extra = [], qty = [], custom = [];
  for (const [k, o] of om) {
    const p = pm.get(k);
    if (!p) missing.push({ ...o, missing_qty: o.qty });
    else {
      if (p.qty < o.qty) qty.push({ ...o, missing_qty: o.qty - p.qty });
      if (s(p.custom).toLowerCase() !== s(o.custom).toLowerCase()) custom.push({ ...o, packed_custom: p.custom });
    }
  }
  for (const [k, p] of pm) if (!om.has(k)) extra.push(p);
  const wrongItem = missing.length && extra.length;
  const supported = {
    WRONG_ITEM: wrongItem, MISSING_ITEM: missing.length || qty.length, PARTIAL: missing.length || qty.length,
    WRONG_QUANTITY: qty.length, WRONG_CUSTOMISATION: custom.length,
  }[type];
  if (!supported) {
    actions.push({ action: "RECORD_HUMAN_REVIEW", order_id: order.key });
    findings.push({ issue: "CLAIM_NOT_SUPPORTED_BY_PACK_SCAN", decision: "CONFLICTING_RECORDS" });
    return done("CONFLICTING_RECORDS", "CLAIM_NOT_SUPPORTED_BY_PACK_SCAN", "The kitchen's pack-scan record shows this order was packed as ordered, which doesn't match what you've described. I'm not saying you're wrong; it means a person needs to check it with the restaurant. I can log the complaint and record it for review, but I can't offer a refund automatically.", { record_complaint: true });
  }
  const affected = [...missing, ...qty, ...(type === "WRONG_CUSTOMISATION" ? custom.map((c) => ({ ...c, missing_qty: c.qty })) : [])];
  const amount = affected.reduce((x, i) => x + Number(i.unit_paise) * Number(i.missing_qty), 0);
  const what = wrongItem ? "you ordered " + missing.map((i) => i.name).join(", ") + " but the bag was packed with " + extra.map((i) => i.name).join(", ")
    : type === "WRONG_CUSTOMISATION" ? custom.map((c) => c.name + " was packed as '" + (c.packed_custom || "standard") + "' instead of '" + (c.custom || "standard") + "'").join("; ")
    : "the bag was packed without " + affected.map((i) => i.missing_qty + "x " + i.name).join(", ");
  findings.push({ issue: wrongItem ? "WRONG_ITEM_VERIFIED" : type === "WRONG_CUSTOMISATION" ? "WRONG_CUSTOMISATION_VERIFIED" : "MISSING_ITEM_VERIFIED", decision: "ACTION_REQUIRED", amount_paise: amount });
  let say = "I checked the kitchen's pack-scan record and it confirms the problem: " + what + ".";
  if (existingRemedy) {
    say += " A " + (up(existingRemedy.value.kind) === "REPLACEMENT_REQUEST" ? "replacement" : "refund") + " request is already on file for this, reference " + existingRemedy.key + ", so I won't create another.";
    return done("ACTION_PENDING", "REMEDY_ALREADY_REQUESTED", say, { affected_items: affected.map((i) => i.name), amount_paise: amount, existing_issue: existingIssue && existingIssue.key });
  }
  if (fullRefund) {
    say += " A refund for the whole order is already on file, so there is nothing further to refund for these items.";
    return done("ACTION_PENDING", "FULL_REFUND_ALREADY_ON_FILE", say, { affected_items: affected.map((i) => i.name), amount_paise: amount });
  }
  actions.push({ action: "REQUEST_ITEM_REFUND", order_id: order.key, amount_paise: amount, reason: findings[0].issue });
  if (sinceDelivery <= DOMAIN_POLICY.REPLACEMENT_WINDOW_MIN) actions.push({ action: "REQUEST_REPLACEMENT", order_id: order.key, items: affected.map((i) => i.name) });
  say += " I can raise a refund request for " + rupees(amount) + " for the affected item" + (affected.length > 1 ? "s" : "") +
    (sinceDelivery <= DOMAIN_POLICY.REPLACEMENT_WINDOW_MIN ? ", or ask the restaurant to send a replacement" : "") + ". Which would you prefer?";
  return done("ACTION_REQUIRED", findings[0].issue, say, { affected_items: affected.map((i) => i.name), amount_paise: amount, record_complaint: true, existing_issue: existingIssue && existingIssue.key });
}

// ---------------- Address Modification specialist ----------------
const PRE_DISPATCH = new Set(["PLACED", "ACCEPTED", "PREPARING"]);
export function validateAddress(line, postcode) {
  const l = s(line).replace(/\s+/g, " ");
  const pc = readPostcode(s(postcode)).replace(/\s/g, "");
  if (!/^\d{6}$/.test(pc)) return { ok: false, code: "INVALID_POSTCODE", say: "That postcode doesn't look right; it should be 6 digits." };
  if (l.length < 5 || l.length > 120) return { ok: false, code: "INVALID_ADDRESS_LINE", say: "Please give the full street address (house or flat number and street)." };
  if (hasInjection(l) || /[<>{}]/.test(l)) return { ok: false, code: "ADDRESS_REJECTED_UNSAFE_TEXT", say: "I can't use that text as an address. Please give just the street address." };
  return { ok: true, line: l, postcode: pc };
}
export function analyseAddressChange({ order, details, events, zones, newLine, newPostcode }) {
  const done = (decision, reason_code, say, extra = {}) => ({ decision, reason_code, customer_message: say, authorized_actions: [], ...extra });
  if (!order) return done("INSUFFICIENT_EVIDENCE", "NO_ORDER", "There is no order in the restaurant system for this reference, so there is no address to change.");
  if (!details) return done("INSUFFICIENT_EVIDENCE", "NO_ORDER_DETAILS", "I can't see the delivery details for this order right now, so I can't change the address. Nothing has been changed.");
  const status = up(order.value.status);
  const courier = (events || []).filter((e) => up(e.value.source) === "COURIER");
  const dispatched = !!s(details.value.dispatched_at) || ["OUT_FOR_DELIVERY", "PICKED_UP", "DELIVERED"].includes(up(details.value.stage)) || courier.some((e) => ["PICKED_UP", "OUT_FOR_DELIVERY", "DELIVERED"].includes(up(e.value.event)));
  const assigned = courier.some((e) => up(e.value.event) === "ASSIGNED");
  const current = { line: s(details.value.address_line), postcode: s(details.value.postcode) };
  if (status === "CANCELLED") return done("RESOLVED_VERIFIED", "ORDER_CANCELLED", "This order is cancelled, so there is no delivery address to change.");
  if (status === "DELIVERED") return done("RESOLVED_VERIFIED", "ALREADY_DELIVERED", "This order has already been delivered, so the address can't be changed.");
  if (dispatched || status === "OUT_FOR_DELIVERY" || (status === "READY" && assigned)) {
    return done("ESCALATION_REQUIRED", "CUTOFF_PASSED_DISPATCHED", "Your order has already left the restaurant with a delivery partner, so I can't change the address any more. I can record it for a person to try contacting the delivery partner, but I can't promise they'll be able to redirect it.",
      { authorized_actions: [{ action: "RECORD_HUMAN_REVIEW", order_id: order.key }], current_address: current });
  }
  if (!PRE_DISPATCH.has(status) && status !== "READY") return done("INSUFFICIENT_EVIDENCE", "ORDER_STATE_UNKNOWN", "I can't tell what stage this order is at, so I won't change the address.");
  if (!newLine && !newPostcode) return done("ACTION_PENDING", "ELIGIBLE_NEEDS_ADDRESS", "Your order hasn't left the restaurant yet, so the address can still be changed. What is the new address and postcode?", { eligible: true, current_address: current });
  const v = validateAddress(newLine, newPostcode);
  if (!v.ok) return done("INSUFFICIENT_EVIDENCE", v.code, v.say, { eligible: true });
  if (v.postcode === current.postcode && v.line.toLowerCase() === current.line.toLowerCase()) return done("RESOLVED_VERIFIED", "NO_CHANGE", "That's already the delivery address on the order, so nothing needs changing.");
  const zoneOf = (pc) => (zones || []).find((z) => z.key === "ZONE-" + pc);
  const nz = zoneOf(v.postcode), cz = zoneOf(current.postcode);
  if (!nz || up(nz.value.mode) !== "SERVICEABLE") return done("RESOLVED_VERIFIED", "OUTSIDE_DELIVERY_ZONE", "Sorry, " + v.postcode + " is outside our delivery area, so I can't move the order there. The current address is unchanged.");
  if (cz && up(cz.value.scope) !== up(nz.value.scope)) return done("ESCALATION_REQUIRED", "DIFFERENT_STORE_ZONE", "That address is served by a different restaurant from the one making your order, so I can't move this order there automatically. I can record it for a person to review; the current address stays as it is until then.",
    { authorized_actions: [{ action: "RECORD_HUMAN_REVIEW", order_id: order.key }] });
  return done("ACTION_REQUIRED", "ADDRESS_CHANGE_ALLOWED", "Your order hasn't left the restaurant yet and the new address is in the same delivery area, so I can change it to " + v.line + ", " + v.postcode + ". Shall I go ahead?",
    { eligible: true, new_address: { line: v.line, postcode: v.postcode }, address_version: s(details.value.address_version) || "1",
      authorized_actions: [{ action: "CHANGE_ADDRESS", order_id: order.key, postcode: v.postcode }] });
}

// ---------------- Coupon & Promotion specialist ----------------
export function expectedDiscount(promo, subtotal) {
  const v = int(promo.value.value), max = int(promo.value.max_discount_paise);
  let d = up(promo.value.kind) === "PERCENT" ? Math.floor((subtotal * v) / 100) : v;
  if (Number.isFinite(max) && max > 0) d = Math.min(d, max);
  return Math.max(0, Math.min(d, subtotal));
}
export function analyseCoupon({ order, details, promotions, code, customerOrders = [], ledger = [], refunds = [] }) {
  const done = (decision, reason_code, say, extra = {}) => ({ decision, reason_code, customer_message: say, authorized_actions: [], ...extra });
  if (!order) return done("INSUFFICIENT_EVIDENCE", "NO_ORDER", "There is no order in the restaurant system for this reference, so I can't check a coupon on it.");
  if (!details) return done("INSUFFICIENT_EVIDENCE", "NO_ORDER_DETAILS", "I can't see the bill details for this order right now, so I can't check the coupon. I won't guess.");
  const onOrder = up(details.value.coupon_code);
  const c = up(readCoupon(code) || onOrder).replace(/[^A-Z0-9]/g, "").slice(0, 16);
  if (!c) return done("RESOLVED_VERIFIED", "NO_COUPON", "There is no coupon on this order. Which coupon code did you try to use?");
  const subtotal = int(details.value.subtotal_paise), applied = c === onOrder ? int(details.value.discount_paise) || 0 : 0;
  if (!Number.isFinite(subtotal)) return done("INSUFFICIENT_EVIDENCE", "MALFORMED_BILL", "The bill record for this order is unreadable, so I can't check the discount. Nothing has been changed.");
  const promo = (promotions || []).find((p) => up(p.key) === c);
  const bill = { subtotal_paise: subtotal, discount_applied_paise: applied, coupon_on_order: onOrder || null };
  if (!promo) return done("RESOLVED_VERIFIED", "INVALID_CODE", "I can't find a coupon called " + c + " in our promotions system, so there is no discount for it.", { bill });
  if (up(promo.value.status) !== "ACTIVE") return done("RESOLVED_VERIFIED", "COUPON_DISABLED", "The coupon " + c + " is not active, so it doesn't give a discount.", { bill });
  const placed = t(order.value.placed_at), from = t(promo.value.valid_from), to = t(promo.value.expires_at);
  if ((Number.isFinite(to) && placed > to) || (Number.isFinite(from) && placed < from)) return done("RESOLVED_VERIFIED", "COUPON_EXPIRED", "The coupon " + c + " " + (placed > to ? "expired on " + s(promo.value.expires_at).slice(0, 10) : "wasn't valid yet") + ", before this order was placed, so it couldn't be applied.", { bill });
  const min = int(promo.value.min_subtotal_paise) || 0;
  if (subtotal < min) return done("RESOLVED_VERIFIED", "BELOW_MINIMUM", "The coupon " + c + " needs an order of at least " + rupees(min) + "; this order's subtotal was " + rupees(subtotal) + ", so it doesn't qualify.", { bill });
  if (up(promo.value.eligibility) === "FIRST_ORDER") {
    const earlier = customerOrders.filter((o) => o.key !== order.key && t(o.value.placed_at) < placed && up(o.value.status) !== "CANCELLED");
    if (earlier.length) return done("RESOLVED_VERIFIED", "NOT_ELIGIBLE_FIRST_ORDER_ONLY", "The coupon " + c + " is only for a first order, and this account had earlier orders, so it doesn't apply.", { bill });
  }
  const other = int(details.value.other_discount_paise) || 0;
  if (other > 0 && up(promo.value.stackable) !== "YES") return done("RESOLVED_VERIFIED", "STACKING_NOT_ALLOWED", "This order already had another discount of " + rupees(other) + ", and " + c + " can't be combined with other offers.", { bill });
  const expected = expectedDiscount(promo, subtotal);
  bill.discount_expected_paise = expected;
  if (c !== onOrder) {
    return done("ESCALATION_REQUIRED", "NOT_APPLIED_AT_CHECKOUT", "The coupon " + c + " would have qualified for a discount of " + rupees(expected) + ", but it isn't on this order, so I can't tell whether it was entered at checkout. A person needs to approve adding it after the order; I can record that for review.",
      { bill, authorized_actions: [{ action: "RECORD_HUMAN_REVIEW", order_id: order.key }] });
  }
  if (applied === expected) return done("RESOLVED_VERIFIED", "DISCOUNT_CORRECT", "The coupon " + c + " was applied correctly: " + rupees(expected) + " off a subtotal of " + rupees(subtotal) + ".", { bill });
  if (applied > expected) return done("RESOLVED_VERIFIED", "DISCOUNT_NOT_UNDERAPPLIED", "The discount on this order is at least what " + c + " gives, so you weren't under-charged on the coupon.", { bill });
  const diff = expected - applied;
  const prior = ledger.find((l) => up(l.value.kind) === "PROMO_ADJUSTMENT_REQUEST" && s(l.value.order_id) === order.key);
  if (prior) return done("ACTION_PENDING", "ADJUSTMENT_ALREADY_REQUESTED", "A discount correction for this order is already on file, reference " + prior.key + ", so I won't create another.", { bill });
  const fullRefund = ledger.some((l) => up(l.value.kind) === "REFUND_REQUEST" && s(l.value.order_id) === order.key) ||
    refunds.some((r) => s(r.value.order_id) === order.key && !["FAILED", "REJECTED"].includes(up(r.value.status)));
  if (fullRefund) return done("ACTION_PENDING", "DOUBLE_DISCOUNT_PREVENTED", "The coupon " + c + " should have taken " + rupees(diff) + " more off, but a refund for this order's payment is already on file, so I won't add a discount on top of it.", { bill });
  return done("ACTION_REQUIRED", "DISCOUNT_UNDERAPPLIED", "The coupon " + c + " was on your order but only " + rupees(applied) + " was taken off instead of " + rupees(expected) + ". I can raise a correction request for the difference of " + rupees(diff) + ". Would you like me to?",
    { bill, amount_paise: diff, authorized_actions: [{ action: "REQUEST_PROMO_ADJUSTMENT", order_id: order.key, amount_paise: diff, coupon: c }] });
}
