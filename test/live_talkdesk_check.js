// LIVE integration check against the real Talkdesk Data Tables (PZ_*_Codeverse).
// Read-only for demo records; writes ONLY for the reserved live-test customer CUS-199 / ORD-7099.
// Usage: node test/live_talkdesk_check.js    (credentials via .env / oauthclient.json, never printed)
import fs from "node:fs";
import { TalkdeskStore } from "../src/store.js";
import { PizzaService } from "../src/service.js";
import { loadConfig } from "../src/config.js";

process.env.PZ_STORE = "memory";
const cfg = loadConfig().talkdesk;
cfg.clientId = process.env.TD_CLIENT_ID; cfg.clientSecret = process.env.TD_CLIENT_SECRET;
cfg.tableIds = JSON.parse(fs.readFileSync(new URL("../tables.json", import.meta.url), "utf8"));
const store = new TalkdeskStore(cfg);
const svc = new PizzaService(store);
const results = [];
const check = (id, cond, detail) => { results.push({ id, pass: !!cond, detail }); console.log((cond ? "PASS " : "FAIL ") + id + " :: " + detail); };
const t0 = Date.now();

// Read-only scenario checks on demo records
const vs = async (ref, p, pc) => svc.verifyCustomer({ reference: ref, phone_last4: p, postcode: pc, requester: "self" });
const v1 = await vs("PAY-9098", "7777", "560099");
check("L-S1-verify", v1.verified, "verified=" + v1.verified);
const r1 = await svc.investigateOrder({ session_id: v1.session_id, reference: "PAY-9098", reported_issues: ["ORDER_MISSING"] });
check("L-S1-ghost", r1.decision === "ACTION_REQUIRED" && /GHOST_ORDER/.test(r1.reason_code), r1.decision + " " + r1.reason_code);
const v2 = await vs("ORD-7002", "3307", "560034");
const r2 = await svc.investigateOrder({ session_id: v2.session_id, reference: "ORD-7002", reported_issues: ["LATE"] });
check("L-S2-stalled", r2.decision === "ACTION_REQUIRED" && /DELIVERY_STALLED/.test(r2.reason_code), r2.decision + " " + r2.reason_code);
const v3 = await vs("ORD-7003", "6642", "560076");
const r3 = await svc.investigateOrder({ session_id: v3.session_id, reference: "ORD-7003", reported_issues: ["NOT_RECEIVED"] });
check("L-S3-dispute", r3.decision === "CONFLICTING_RECORDS", r3.decision + " " + r3.reason_code);
const x = await svc.investigateOrder({ session_id: v2.session_id, reference: "ORD-7004" });
check("L-S5-cross-customer", x.decision === "SECURITY_BLOCKED" && !/Asha|79800/.test(JSON.stringify(x)), x.reason_code);
const v8 = await vs("ORD-7008", "3307", "560034");
const r8 = await svc.investigateOrder({ session_id: v8.session_id, reference: "ORD-7008" });
check("L-S8-outage", r8.decision === "INSUFFICIENT_EVIDENCE" && /PAYMENT_SYSTEM_UNAVAILABLE/.test(r8.reason_code), r8.decision + " " + r8.reason_code);
const r9 = await svc.investigateOrder({ session_id: (await vs("ORD-7009", "6642", "560076")).session_id, reference: "ORD-7009" });
check("L-A1-injection", r9.flags.some((f) => f.flag === "UNTRUSTED_TEXT_IGNORED") && !/ignore previous/i.test(JSON.stringify(r9)), "flags=" + JSON.stringify(r9.flags));
const r12 = await svc.investigateOrder({ session_id: (await vs("ORD-7012", "1188", "560011")).session_id, reference: "ORD-7012" });
check("L-E-settled", r12.decision === "RESOLVED_VERIFIED", r12.decision);

// Write checks on the reserved test order
const vt = await vs("ORD-7099", "7777", "560099");
const rt = await svc.investigateOrder({ session_id: vt.session_id, reference: "ORD-7099", reported_issues: ["CHARGED_TWICE"] });
check("L-S4-duplicate-detected", rt.authorized_actions.some((a) => a.action === "REQUEST_REFUND" && a.payment_id === "PAY-9099B") || /REFUND_REQUEST_ON_FILE/.test(rt.reason_code), rt.reason_code);
const conc = await Promise.all([1, 2, 3].map(() => svc.requestRefund({ session_id: vt.session_id, reference: "ORD-7099", payment_id: "PAY-9099B" })));
const ledger = await store.list("ledger");
const n = ledger.filter((l) => l.key === "REFREQ-PAY-9099B").length;
check("L-S6-concurrent-one-row", n === 1 && conc.filter((c) => c.outcome === "REQUESTED").length <= 1, "rows=" + n + " outcomes=" + conc.map((c) => c.outcome).join(","));
const esc = await svc.recordHumanReview({ session_id: vt.session_id, reference: "ORD-7099", customer_request: "test" });
check("L-S9-escalation-truthful", ["QUEUED", "ALREADY_QUEUED"].includes(esc.outcome) && esc.live_transfer === "NOT_AVAILABLE", esc.outcome + " " + esc.review_ref);

const passed = results.filter((r) => r.pass).length;
console.log(`\nLIVE Talkdesk check: ${passed}/${results.length} passed in ${((Date.now() - t0) / 1000).toFixed(1)} s at ${new Date().toISOString()}`);
fs.writeFileSync(new URL("../live_check_last.json", import.meta.url), JSON.stringify({ at: new Date().toISOString(), passed, total: results.length, results }, null, 2));
process.exit(passed === results.length ? 0 : 1);
