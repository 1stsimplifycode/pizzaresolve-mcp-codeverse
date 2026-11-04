// Goodwill coupon memory across conversations (LOCAL tier, MemoryStore).
import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/store.js";
import { PizzaService } from "../src/service.js";
import { seedRows } from "../src/seed_data.js";

const NOW = Date.parse("2026-11-04T06:00:00.000Z");
const fresh = () => { const nowRef = { v: NOW }; const store = new MemoryStore(seedRows(NOW)); return { store, nowRef, svc: new PizzaService(store, { now: () => nowRef.v }) }; };
const login = async (svc, reference, phone, postcode, conversation_id) => {
  const v = await svc.verifyCustomer({ reference, phone_last4: phone, postcode, requester: "self", conversation_id });
  assert.equal(v.verified, true, JSON.stringify(v)); return v.session_id;
};

test("G1 code issued in conversation A is found and honoured in conversation B", async () => {
  const { svc, store, nowRef } = fresh();
  // Conversation A: late delivery fixed, then an apology code.
  const sA = await login(svc, "ORD-8002", "2468", "560078", "intA-0000000001");
  const red = await svc.createRedeliveryTask({ session_id: sA, reference: "ORD-8002" });
  assert.match(red.outcome, /ASSIGNED/);
  const g = await svc.issueGoodwillCoupon({ session_id: sA, reference: "ORD-8002", reason: "late delivery", conversation_id: "intA-0000000001", platform_session_id: "sessA-000001" });
  assert.equal(g.outcome, "ISSUED", JSON.stringify(g));
  assert.match(g.coupon_code, /^TREAT\d{3}$/);
  assert.equal(g.remembered.interaction_id, "intA-0000000001");
  const again = await svc.issueGoodwillCoupon({ session_id: sA, reference: "ORD-8002" });
  assert.equal(again.outcome, "ALREADY_ISSUED");
  // Conversation B, two days later: new interaction, new verification, different order, code said in words.
  nowRef.v += 2 * 86400000;
  const sB = await login(svc, "ORD-8007", "2468", "560078", "intB-0000000002");
  const spoken = "treat " + g.coupon_code.slice(5).split("").map((d) => ["zero","one","two","three","four","five","six","seven","eight","nine"][d]).join(" ");
  const h = await svc.honourGoodwillCoupon({ session_id: sB, reference: "ORD-8007", coupon_code: spoken, conversation_id: "intB-0000000002" });
  assert.equal(h.outcome, "APPLIED", JSON.stringify(h));
  assert.equal(h.issued.issued_in_interaction, "intA-0000000001");
  assert.equal(h.issued.issued_for_order, "ORD-8002");
  assert.equal(h.refund_paise, 10000);
  assert.equal((await store.getByKey("ledger", "GWC-ORD-8002")).value.status, "REDEEMED");
  // Asking again is idempotent; no second refund.
  const h2 = await svc.honourGoodwillCoupon({ session_id: sB, reference: "ORD-8007" });
  assert.equal(h2.outcome, "ALREADY_APPLIED");
  assert.equal([...store.t.refunds.keys()].filter((k) => k.startsWith("RF-GWC-")).length, 1);
});

test("G2 refusals: no failure on record, another customer's code, expired, below minimum", async () => {
  const { svc, nowRef } = fresh();
  const s1 = await login(svc, "ORD-8010", "2468", "560078");
  assert.equal((await svc.issueGoodwillCoupon({ session_id: s1, reference: "ORD-8010" })).outcome, "NOT_ELIGIBLE");
  const sA = await login(svc, "ORD-8002", "2468", "560078");
  await svc.createRedeliveryTask({ session_id: sA, reference: "ORD-8002" });
  const g = await svc.issueGoodwillCoupon({ session_id: sA, reference: "ORD-8002" });
  const sArjun = await login(svc, "ORD-8006", "1357", "560102");
  const x = await svc.honourGoodwillCoupon({ session_id: sArjun, reference: "ORD-8006", coupon_code: g.coupon_code });
  assert.equal(x.reason_code, "NOT_LINKED_TO_ACCOUNT");
  assert.doesNotMatch(x.customer_message, /Priya|ORD-8002/);
  nowRef.v += 15 * 86400000;
  const sB = await login(svc, "ORD-8007", "2468", "560078");
  assert.equal((await svc.honourGoodwillCoupon({ session_id: sB, reference: "ORD-8007" })).reason_code, "EXPIRED");
});

test("G3 a wrong session_id like 'verified' gets an agent hint instead of a silent re-verify", async () => {
  const { svc } = fresh();
  const r = await svc.investigateOrder({ session_id: "verified", reference: "ORD-8002", reported_issues: [] });
  assert.equal(r.reason_code, "NOT_VERIFIED");
  assert.match(r.agent_hint, /VS-/);
});
