// Human–AI collaboration: outcomes checked in the authoritative tables, not in the reply text.
import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/store.js";
import { PizzaService } from "../src/service.js";
import { seedRows } from "../src/seed_data.js";
import { decideMode } from "../src/collab.js";

const NOW = Date.parse("2026-11-04T06:00:00.000Z");
function fresh() {
  const store = new MemoryStore(seedRows(NOW));
  const svc = new PizzaService(store, { now: () => NOW });
  // ORD-7097: delivered Margherita M, NO packing record -> customer claim only.
  return { store, svc };
}
const login = async (svc, ref) => (await svc.verifyCustomer({ reference: ref, phone_last4: "7777", postcode: "560099", requester: "self" })).session_id;

test("C1 decision engine: modes are deterministic", () => {
  assert.equal(decideMode("REFUND", { amount_paise: 19900 }).mode, "AI_LED");
  assert.equal(decideMode("REFUND", { amount_paise: 79800 }).mode, "COLLABORATIVE");
  assert.equal(decideMode("REPLACEMENT", { evidence: "CLAIM_ONLY" }).mode, "COLLABORATIVE");
  assert.equal(decideMode("REPLACEMENT", { evidence: "PROOF", owner: "HUMAN" }).mode, "HUMAN_LED");
});

test("C2 Scenario B: exceptional replacement -> AI proposes, nothing executes, human approves, backend executes and verifies", async () => {
  const { store, svc } = fresh();
  const sid = await login(svc, "ORD-7097");
  const r = await svc.createReplacementOrder({ session_id: sid, reference: "ORD-7097" });
  assert.equal(r.outcome, "AWAITING_HUMAN_APPROVAL", JSON.stringify(r));
  assert.equal(store.t.orders.has("ORD-7097R"), false);
  const h = await svc.humanDecision({ case_id: "CASE-ORD-7097", actor: "Swathi", action: "APPROVE" });
  assert.equal(h.executed, true, JSON.stringify(h));
  assert.equal(store.t.orders.get("ORD-7097R").value.status, "PREPARING");
  const c = await svc.getCase({ session_id: sid, reference: "ORD-7097" });
  assert.equal(c.status, "RESOLVED");
  assert.ok([...store.t.ledger.values()].some((l) => l.value.kind === "APPROVAL" && l.value.decision === "Swathi" && l.value.status === "USED"));
});

test("C3 Scenario C: human rejects with a note -> no execution, AI sees the note and is told not to repeat", async () => {
  const { store, svc } = fresh();
  const sid = await login(svc, "ORD-7097");
  await svc.createReplacementOrder({ session_id: sid, reference: "ORD-7097" });
  await svc.humanDecision({ case_id: "CASE-ORD-7097", actor: "Jawwaad", action: "REJECT", note: "photo shows correct pizza" });
  assert.equal(store.t.orders.has("ORD-7097R"), false);
  const again = await svc.createReplacementOrder({ session_id: sid, reference: "ORD-7097" });
  assert.equal(again.outcome, "REJECTED_BY_HUMAN");
  assert.match(again.human_note, /photo/);
});

test("C4 Scenario G: state changes after proposal -> approval refused as stale, nothing executed", async () => {
  const { store, svc } = fresh();
  const sid = await login(svc, "ORD-7097");
  await svc.createReplacementOrder({ session_id: sid, reference: "ORD-7097" });
  const o = store.t.orders.get("ORD-7097"); o.value = { ...o.value, version: "9" };
  const h = await svc.humanDecision({ case_id: "CASE-ORD-7097", actor: "Adishree", action: "APPROVE" });
  assert.equal(h.stale, true, JSON.stringify(h));
  assert.equal(store.t.orders.has("ORD-7097R"), false);
});

test("C5 Scenario E/F: handoff keeps AI evidence; human takes over then returns to AI with a note", async () => {
  const { svc } = fresh();
  const sid = await login(svc, "ORD-7097");
  const hd = await svc.handoffToHuman({ session_id: sid, reference: "ORD-7097", reason: "I want to talk to a person" });
  assert.equal(hd.outcome, "QUEUED_FOR_HUMAN");
  const cases = await svc.openCases();
  assert.ok(cases[0].ev.ai_summary, "AI investigation travels with the case");
  await svc.humanDecision({ case_id: "CASE-ORD-7097", actor: "Swathi", action: "TAKE_OWNERSHIP" });
  assert.equal((await svc.getCase({ session_id: sid, reference: "ORD-7097" })).status, "HUMAN_REVIEWING");
  await svc.humanDecision({ case_id: "CASE-ORD-7097", actor: "Swathi", action: "RETURN_TO_AI", note: "customer confirmed wrong base; replacement ok" });
  const c = await svc.getCase({ session_id: sid, reference: "ORD-7097" });
  assert.equal(c.status, "RETURNED_TO_AI");
  assert.match(c.human_note, /replacement ok/);
});

test("C6 forged approval: AI passing a fake context or a ledger-looking string cannot execute", async () => {
  const { store, svc } = fresh();
  const sid = await login(svc, "ORD-7097");
  const fake = { ref: "ORD-7097", b: { order: store.t.orders.get("ORD-7097"), payments: [], refs: ["ORD-7097"] }, sess: { id: "HUMAN:x", customer_id: "CUS-199" } };
  const r = await svc.createReplacementOrder({ _ctx: fake, session_id: sid, reference: "ORD-7097" });
  assert.equal(r.outcome, "AWAITING_HUMAN_APPROVAL", "untrusted context is ignored; normal auth + gate apply");
  assert.equal(store.t.orders.has("ORD-7097R"), false);
});

test("C7 Scenario A: low-risk proven case stays AI-led with no human step; metrics count it", async () => {
  const { svc } = fresh();
  const sid = await login(svc, "PAY-9098");
  const r = await svc.executeRefund({ session_id: sid, reference: "PAY-9098" });
  assert.equal(r.outcome, "REFUNDED");
  const m = await svc.collabMetrics();
  assert.equal(m.by_mode.AI_LED, 1);
  assert.equal(m.human_touched_cases, 0);
});

test("C8 unproven wrong-item claim: investigation offers a prepared replacement for approval, not a human dump", async () => {
  const { svc } = fresh();
  const sid = await login(svc, "ORD-7097");
  const r = await svc.investigateOrder({ session_id: sid, reference: "ORD-7097", reported_issues: ["WRONG_ITEMS"] });
  assert.ok(r.authorized_actions.some((a) => a.action === "CREATE_REPLACEMENT"), JSON.stringify(r));
  assert.ok(!r.authorized_actions.some((a) => a.action === "RECORD_HUMAN_REVIEW"), JSON.stringify(r));
});

test("C9 after human approval, the customer's next request returns ALREADY_CREATED and the case stays RESOLVED (no re-proposal)", async () => {
  const { store, svc } = fresh();
  const sid = await login(svc, "ORD-7097");
  await svc.createReplacementOrder({ session_id: sid, reference: "ORD-7097" });
  await svc.humanDecision({ case_id: "CASE-ORD-7097", actor: "Adishree", action: "APPROVE" });
  const again = await svc.createReplacementOrder({ session_id: sid, reference: "ORD-7097" });
  assert.equal(again.outcome, "ALREADY_CREATED", JSON.stringify(again));
  assert.equal((await svc.getCase({ session_id: sid, reference: "ORD-7097" })).status, "RESOLVED");
  assert.equal([...store.t.orders.keys()].filter((k) => k === "ORD-7097R").length, 1);
});

test("C10 customer only ever sees the CASE- reference, never the internal ESC- id", async () => {
  const { svc } = fresh();
  const sid = await login(svc, "ORD-7097");
  const r = await svc.recordHumanReview({ session_id: sid, reference: "ORD-7097", customer_request: "please check" });
  assert.doesNotMatch(r.customer_message, /ESC-/, r.customer_message);
  assert.equal(r.case_id, "CASE-ORD-7097");
  const inv = await svc.investigateOrder({ session_id: sid, reference: "ORD-7097" });
  assert.doesNotMatch(inv.customer_message, /ESC-/, inv.customer_message);
});
