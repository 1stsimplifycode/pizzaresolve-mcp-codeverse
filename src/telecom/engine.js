// TelecomResolve_Codeverse - deterministic telecom complaint reconciliation and policy engine.
// Pure functions: no I/O, no clock reads (callers pass `now`). The language model never decides
// money movement, complaint categories' timelines or security outcomes; it relays what this returns.
// Operator is FICTIONAL ("CodeVerse Telecom"); all data is synthetic.
import { DECISIONS, s, rupees, hasInjection, maxSeverity } from "../engine.js";

export { DECISIONS, rupees, hasInjection };

export const TPOLICY = Object.freeze({
  CREDIT_GRACE_MIN: 15,          // a captured recharge may take this long to show as credited
  DUPLICATE_WINDOW_MIN: 10,      // two captures of the same plan within this window = duplicate debit
  REFUND_SLA_DAYS: 7,            // refund still processing after this = stale -> human
  SIM_SWAP_HOLD_HOURS: 72,       // recent SIM swap/replacement: block money & porting actions, fraud review
  OUTAGE_ETA_GRACE_MIN: 30,      // known outage past its ETA by this much = complaint
  // Synthetic operator policy targets (days). NOT a statement of TRAI timelines: configure per applicable regulation.
  TARGET_DAYS: { RECHARGE: 1, BILLING: 28, VAS: 1, NETWORK: 7, DATA_SPEED: 7, SPAM_UCC: 7, PORTING: 2, SIM: 1, OTHER: 7 },
});

export const ISSUES = ["RECHARGE_NOT_CREDITED", "CHARGED_TWICE", "WRONG_PLAN", "UNWANTED_VAS", "BILL_DISPUTE", "NO_NETWORK",
  "SLOW_DATA", "REFUND_NOT_RECEIVED", "SIM_ISSUE", "PORT_OUT", "SPAM_CALLS", "WANTS_HUMAN", "OTHER"];
export const CATEGORIES = Object.keys(TPOLICY.TARGET_DAYS);

const up = (v) => s(v).toUpperCase();
const t = (v) => { const ms = Date.parse(s(v)); return Number.isFinite(ms) ? ms : NaN; };
const mins = (a, b) => (a - b) / 60000;
const int = (v) => { const n = parseInt(s(v), 10); return Number.isFinite(n) ? n : NaN; };
const ev = (ref, source, fact) => ({ ref, source, fact });
const SEV = { RESOLVED_VERIFIED: 0, ACTION_PENDING: 1, ACTION_REQUIRED: 2, INSUFFICIENT_EVIDENCE: 3, CONFLICTING_RECORDS: 4, ESCALATION_REQUIRED: 5, SECURITY_BLOCKED: 6 };

// ---------- recharge & payment specialist ----------
export function analyseRecharges({ recharges, services, refunds, ledger, focusTxn, now, available = true }) {
  const out = { findings: [], evidence: [], actions: [] };
  if (!available) { out.findings.push({ d: DECISIONS.INSUFFICIENT_EVIDENCE, code: "BILLING_SYSTEM_UNAVAILABLE", msg: "I can't reach the recharge and billing system right now, so I can't confirm any payment. Nothing has been changed." }); return out; }
  // Replayed gateway webhooks: same gateway_ref counted once.
  const seen = new Map();
  const uniq = [];
  for (const r of recharges) {
    const g = s(r.value.gateway_ref);
    if (g && seen.has(g)) { out.evidence.push(ev(r.key, "recharges", "duplicate notification of " + seen.get(g) + " (same gateway reference) - ignored")); out.findings.push({ d: DECISIONS.RESOLVED_VERIFIED, code: "DUPLICATE_PAYMENT_EVENT_IGNORED", msg: "" }); continue; }
    if (g) seen.set(g, r.key);
    uniq.push(r);
  }
  const scoped = focusTxn ? uniq.filter((r) => r.key === focusTxn || isPartner(r, uniq.find((x) => x.key === focusTxn))) : uniq;
  const credits = services.filter((x) => up(x.value.kind) === "PLAN_CREDIT");
  const captured = scoped.filter((r) => up(r.value.status) === "CAPTURED");
  for (const r of scoped) {
    const st = up(r.value.status), amt = int(r.value.amount_paise), age = mins(now, t(r.value.created_at));
    if (!["CAPTURED", "FAILED", "AUTHORIZED", "REVERSED"].includes(st) || !Number.isFinite(amt) || !Number.isFinite(age)) {
      out.evidence.push(ev(r.key, "recharges", "record unreadable or unknown status '" + st + "'"));
      out.findings.push({ d: DECISIONS.INSUFFICIENT_EVIDENCE, code: "RECHARGE_RECORD_AMBIGUOUS", msg: "The payment record for " + r.key + " is incomplete, so I can't tell what happened to it. I won't guess." });
      continue;
    }
    if (st === "FAILED" || st === "REVERSED") { out.evidence.push(ev(r.key, "recharges", "payment " + st.toLowerCase() + ", " + rupees(amt) + " not taken")); out.findings.push({ d: DECISIONS.RESOLVED_VERIFIED, code: "PAYMENT_NOT_TAKEN", msg: "Payment " + r.key + " did not go through, so no money was taken for it." }); continue; }
    if (st === "AUTHORIZED") { out.evidence.push(ev(r.key, "recharges", "authorised by the bank but never captured")); out.findings.push({ d: DECISIONS.RESOLVED_VERIFIED, code: "PAYMENT_AUTHORIZED_NOT_CAPTURED", msg: "Payment " + r.key + " was only authorised (a temporary hold by your bank); we never captured it. The bank releases such holds on its own timeline." }); continue; }
    // CAPTURED
    const credit = credits.find((c) => s(c.value.txn_id) === r.key);
    const refund = refunds.filter((f) => s(f.value.txn_id) === r.key).sort((a, b) => t(b.value.created_at) - t(a.value.created_at))[0];
    const req = ledger.find((l) => up(l.value.kind) === "REFUND_REQUEST" && s(l.value.txn_id) === r.key);
    out.evidence.push(ev(r.key, "recharges", "captured " + rupees(amt) + " for plan " + s(r.value.plan_code) + ", " + Math.round(age) + " min ago"));
    if (refund) { out.evidence.push(ev(refund.key, "refund_processor", "refund " + up(refund.value.status) + (s(refund.value.processor_ref) ? " ref " + s(refund.value.processor_ref) : ""))); refundFinding(out, refund, r, now); continue; }
    if (req) { out.evidence.push(ev(req.key, "case_ledger", "refund request already on file (" + up(req.value.status) + ")")); out.findings.push({ d: DECISIONS.ACTION_PENDING, code: "REFUND_REQUEST_ON_FILE", msg: "A refund request for " + r.key + " is already on file (" + req.key + ") and is waiting for the refund team; no money has been paid out yet." }); continue; }
    if (credit) {
      out.evidence.push(ev(credit.key, "provisioning", "plan " + s(credit.value.plan_code) + " credited"));
      if (up(credit.value.plan_code) !== up(r.value.plan_code)) {
        out.findings.push({ d: DECISIONS.CONFLICTING_RECORDS, code: "WRONG_PLAN_CREDITED", msg: "You paid for plan " + s(r.value.plan_code) + " but our provisioning system credited plan " + s(credit.value.plan_code) + ". That needs a correction by the provisioning team; I can register a complaint for it." });
        out.actions.push({ action: "REGISTER_COMPLAINT", category: "RECHARGE", reason: "WRONG_PLAN_CREDITED", txn_id: r.key });
        continue;
      }
      // Duplicate debit: another captured recharge for the same plan within the window, uncredited.
      const dup = captured.filter((o) => o.key !== r.key && up(o.value.plan_code) === up(r.value.plan_code) && Math.abs(mins(t(o.value.created_at), t(r.value.created_at))) <= TPOLICY.DUPLICATE_WINDOW_MIN && !credits.some((c) => s(c.value.txn_id) === o.key));
      if (!dup.length) out.findings.push({ d: DECISIONS.RESOLVED_VERIFIED, code: "RECHARGE_CREDITED", msg: "Recharge " + r.key + " for plan " + s(r.value.plan_code) + " was credited to your number." });
      continue;
    }
    const credited = captured.find((o) => o.key !== r.key && up(o.value.plan_code) === up(r.value.plan_code) && Math.abs(mins(t(o.value.created_at), t(r.value.created_at))) <= TPOLICY.DUPLICATE_WINDOW_MIN && credits.some((c) => s(c.value.txn_id) === o.key));
    if (credited) {
      out.findings.push({ d: DECISIONS.ACTION_REQUIRED, code: "DUPLICATE_DEBIT", msg: "You were charged twice for plan " + s(r.value.plan_code) + ": " + credited.key + " was credited and " + r.key + " (" + rupees(amt) + ") is an extra charge. I can raise a refund request for the extra charge only." });
      out.actions.push({ action: "REQUEST_REFUND", txn_id: r.key, amount_paise: amt, reason: "DUPLICATE_DEBIT" });
      continue;
    }
    if (age < TPOLICY.CREDIT_GRACE_MIN) { out.findings.push({ d: DECISIONS.ACTION_PENDING, code: "RECHARGE_CREDIT_PENDING", msg: "Your payment " + r.key + " was received " + Math.round(age) + " minutes ago and the plan isn't showing yet. Credits can take up to " + TPOLICY.CREDIT_GRACE_MIN + " minutes, so please check again shortly. Nothing is wrong yet." }); continue; }
    out.findings.push({ d: DECISIONS.ACTION_REQUIRED, code: "RECHARGE_NOT_CREDITED", msg: "We took " + rupees(amt) + " for recharge " + r.key + " " + Math.round(age) + " minutes ago, but the plan was never credited to your number. I can raise a refund request for the full amount." });
    out.actions.push({ action: "REQUEST_REFUND", txn_id: r.key, amount_paise: amt, reason: "RECHARGE_NOT_CREDITED" });
  }
  return out;
}
function isPartner(r, focus) {
  if (!focus) return false;
  return up(r.value.plan_code) === up(focus.value.plan_code) && s(r.value.account_id) === s(focus.value.account_id) && Math.abs(mins(t(r.value.created_at), t(focus.value.created_at))) <= TPOLICY.DUPLICATE_WINDOW_MIN;
}
function refundFinding(out, f, r, now) {
  const st = up(f.value.status), days = (now - t(f.value.created_at)) / 86400000;
  if (st === "SETTLED" && s(f.value.processor_ref)) out.findings.push({ d: DECISIONS.RESOLVED_VERIFIED, code: "REFUND_SETTLED", msg: "The refund for " + r.key + " was sent by the refund processor, reference " + s(f.value.processor_ref) + ". Banks can take a few working days to show it." });
  else if (st === "SETTLED") out.findings.push({ d: DECISIONS.INSUFFICIENT_EVIDENCE, code: "REFUND_SETTLED_NO_PROOF", msg: "Our records mark the refund for " + r.key + " as sent but there's no processor reference, so I can't confirm it reached you." });
  else if (st === "FAILED") { out.findings.push({ d: DECISIONS.ESCALATION_REQUIRED, code: "REFUND_FAILED", msg: "The refund for " + r.key + " failed at the processor. A person needs to retry it; I can request a callback." }); out.actions.push({ action: "REQUEST_CALLBACK", reason: "REFUND_FAILED" }); }
  else if (days > TPOLICY.REFUND_SLA_DAYS) { out.findings.push({ d: DECISIONS.ESCALATION_REQUIRED, code: "REFUND_STALE", msg: "The refund for " + r.key + " has been processing for " + Math.floor(days) + " days, longer than our " + TPOLICY.REFUND_SLA_DAYS + "-day target. I can request a callback so a person chases it." }); out.actions.push({ action: "REQUEST_CALLBACK", reason: "REFUND_STALE" }); }
  else out.findings.push({ d: DECISIONS.ACTION_PENDING, code: "REFUND_PROCESSING", msg: "The refund for " + r.key + " is being processed (started " + Math.floor(days) + " days ago, target " + TPOLICY.REFUND_SLA_DAYS + " days)." });
}

// ---------- value-added services & billing specialist ----------
export function analyseBilling({ services, ledger, reported, now, available = true }) {
  const out = { findings: [], evidence: [], actions: [] };
  if (!available) { out.findings.push({ d: DECISIONS.INSUFFICIENT_EVIDENCE, code: "BILLING_SYSTEM_UNAVAILABLE", msg: "I can't reach the billing system right now, so I can't check charges. Nothing has been changed." }); return out; }
  const vas = services.filter((x) => up(x.value.kind) === "VAS_CHARGE");
  const consents = services.filter((x) => up(x.value.kind) === "VAS_CONSENT");
  const wantVas = reported.includes("UNWANTED_VAS") || reported.includes("BILL_DISPUTE");
  for (const v of vas) {
    const amt = int(v.value.amount_paise);
    const consent = consents.find((c) => up(c.value.vas_code) === up(v.value.vas_code) && t(c.value.created_at) <= t(v.value.created_at));
    const req = ledger.find((l) => up(l.value.kind) === "REFUND_REQUEST" && s(l.value.txn_id) === v.key);
    out.evidence.push(ev(v.key, "billing", "value-added service " + s(v.value.vas_code) + " charged " + rupees(amt)));
    if (consent) { out.evidence.push(ev(consent.key, "consent_log", "explicit consent recorded via " + s(consent.value.channel) + " on " + s(consent.value.created_at).slice(0, 10))); if (wantVas) out.findings.push({ d: DECISIONS.RESOLVED_VERIFIED, code: "VAS_CONSENT_ON_RECORD", msg: "The " + s(v.value.vas_code) + " charge has a consent record (" + s(consent.value.channel) + ", " + s(consent.value.created_at).slice(0, 10) + "), so it isn't refundable automatically. I can register a complaint if you dispute that consent." }); if (wantVas) out.actions.push({ action: "REGISTER_COMPLAINT", category: "VAS", reason: "CONSENT_DISPUTED" }); continue; }
    if (req) { out.findings.push({ d: DECISIONS.ACTION_PENDING, code: "REFUND_REQUEST_ON_FILE", msg: "A refund request for the " + s(v.value.vas_code) + " charge is already on file (" + req.key + ")." }); continue; }
    out.findings.push({ d: DECISIONS.ACTION_REQUIRED, code: "VAS_WITHOUT_CONSENT", msg: "You were charged " + rupees(amt) + " for " + s(v.value.vas_code) + " and there is no record of you agreeing to it. I can raise a refund request for that charge." });
    out.actions.push({ action: "REQUEST_REFUND", txn_id: v.key, amount_paise: amt, reason: "VAS_WITHOUT_CONSENT" });
  }
  if (reported.includes("BILL_DISPUTE") && !vas.length) { out.findings.push({ d: DECISIONS.ESCALATION_REQUIRED, code: "BILL_DISPUTE_NEEDS_REVIEW", msg: "I can't find an automatically checkable error on your bill, so a billing specialist needs to review it. I can register a billing complaint." }); out.actions.push({ action: "REGISTER_COMPLAINT", category: "BILLING", reason: "BILL_DISPUTE" }); }
  return out;
}

// ---------- network & service specialist ----------
export function analyseNetwork({ subscriber, network, reported, now, available = true }) {
  const out = { findings: [], evidence: [], actions: [] };
  const wantsNet = reported.includes("NO_NETWORK") || reported.includes("SLOW_DATA");
  if (!wantsNet) return out;
  if (!available) { out.findings.push({ d: DECISIONS.INSUFFICIENT_EVIDENCE, code: "NETWORK_STATUS_UNAVAILABLE", msg: "I can't reach the network status system right now. I can still register a network complaint." }); out.actions.push({ action: "REGISTER_COMPLAINT", category: "NETWORK", reason: "STATUS_UNAVAILABLE" }); return out; }
  const pin = s(subscriber.value.postcode);
  const site = network.find((n) => s(n.value.pincode) === pin && up(n.value.status) !== "OK");
  if (site) {
    const eta = t(site.value.eta);
    out.evidence.push(ev(site.key, "network_ops", up(site.value.status) + " in " + pin + " since " + s(site.value.started_at).slice(11, 16) + " UTC, cause: " + s(site.value.cause)));
    if (Number.isFinite(eta) && mins(now, eta) > TPOLICY.OUTAGE_ETA_GRACE_MIN) {
      out.findings.push({ d: DECISIONS.ACTION_REQUIRED, code: "OUTAGE_PAST_ETA", msg: "There is a known network problem in your area (" + s(site.value.cause) + ") and it is past the restoration time the network team estimated. I can register a network complaint so it is tracked." });
      out.actions.push({ action: "REGISTER_COMPLAINT", category: "NETWORK", reason: "OUTAGE_PAST_ETA" });
    } else {
      out.findings.push({ d: DECISIONS.ACTION_PENDING, code: "KNOWN_OUTAGE", msg: "There is a known network problem in your area (" + s(site.value.cause) + "). The network team's estimate for restoration is " + (Number.isFinite(eta) ? s(site.value.eta).slice(11, 16) + " UTC" : "not available yet") + "; that is an estimate, not a promise." });
    }
  } else {
    out.evidence.push(ev("NET-" + pin, "network_ops", "no known outage for " + pin));
    out.findings.push({ d: DECISIONS.ACTION_REQUIRED, code: reported.includes("SLOW_DATA") ? "SLOW_DATA_NO_KNOWN_CAUSE" : "NO_KNOWN_OUTAGE", msg: "Our network status shows no known problem in your area, so this needs a technical check. I can register a network complaint for the network team." });
    out.actions.push({ action: "REGISTER_COMPLAINT", category: reported.includes("SLOW_DATA") ? "DATA_SPEED" : "NETWORK", reason: "NO_KNOWN_OUTAGE" });
  }
  return out;
}

// ---------- security, SIM & porting specialist ----------
export function analyseSecurity({ subscriber, reported, now }) {
  const out = { findings: [], evidence: [], actions: [], simHold: false };
  const swap = t(subscriber.value.sim_swap_at);
  const recent = Number.isFinite(swap) && (now - swap) / 3600000 <= TPOLICY.SIM_SWAP_HOLD_HOURS;
  if (recent) {
    out.simHold = true;
    out.evidence.push(ev(subscriber.key, "sim_registry", "SIM replaced " + Math.round((now - swap) / 3600000) + " hours ago"));
    out.findings.push({ d: DECISIONS.SECURITY_BLOCKED, code: "RECENT_SIM_SWAP", msg: "This number had its SIM replaced recently, so for your protection I can't make payment or porting changes from chat for now. If you didn't ask for a new SIM, please tell me and I'll request an urgent callback from the fraud team." });
    out.actions.push({ action: "REQUEST_CALLBACK", reason: "RECENT_SIM_SWAP" });
  }
  if (reported.includes("SIM_ISSUE") && !recent) { out.findings.push({ d: DECISIONS.ESCALATION_REQUIRED, code: "SIM_ISSUE_NEEDS_PERSON", msg: "SIM replacement or blocking needs identity checks I can't do in chat. I can register a SIM complaint or request a callback; a replacement SIM is only issued after in-person or app verification." }); out.actions.push({ action: "REGISTER_COMPLAINT", category: "SIM", reason: "SIM_ISSUE" }); out.actions.push({ action: "REQUEST_CALLBACK", reason: "SIM_ISSUE" }); }
  if (reported.includes("PORT_OUT")) {
    if (recent) out.findings.push({ d: DECISIONS.SECURITY_BLOCKED, code: "PORT_BLOCKED_AFTER_SIM_SWAP", msg: "Because the SIM was replaced recently, porting is on hold for your protection." });
    else out.findings.push({ d: DECISIONS.RESOLVED_VERIFIED, code: "PORT_OUT_SELF_SERVICE", msg: "I can't generate a porting code in chat. In India the Unique Porting Code is requested by SMS from the number itself (send PORT followed by your number to 1900). I can register a porting complaint if that doesn't work." });
  }
  if (reported.includes("SPAM_CALLS")) { out.findings.push({ d: DECISIONS.ACTION_REQUIRED, code: "SPAM_COMPLAINT", msg: "I can register a complaint about the unwanted calls or messages. You can also set your Do Not Disturb preferences by calling or texting 1909." }); out.actions.push({ action: "REGISTER_COMPLAINT", category: "SPAM_UCC", reason: "UNSOLICITED_COMMERCIAL_COMMUNICATION" }); }
  return out;
}

// ---------- orchestration: combine specialists, most severe finding wins ----------
export function reconcileTelecom({ subscriber, recharges, services, refunds, network, ledger, reported = [], focusTxn = null, now, billingAvailable = true, networkAvailable = true, note = "" }) {
  const parts = [
    analyseSecurity({ subscriber, reported, now }),
    analyseRecharges({ recharges, services, refunds, ledger, focusTxn, now, available: billingAvailable }),
    analyseBilling({ services, ledger, reported, now, available: billingAvailable }),
    analyseNetwork({ subscriber, network, reported, now, available: networkAvailable }),
  ];
  const sec = parts[0];
  let findings = parts.flatMap((p) => p.findings);
  const evidence = parts.flatMap((p) => p.evidence);
  let actions = parts.flatMap((p) => p.actions);
  if (sec.simHold) {   // no money actions during a SIM-swap hold, and no wording that offers one
    actions = actions.filter((a) => a.action !== "REQUEST_REFUND");
    findings = findings.map((f) => ({ ...f, msg: f.msg.replace(/ I can raise a refund request[^.]*\./, " A refund can only be requested after the security check is complete.") }));
  }
  if (reported.includes("REFUND_NOT_RECEIVED") && !findings.some((f) => /^REFUND_/.test(f.code))) findings.push({ d: DECISIONS.INSUFFICIENT_EVIDENCE, code: "NO_REFUND_ON_RECORD", msg: "I can't find a refund on record for this account, so I can't tell you its status." });
  if (reported.includes("WANTS_HUMAN") || reported.includes("OTHER")) actions.push({ action: "REQUEST_CALLBACK", reason: reported.includes("WANTS_HUMAN") ? "CUSTOMER_ASKED_FOR_PERSON" : "OTHER_ISSUE" });
  if (hasInjection(note)) { evidence.push(ev("CHAT", "customer_text", "instruction-like text ignored")); findings.push({ d: DECISIONS.RESOLVED_VERIFIED, code: "UNTRUSTED_TEXT_IGNORED", msg: "" }); }
  const meaningful = findings.filter((f) => f.code !== "DUPLICATE_PAYMENT_EVENT_IGNORED" && f.code !== "UNTRUSTED_TEXT_IGNORED");
  if (!meaningful.length) findings.push({ d: DECISIONS.RESOLVED_VERIFIED, code: "NO_PROBLEM_FOUND", msg: "I checked your recent recharges, charges and refunds and didn't find a problem." });
  // Already-filed complaints and callbacks are reported, not re-authorised.
  const onFile = ledger.filter((l) => ["COMPLAINT", "CALLBACK_REQUEST"].includes(up(l.value.kind)));
  for (const l of onFile) evidence.push(ev(l.key, "case_ledger", up(l.value.kind) + " " + up(l.value.status)));
  actions = dedupeActions(actions).map((a) => {
    if (a.action === "REGISTER_COMPLAINT" && onFile.some((l) => up(l.value.kind) === "COMPLAINT" && up(l.value.category) === a.category)) return { ...a, already_on_file: true };
    if (a.action === "REQUEST_CALLBACK" && onFile.some((l) => up(l.value.kind) === "CALLBACK_REQUEST")) return { ...a, already_on_file: true };
    return a;
  });
  let decision = DECISIONS.RESOLVED_VERIFIED;
  for (const f of findings) decision = maxSeverity(decision, f.d);
  const top = findings.filter((f) => f.msg).sort((a, b) => SEV[b.d] - SEV[a.d]);
  const reason_code = [...new Set(findings.map((f) => f.code))].join("+");
  const customer_message = [...new Set(top.map((f) => f.msg))].join(" ");
  return { decision, reason_code, evidence, authorized_actions: actions, customer_message, policy_basis: "Synthetic CodeVerse Telecom policy (fictional operator). Complaint targets are configurable, not a statement of TRAI timelines." };
}
function dedupeActions(list) {
  const seen = new Set(); const out = [];
  for (const a of list) { const k = a.action + "|" + (a.txn_id || a.category || ""); if (seen.has(k)) continue; seen.add(k); out.push(a); }
  return out;
}
