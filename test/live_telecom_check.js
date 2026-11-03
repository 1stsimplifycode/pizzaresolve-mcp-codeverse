// Live check of TelecomResolve against the real TC_*_Codeverse Talkdesk Data Tables.
// Writes ONLY to the reserved test account ACC-50009. Never prints secrets.
import { loadConfig } from "../src/config.js";
import { TalkdeskStore } from "../src/store.js";
import { TelecomService } from "../src/telecom/service.js";
import { telecomTableIds } from "../src/telecom/server_tools.js";

process.env.PZ_STORE = process.env.PZ_STORE || "talkdesk";
const cfg = loadConfig();
const store = new TalkdeskStore({ ...cfg.talkdesk, tableIds: telecomTableIds() });
const svc = new TelecomService(store);
const results = [];
const check = (name, ok, info = "") => { results.push(ok); console.log((ok ? "PASS " : "FAIL ") + name + (info ? "  (" + info + ")" : "")); };
const t0 = Date.now();

const v = await svc.verifySubscriber({ reference: "ACC-50009", mobile_last4: "7777", pincode: "560099" });
check("L1 verify test subscriber", v.verified === true);
const sid = v.session_id;
const inv = await svc.investigateComplaint({ session_id: sid, reference: "ACC-50009", reported_issues: ["RECHARGE_NOT_CREDITED"] });
check("L2 investigate reads live tables", /RECHARGE_NOT_CREDITED|REFUND_REQUEST_ON_FILE/.test(inv.reason_code), inv.decision);
const par = await Promise.all([1, 2, 3].map(() => svc.requestRefund({ session_id: sid, reference: "ACC-50009", txn_id: "TXN-7099" })));
const rows = (await store.list("ledger")).filter((r) => r.key === "REFREQ-TXN-7099");
check("L3 three concurrent refund requests -> exactly one ledger row", rows.length === 1, par.map((p) => p.outcome).join(","));
const again = await svc.requestRefund({ session_id: sid, reference: "ACC-50009", txn_id: "TXN-7099" });
check("L4 repeat refund is deduplicated", again.outcome === "ALREADY_REQUESTED");
const c1 = await svc.registerComplaint({ session_id: sid, reference: "ACC-50009", category: "OTHER", summary: "live check" });
const c2 = await svc.registerComplaint({ session_id: sid, reference: "ACC-50009", category: "OTHER" });
check("L5 complaint docket idempotent", c1.docket_number === "CMP-50009-OTHER" && c2.outcome === "ALREADY_REGISTERED", c1.outcome + "/" + c2.outcome);
const cb = await svc.requestCallback({ session_id: sid, reference: "ACC-50009", reason: "live check" });
check("L6 callback recorded, no live transfer claimed", ["QUEUED", "ALREADY_REQUESTED"].includes(cb.outcome) && cb.live_transfer === "NOT_AVAILABLE");
const x = await svc.investigateComplaint({ session_id: sid, reference: "ACC-50001" });
check("L7 cross-account blocked", x.reason_code === "REFERENCE_NOT_IN_VERIFIED_ACCOUNT");
const bad = await svc.verifySubscriber({ reference: "ACC-59999", mobile_last4: "1234", pincode: "560099" });
check("L8 unknown account gets non-disclosing reply", bad.verified === false && /couldn't verify/.test(bad.customer_message));
console.log(`LIVE telecom check: ${results.filter(Boolean).length}/${results.length} passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(results.every(Boolean) ? 0 : 1);
