// PizzaResolve Human–AI collaboration layer (Team CodeVerse).
// - decideMode(): deterministic, auditable choice of AI_LED / COLLABORATIVE / HUMAN_LED. The model cannot override it.
// - Shared case state (ledger row CASE-<ref>) read and written by both AI tools and the human review console.
// - Human approvals (ledger row APR-...) are bound to the exact operation and a hash of the order/payment state at
//   proposal time. Only the review console (reviewer key, signed cookie) can create them; no MCP tool can.
// - An approval triggers execution immediately through the same policy-checked operations, then re-reads the result.
import crypto from "node:crypto";
import { s, rupees, hasInjection } from "./engine.js";
// Strip digit runs (phones, postcodes), emails and instruction-like text before anything reaches shared case state.
const scrub = (txt, n = 300) => { const x = s(txt).replace(/\d[\d\s-]{3,}\d/g, "[digits removed]").replace(/\S+@\S+/g, "[email removed]").slice(0, n); return hasInjection(x) ? "[removed: instruction-like text]" : x; };

const up = (v) => s(v).toUpperCase();
export const TRUSTED = new WeakSet();          // contexts created by the review console after a valid approval
export const AUTO_LIMIT_PAISE = 50000;         // refunds/adjustments above Rs 500 need a human
const OPS = { REFUND: "executeRefund", REPLACEMENT: "createReplacementOrder", REDELIVERY: "createRedeliveryTask", COUPON: "applyCouponCorrection" };
const OP_LABEL = { REFUND: "refund", REPLACEMENT: "free replacement order", REDELIVERY: "priority redelivery", COUPON: "coupon correction and refund of the difference" };

export function decideMode(op, f = {}) {
  const human = [], collab = [];
  if (f.owner === "HUMAN") human.push("a team member has taken ownership of this case");
  if (f.wants_human) human.push("the customer asked for a person");
  if ((f.prior_failures || 0) >= 2) human.push("automation failed twice on this case");
  if (f.conflicts) human.push("the systems disagree about what happened");
  if ((op === "REFUND" || op === "COUPON") && Number(f.amount_paise) > AUTO_LIMIT_PAISE) collab.push("the amount is above the Rs 500 automatic limit");
  if (op === "REPLACEMENT" && f.evidence === "CLAIM_ONLY") collab.push("the kitchen record doesn't prove the wrong item, so it needs a person's judgement");
  if (human.length) return { mode: "HUMAN_LED", reasons: human.concat(collab) };
  if (collab.length) return { mode: "COLLABORATIVE", reasons: collab };
  return { mode: "AI_LED", reasons: ["low-risk operation, eligibility proven by records, within automatic limits"] };
}

const parse = (x, d) => { try { return JSON.parse(s(x)) || d; } catch { return d; } };

export function installCollab(Svc) {
  const P = Svc.prototype;

  P.caseKey = (ctx) => "CASE-" + (ctx.b.order ? ctx.b.order.key : ctx.ref);

  // Fingerprint of the authoritative state an approval relies on. Any change => approval is stale.
  P.stateHash = async function (ctx) {
    const oid = ctx.b.order ? ctx.b.order.key : "";
    const [refunds, det] = await Promise.all([
      this.store.list("refunds").catch(() => []),
      oid ? this.store.getByKey("details", oid).catch(() => null) : null]);
    const o = ctx.b.order ? ctx.b.order.value : {};
    const parts = [oid, up(o.status), s(o.version), s(o.total_paise),
      ...ctx.b.payments.map((p) => p.key + ":" + up(p.value.status) + ":" + s(p.value.amount_paise)).sort(),
      ...refunds.filter((r) => ctx.b.refs.includes(up(r.value.payment_id)) || (oid && s(r.value.order_id) === oid)).map((r) => r.key + ":" + up(r.value.status)).sort(),
      det ? [s(det.value.remedy_status), s(det.value.discount_paise), s(det.value.address_version), s(det.value.packed_items)].join("|") : "nodetails"];
    return crypto.createHash("sha256").update(parts.join("#")).digest("hex").slice(0, 16);
  };

  P.getCaseRow = async function (key) { try { return await this.store.getByKey("ledger", key); } catch { return null; } };

  // Upsert the shared case. `meta` (owner, version, pending op, history) lives in the summary column as JSON.
  P.saveCase = async function (key, ctx, patch, event) {
    const cur = await this.getCaseRow(key);
    const meta = parse(cur && cur.value.summary, { v: 0, owner: "AI", hist: [] });
    Object.assign(meta, patch.meta || {});
    meta.v = (meta.v || 0) + 1;
    if (event) meta.hist = [...(meta.hist || []), { t: this.iso(), ...event }].slice(-10);
    const row = {
      kind: "CASE", ref: ctx ? ctx.ref : s(cur && cur.value.ref), order_id: ctx && ctx.b.order ? ctx.b.order.key : s(cur && cur.value.order_id),
      customer_id: ctx ? ctx.sess.customer_id : s(cur && cur.value.customer_id), session: ctx ? s(ctx.sess.id) : s(cur && cur.value.session),
      created_at: cur ? s(cur.value.created_at) : this.iso(),
      ...(cur ? { status: cur.value.status, decision: cur.value.decision, reason: cur.value.reason, amount_paise: cur.value.amount_paise, evidence: cur.value.evidence, customer_note: cur.value.customer_note } : {}),
      ...patch.fields, summary: JSON.stringify(meta).slice(0, 3800) };
    if (cur) await this.store.update("ledger", key, { ...cur.value, ...row }).catch(() => {});
    else await this.store.create("ledger", key, row).catch(() => {});
    return this.getCaseRow(key);
  };

  // Called by every execution operation right before it changes business state.
  // Returns null to proceed, or a result object (awaiting approval / rejected / stale) to return to the agent.
  P.gate = async function (ctx, op, facts = {}) {
    if (TRUSTED.has(ctx)) return null; // human-approved execution from the review console
    const key = this.caseKey(ctx);
    const cur = await this.getCaseRow(key);
    const meta = parse(cur && cur.value.summary, { owner: "AI", hist: [] });
    const fails = (meta.hist || []).filter((h) => h.op === op && /FAILED|UNKNOWN/.test(s(h.outcome))).length;
    const d = decideMode(op, { ...facts, owner: meta.owner, prior_failures: fails });
    const hash = await this.stateHash(ctx);
    if (d.mode === "AI_LED") {
      await this.saveCase(key, ctx, { fields: { status: "AI_LED_EXECUTING", decision: d.mode, reason: op, amount_paise: String(facts.amount_paise || 0) } }, { by: "AI", op, mode: d.mode });
      return null;
    }
    // A pending approval created by a human for this op (e.g. execution at approval time failed and is being retried).
    const apr = (await this.store.list("ledger")).filter((l) => up(l.value.kind) === "APPROVAL" && s(l.value.ref) === key && s(l.value.reason) === op && up(l.value.status) === "APPROVED")
      .sort((a, b) => s(b.value.created_at).localeCompare(s(a.value.created_at)))[0];
    if (apr) {
      if (s(apr.value.evidence) === hash) { await this.patchRow("ledger", apr.key, { status: "USED" }).catch(() => {}); return null; }
      await this.patchRow("ledger", apr.key, { status: "STALE" }).catch(() => {});
    }
    const rejected = meta.last_decision && meta.last_decision.op === op && meta.last_decision.result === "REJECTED" && meta.last_decision.hash === hash;
    if (rejected) return { action: "GATE", outcome: "REJECTED_BY_HUMAN", case_id: key, human_note: meta.last_decision.note || "",
      customer_message: "A team member reviewed this and decided against the " + OP_LABEL[op] + (meta.last_decision.note ? " (" + meta.last_decision.note + ")" : "") + ". Let me look at the other options with you." };
    const evidence = JSON.stringify({ facts, reasons: d.reasons }).slice(0, 1500);
    await this.saveCase(key, ctx, { fields: { status: "AWAITING_HUMAN_REVIEW", decision: d.mode, reason: op, amount_paise: String(facts.amount_paise || 0), evidence },
      meta: { pending: { op, hash, amount_paise: Number(facts.amount_paise || 0), proposed_at: this.iso() } } }, { by: "AI", op, mode: d.mode, outcome: "PROPOSED" });
    this.log({ tool: "gate", case: key, op, mode: d.mode });
    return { action: "GATE", outcome: "AWAITING_HUMAN_APPROVAL", case_id: key, mode: d.mode, proposed_operation: op, reasons: d.reasons, executed: false,
      customer_message: "I've checked your order and prepared the fix: a " + OP_LABEL[op] + (facts.amount_paise ? " of " + rupees(Number(facts.amount_paise)) : "") + ". Because " + d.reasons[0] + ", a team member has to approve it first. I've sent them everything I found, so you won't need to explain again, and the fix runs automatically the moment they approve. Your case reference is " + key + ". It is not done yet." };
  };

  // ---------- AI-side tools ----------
  P.getCase = async function ({ session_id, reference }) {
    const ctx = await this.authorise(session_id, reference);
    if (ctx.err) return ctx.err;
    const key = this.caseKey(ctx);
    const row = await this.getCaseRow(key);
    if (!row) return { case_id: key, exists: false, customer_message: "There's no open case for this order yet." };
    const meta = parse(row.value.summary, {});
    const last = meta.last_decision;
    const status = up(row.value.status);
    const say = {
      AWAITING_HUMAN_REVIEW: "Your case " + key + " is waiting for a team member's review. Nothing has been changed yet.",
      HUMAN_REVIEWING: "A team member (" + s(meta.owner_name || "our team") + ") is looking at your case " + key + " right now.",
      RETURNED_TO_AI: "A team member reviewed your case and handed it back to me" + (s(row.value.customer_note) ? " with this note: " + s(row.value.customer_note) : "") + ".",
      RESOLVED: "Your case " + key + " is resolved" + (last && last.message ? ": " + last.message : "."),
      PARTIAL: "Part of the fix for case " + key + " is done but not all of it" + (last && last.message ? ": " + last.message : "."),
      FAILED: "The approved fix for case " + key + " couldn't be completed by the system yet. Nothing was charged or changed twice.",
      REJECTED: "A team member decided against the proposed fix for case " + key + (s(row.value.customer_note) ? " (" + s(row.value.customer_note) + ")" : "") + ".",
    }[status] || "Your case " + key + " is in progress (" + status.toLowerCase().replace(/_/g, " ") + ").";
    return { case_id: key, status, mode: s(row.value.decision), owner: meta.owner || "AI", owner_name: meta.owner_name || null, pending_operation: meta.pending || null,
      human_note: s(row.value.customer_note) || null, last_decision: last || null, history: meta.hist || [], customer_message: say,
      next_step_for_ai: status === "RETURNED_TO_AI" ? "Follow the human note, re-run the relevant specialist check, and execute only if the tool allows it." : null };
  };

  P.handoffToHuman = async function ({ session_id, reference, reason = "" }) {
    const ctx = await this.authorise(session_id, reference);
    if (ctx.err) return ctx.err;
    const key = this.caseKey(ctx);
    let inv = null; try { inv = await this.evaluate(ctx, ["WANTS_HUMAN"]); } catch { /* evidence best effort */ }
    const evidence = JSON.stringify({ customer_reason: scrub(reason), decision: inv && inv.decision, reason_code: inv && inv.reason_code, ai_summary: inv && s(inv.customer_message).slice(0, 700), authorized_actions: inv && inv.authorized_actions }).slice(0, 1500);
    await this.saveCase(key, ctx, { fields: { status: "AWAITING_HUMAN_REVIEW", decision: "HUMAN_LED", evidence, reason: "HUMAN_LED" }, meta: { owner: "HUMAN", pending: null } }, { by: "AI", op: "HANDOFF", outcome: "WAITING_FOR_HUMAN" });
    return { action: "HANDOFF_TO_HUMAN", outcome: "QUEUED_FOR_HUMAN", case_id: key, ai_remains_copilot: true,
      customer_message: "I've passed your case to our team with everything I've already checked, so you won't have to repeat yourself. Your case reference is " + key + ". I can't promise exactly when someone will pick it up, but I'll stay on the case with them and can tell you the status any time." };
  };

  // The legacy escalation tool now also opens the shared Human–AI case, so the human gets the AI's evidence.
  const legacyEsc = P.recordHumanReview;
  P.recordHumanReview = async function (a) {
    const r = await legacyEsc.call(this, a);
    if (r && !r.err && r.decision !== "SECURITY_BLOCKED" && r.reason_code !== "NOT_VERIFIED") {
      try {
        const h = await this.handoffToHuman({ session_id: a.session_id, reference: a.reference, reason: a.customer_request });
        if (h.case_id) {
          // One reference for the customer: the shared case id (the internal ESC- row is an audit detail).
          if (r.customer_message) r.customer_message = s(r.customer_message).replace(/ESC-[A-Z]+-[0-9A-Z]+/g, h.case_id);
          r.internal_escalation_ref = r.reference || r.escalation_id || null;
          r.case_id = h.case_id; r.reference_for_customer = h.case_id;
        }
        r.ai_remains_copilot = true;
      } catch { /* legacy result still valid */ }
    }
    return r;
  };

  // ---------- Human-side (review console only) ----------
  P.openCases = async function () {
    const rows = (await this.store.list("ledger")).filter((l) => up(l.value.kind) === "CASE");
    return rows.map((r) => ({ key: r.key, ...r.value, meta: parse(r.value.summary, {}), ev: parse(r.value.evidence, {}) }))
      .sort((a, b) => s(b.meta.hist && b.meta.hist.length ? b.meta.hist[b.meta.hist.length - 1].t : b.created_at).localeCompare(s(a.meta.hist && a.meta.hist.length ? a.meta.hist[a.meta.hist.length - 1].t : a.created_at)));
  };

  // Build a context for a case without a customer session; only reachable from the authenticated console.
  P.systemCtx = async function (caseRow, actor) {
    const b = await this.bundle(s(caseRow.value.ref));
    if (!b || !b.customerIds.includes(s(caseRow.value.customer_id)) || b.customerIds.length !== 1) return null;
    const ctx = { ref: s(caseRow.value.ref), b, ledger: await this.store.list("ledger"), sess: { id: "HUMAN:" + actor, customer_id: s(caseRow.value.customer_id) } };
    TRUSTED.add(ctx);
    return ctx;
  };

  P.humanDecision = async function ({ case_id, actor, action, op = "", note = "" }) {
    actor = s(actor).replace(/[^A-Za-z0-9 ._-]/g, "").slice(0, 40);
    note = scrub(note).replace(/[<>]/g, "");
    if (!actor) return { ok: false, error: "Enter your name so the decision is attributed." };
    const row = await this.getCaseRow(case_id);
    if (!row || up(row.value.kind) !== "CASE") return { ok: false, error: "Case not found." };
    const meta = parse(row.value.summary, {});
    const ctx = await this.systemCtx(row, actor);
    if (!ctx) return { ok: false, error: "The order's ownership could not be confirmed, so nothing was done." };
    const hash = await this.stateHash(ctx);
    const fb = async (category) => { try { await this.store.create("ledger", "FB-" + case_id + "-" + Date.now().toString(36).toUpperCase(), { kind: "HUMAN_FEEDBACK", ref: case_id, status: category, reason: s(meta.pending && meta.pending.op) || s(row.value.reason), decision: actor, customer_note: note, created_at: this.iso() }); } catch { /* feedback best effort */ } };
    const plain = (status, extra = {}, event = {}) => this.saveCase(case_id, ctx, { fields: { status, customer_note: note || s(row.value.customer_note), ...extra.fields }, meta: extra.meta }, { by: "HUMAN:" + actor, ...event });

    if (action === "TAKE_OWNERSHIP") { await plain("HUMAN_REVIEWING", { meta: { owner: "HUMAN", owner_name: actor } }, { op: "OWNERSHIP" }); await fb("TOOK_OVER"); return { ok: true, message: "You own case " + case_id + ". AI stays available as copilot." }; }
    if (action === "RETURN_TO_AI" || action === "REQUEST_EVIDENCE") {
      await plain("RETURNED_TO_AI", { meta: { owner: "AI", owner_name: null } }, { op: action });
      await fb(action === "REQUEST_EVIDENCE" ? "NEEDS_MORE_EVIDENCE" : "RETURNED_TO_AI");
      return { ok: true, message: "Case returned to AI with your note. The agent will pick it up next time the customer is in touch (it reads your note through get_case)." };
    }
    if (action === "REJECT") {
      await plain("REJECTED", { meta: { pending: null, last_decision: { op: s(meta.pending && meta.pending.op), result: "REJECTED", note, hash, by: actor, t: this.iso() } } }, { op: s(meta.pending && meta.pending.op), outcome: "REJECTED" });
      await fb("REJECTED_AI_RECOMMENDATION");
      return { ok: true, message: "Rejected. Nothing was executed." };
    }
    if (action !== "APPROVE") return { ok: false, error: "Unknown action." };
    const pending = meta.pending;
    const chosen = up(op) || (pending && pending.op);
    if (!OPS[chosen]) return { ok: false, error: "Choose an operation to approve." };
    // Stale-approval protection: the state must be exactly what the AI's proposal was based on.
    if (pending && pending.op === chosen && pending.hash !== hash) {
      await plain("RETURNED_TO_AI", { meta: { pending: null } }, { op: chosen, outcome: "STALE_APPROVAL_REJECTED" });
      await fb("STALE_APPROVAL_PREVENTED");
      return { ok: false, stale: true, error: "The order or payment changed after the AI prepared this proposal, so the approval was refused and nothing was executed. The case went back to AI for re-validation." };
    }
    const aprKey = "APR-" + case_id + "-" + chosen + "-" + Date.now().toString(36).toUpperCase();
    await this.store.create("ledger", aprKey, { kind: "APPROVAL", ref: case_id, reason: chosen, status: "APPROVED", decision: actor, evidence: hash, amount_paise: String((pending && pending.amount_paise) || 0), customer_note: note, created_at: this.iso() });
    await plain("EXECUTING", {}, { op: chosen, outcome: "APPROVED" });
    let res; try { res = await this[OPS[chosen]]({ _ctx: ctx, session_id: "", reference: ctx.ref }); } catch (e) { res = { outcome: "FAILED", customer_message: "System error during execution." }; }
    const okOut = /^(REFUNDED|ALREADY_REFUNDED|CREATED|ALREADY_CREATED|ASSIGNED|ALREADY_ASSIGNED|APPLIED)$/.test(s(res.outcome));
    const status = okOut ? "RESOLVED" : /PARTIAL/.test(s(res.outcome)) ? "PARTIAL" : "FAILED";
    await this.patchRow("ledger", aprKey, { status: okOut ? "USED" : "APPROVED" }).catch(() => {});
    await plain(status, { meta: { pending: null, owner: "AI", last_decision: { op: chosen, result: "APPROVED", outcome: res.outcome, message: s(res.customer_message).slice(0, 400), by: actor, t: this.iso() } } }, { op: chosen, outcome: s(res.outcome) });
    await fb(pending && pending.op && pending.op !== chosen ? "ALTERNATIVE_REMEDY" : "APPROVED_AS_PROPOSED");
    return { ok: okOut, executed: true, outcome: res.outcome, message: s(res.customer_message), result: res };
  };

  // Collaboration metrics computed from the real ledger (no invented numbers).
  P.collabMetrics = async function () {
    const L = await this.store.list("ledger");
    const cases = L.filter((l) => up(l.value.kind) === "CASE").map((c) => ({ ...c.value, meta: parse(c.value.summary, {}) }));
    const fb = L.filter((l) => up(l.value.kind) === "HUMAN_FEEDBACK");
    const count = (f) => cases.filter(f).length;
    const humanTouched = (c) => (c.meta.hist || []).some((h) => s(h.by).startsWith("HUMAN"));
    const resolved = (c) => up(c.status) === "RESOLVED" || (c.meta.hist || []).some((h) => /^(REFUNDED|ALREADY_REFUNDED|CREATED|ALREADY_CREATED|ASSIGNED|ALREADY_ASSIGNED|APPLIED)$/.test(s(h.outcome)));
    const fcount = (k) => fb.filter((x) => up(x.value.status) === k).length;
    const props = fb.filter((x) => /APPROVED_AS_PROPOSED|REJECTED_AI_RECOMMENDATION|ALTERNATIVE_REMEDY/.test(up(x.value.status))).length;
    return {
      cases: cases.length,
      by_mode: { AI_LED: count((c) => up(c.decision) === "AI_LED"), COLLABORATIVE: count((c) => up(c.decision) === "COLLABORATIVE"), HUMAN_LED: count((c) => up(c.decision) === "HUMAN_LED") },
      awaiting_human: count((c) => up(c.status) === "AWAITING_HUMAN_REVIEW"),
      ai_only_cases: count((c) => !humanTouched(c)), human_touched_cases: count(humanTouched),
      approved_as_proposed: fcount("APPROVED_AS_PROPOSED"), rejected_ai_recommendation: fcount("REJECTED_AI_RECOMMENDATION"), alternative_remedy: fcount("ALTERNATIVE_REMEDY"),
      more_evidence_requested: fcount("NEEDS_MORE_EVIDENCE"), human_takeovers: fcount("TOOK_OVER"), stale_approvals_prevented: fcount("STALE_APPROVAL_PREVENTED"),
      ai_recommendation_acceptance_rate: props ? Math.round((fcount("APPROVED_AS_PROPOSED") / props) * 100) + "%" : "n/a (no reviewed proposals yet)",
      cases_with_executed_fix: count(resolved),
    };
  };
}
