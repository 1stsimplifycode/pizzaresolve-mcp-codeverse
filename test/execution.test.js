// Outcome-based tests for the business execution layer: each test checks the authoritative state, not the reply text.
import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/store.js";
import { PizzaService } from "../src/service.js";
import { seedRows } from "../src/seed_data.js";

const NOW = Date.parse("2026-11-04T06:00:00.000Z");
function fresh() {
  const store = new MemoryStore(seedRows(NOW));
  const svc = new PizzaService(store, { now: () => NOW });
  const iso = (m) => new Date(NOW - m * 60000).toISOString();
  // Live-table shaped rows (same columns as PZ_Order_Details_Codeverse).
  store.t.details.set("ORD-7099", { id: "d1", key: "ORD-7099", value: { customer_id: "CUS-199", ordered_items: "1x Paneer Tikka S (veg)", packed_items: "1x Chicken Tikka S", address_line: "1 Test Lane", postcode: "560099", stage: "DELIVERED", coupon_code: "", subtotal_paise: "25900", discount_paise: "0", address_version: "1", remedy_status: "" } });
  store.t.orders.set("ORD-7090", { id: "o1", key: "ORD-7090", value: { customer_id: "CUS-199", checkout_id: "CHK-7090", status: "OUT_FOR_DELIVERY", total_paise: "54900", items: "1x Farmhouse L", placed_at: iso(120), promised_at: iso(60), version: "1" } });
  store.t.payments.set("PAY-7090", { id: "p1", key: "PAY-7090", value: { customer_id: "CUS-199", order_id: "ORD-7090", checkout_id: "CHK-7090", status: "CAPTURED", amount_paise: "54900", event_at: iso(120), gateway_ref: "GW-7090" } });
  store.t.details.set("ORD-7090", { id: "d2", key: "ORD-7090", value: { customer_id: "CUS-199", ordered_items: "1x Farmhouse L", packed_items: "1x Farmhouse L", address_line: "1 Test Lane", postcode: "560099", stage: "OUT_FOR_DELIVERY", coupon_code: "PIZZA20", subtotal_paise: "54900", discount_paise: "0", address_version: "1", remedy_status: "" } });
  store.t.promotions.set("PIZZA20", { id: "pr", key: "PIZZA20", value: { kind: "PERCENT", value: "20", min_subtotal_paise: "30000", max_discount_paise: "20000", expires_at: "2026-12-31T23:59:59Z", stackable: "NO", status: "ACTIVE" } });
  return { store, svc };
}
const login = async (svc, ref) => (await svc.verifyCustomer({ reference: ref, phone_last4: "7777", postcode: "560099", requester: "self" })).session_id;

test("E1 wrong pizza: replacement order + kitchen task exist, linked, and a repeat does not duplicate", async () => {
  const { store, svc } = fresh();
  const sid = await login(svc, "ORD-7099");
  const r = await svc.createReplacementOrder({ session_id: sid, reference: "ORD-7099" });
  assert.equal(r.outcome, "CREATED", JSON.stringify(r));
  assert.equal(store.t.orders.get("ORD-7099R").value.status, "PREPARING");
  assert.equal(store.t.orders.get("ORD-7099R").value.total_paise, "0");
  assert.ok(store.t.events.get("EVT-ORD-7099R-1"));
  assert.equal(store.t.details.get("ORD-7099").value.remedy_status, "REPLACED:ORD-7099R");
  const again = await svc.createReplacementOrder({ session_id: sid, reference: "ORD-7099" });
  assert.equal(again.outcome, "ALREADY_CREATED");
  assert.equal([...store.t.orders.keys()].filter((k) => k.startsWith("ORD-7099R")).length, 1);
});

test("E2 paid, no order: refund executed in sandbox processor, verified, and never twice", async () => {
  const { store, svc } = fresh();
  const sid = await login(svc, "PAY-9098");
  const r = await svc.executeRefund({ session_id: sid, reference: "PAY-9098" });
  assert.equal(r.outcome, "REFUNDED", JSON.stringify(r));
  const row = store.t.refunds.get("RF-SBX-PAY-9098");
  assert.equal(row.value.status, "SETTLED");
  assert.equal(row.value.amount_paise, "19900");
  const again = await svc.executeRefund({ session_id: sid, reference: "PAY-9098" });
  assert.equal(again.outcome, "ALREADY_REFUNDED");
  assert.equal([...store.t.refunds.values()].filter((x) => x.value.payment_id === "PAY-9098").length, 1);
});

test("E3 late delivery: priority redelivery booked and ETA moved; not claimed delivered", async () => {
  const { store, svc } = fresh();
  const sid = await login(svc, "ORD-7090");
  const r = await svc.createRedeliveryTask({ session_id: sid, reference: "ORD-7090" });
  assert.equal(r.outcome, "ASSIGNED", JSON.stringify(r));
  assert.equal(r.delivered, false);
  assert.ok(store.t.events.get("EVT-ORD-7090-REDISPATCH"));
  assert.ok(Date.parse(store.t.orders.get("ORD-7090").value.promised_at) > NOW);
  assert.equal(store.t.orders.get("ORD-7090").value.version, "2");
});

test("E4 coupon under-applied: bill corrected and difference refunded; repeat is refused", async () => {
  const { store, svc } = fresh();
  const sid = await login(svc, "ORD-7090");
  const r = await svc.applyCouponCorrection({ session_id: sid, reference: "ORD-7090" });
  assert.equal(r.outcome, "APPLIED", JSON.stringify(r));
  assert.equal(store.t.details.get("ORD-7090").value.discount_paise, "10980");
  assert.equal(store.t.refunds.get("RF-CPN-ORD-7090").value.amount_paise, "10980");
  const again = await svc.applyCouponCorrection({ session_id: sid, reference: "ORD-7090" });
  assert.notEqual(again.outcome, "APPLIED");
});

test("E5 multi-intent: one plan runs coupon + redelivery in order and reports both", async () => {
  const { svc } = fresh();
  const sid = await login(svc, "ORD-7090");
  const r = await svc.executeResolution({ session_id: sid, reference: "ORD-7090", goals: "COUPON, REDELIVERY" });
  assert.equal(r.outcome, "COMPLETED", JSON.stringify(r));
  assert.deepEqual(r.steps.map((x) => x.outcome), ["ASSIGNED", "APPLIED"]);
});

test("E6 unauthorised: another customer's session cannot refund or replace", async () => {
  const { store, svc } = fresh();
  const other = (await svc.verifyCustomer({ reference: "PAY-9001", phone_last4: "4821", postcode: "560085" })).session_id;
  const r = await svc.createReplacementOrder({ session_id: other, reference: "ORD-7099" });
  assert.equal(r.decision, "SECURITY_BLOCKED");
  assert.equal(store.t.orders.has("ORD-7099R"), false);
  const r2 = await svc.executeRefund({ session_id: "VS-AAAAAAAAAA", reference: "PAY-9098" });
  assert.equal(r2.decision, "SECURITY_BLOCKED");
  assert.equal(store.t.refunds.has("RF-SBX-PAY-9098"), false);
});

test("E7 outage + recovery: kitchen task write fails -> PARTIAL, retry completes without a second order", async () => {
  const { store, svc } = fresh();
  const sid = await login(svc, "ORD-7099");
  store.faults.events = "UNAVAILABLE";
  const r = await svc.createReplacementOrder({ session_id: sid, reference: "ORD-7099" });
  assert.equal(r.outcome, "PARTIAL", JSON.stringify(r));
  assert.ok(!/accepted it/.test(r.customer_message));
  delete store.faults.events;
  const r2 = await svc.createReplacementOrder({ session_id: sid, reference: "ORD-7099" });
  assert.equal(r2.outcome, "ALREADY_CREATED");
  assert.ok(store.t.events.get("EVT-ORD-7099R-1"));
});

test("E8 wrong item with packing proof: investigation authorises replacement, does NOT escalate to a human", async () => {
  const { svc } = fresh();
  const sid = await login(svc, "ORD-7099");
  const r = await svc.investigateOrder({ session_id: sid, reference: "ORD-7099", reported_issues: ["WRONG_ITEMS"] });
  assert.ok(r.authorized_actions.some((a) => a.action === "CREATE_REPLACEMENT"), JSON.stringify(r));
  assert.ok(!r.authorized_actions.some((a) => a.action === "RECORD_HUMAN_REVIEW"), JSON.stringify(r));
  assert.ok(r.findings.some((f) => f.issue === "WRONG_ITEM_VERIFIED"));
});
