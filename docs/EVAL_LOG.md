# PizzaResolve_Codeverse — evaluation experiment log (non-regression gate)

Dataset: `NaturalConversation_Codeverse` (108 scripted scenarios, unchanged). Metrics: Guardrails + Instruction Adherence (unchanged, locked by Talkdesk re-run).
Published fallback: **V6** (unchanged). Candidates are V7 draft states. AI_Agent_Codeverse is untouched (read-only reference; it scored 85–88 on this dataset).

| Run (job) | V7 state | Avg | Guardrails | Instr. Adherence (pass/partial/fail) | Decision |
|---|---|---:|---:|---|---|
| PZ_V7_Baseline (33b0605e) | redelivery-first + approval/handover rules (inserted mid-text by an editor cursor bug) | **92.82** | 100 | 86 (60/48/0) | **Best verified baseline** |
| PZ_V7_Fix1 (cd84e4f8) | + "SECURITY REPLIES ARE VERBATIM" block; mid-text inserts relocated to end | 86.15 | 100 | 73 (48/60/0) | **Rejected** |
| PZ_V7_CandB (b37f2e8b) | Fix1 minus the VERBATIM block (= baseline wording, clean order) + server C11/E11 | 92.36 | 100 | 85 (55/53/0) | **Accepted as working baseline** (within run noise of 92.82; regression removed; C11/E11 kept) |
| PZ_V7_CandC (9c4e156b) | CandB + one change: orchestrator RULES #2 rewritten (paraphrase allowed, no extras) | 92.13 | 100 | 84 (58/50/0) | **Rejected** (no gain vs CandB; same lockout partials). Rule 2 restored to CandB text, draft saved 4:35 AM |
| PZ_V7_CandD (79168a24) | CandB + one change: RULES #2 'If it fails or is locked, pass on its message in your own words and share nothing about any order; you may then offer help with anything else.' (removes the contradiction with HOW YOU SOUND's closing question) | **96.18** | 100 | 92 (85/23/0) | **Accepted, new best. Experiments stopped here.** |
| PZ_V8_SpecialistsExecute (68fc2f55) | Live-demo fixes: (1) restored missing seed rows in our PZ_*_Codeverse tables (11 orders, 12 payments, 24 events, 12 order details, FLAT100, 7 zones; insert-only); (2) Refund/Coupons/Order Issues/Delivery instructions rewritten so each runs its own execute tool (execute_refund, apply_coupon_correction, create_replacement_order, create_redelivery_task) instead of stale 'request only / PERSON MUST REVIEW' steps; (3) orchestrator CUSTOMER_LANGUAGE tag + final language check; (4) server ETA shown in IST. Manual tests pass: ORD-8005 replacement, ORD-8004 Rs 698 awaiting approval CASE-ORD-8004, ORD-8009 coupon Rs 159.60, ORD-7092 Kannada, ORD-7091 Hindi, ORD-8002 redelivery, injection blocked | 95.37 | 100 | 91 (80/28/0) | Fixes demo-breaking bugs; -0.81 vs V7, 0 fails. Publish pending user approval. |

**V7 = CandD (96.18) PUBLISHED by user request at 7:45 AM on 4 Nov 2026.** V6 is the previous fallback; V8 is the new empty-change draft. (Previous note: CandB 92.36.) Prompt-only fixes for the lockout-reply pattern have now failed twice; the LLM keeps adding advice/closing after a security block. Next candidate should be structural (e.g. a dedicated Studio/Condition path that sends the tool's message without LLM rewriting), not another prompt rule.

## Root cause of the Fix1 regression (from grader reasoning on failed scenarios)
- Behaviour did not change: after a failed or locked verification the orchestrator still lightly paraphrases the tool message and adds the lockout's own advice.
- The new verbatim rule made the grader judge that unchanged behaviour against a stricter, explicit rule, quoting it as the violated instruction ("SECURITY REPLIES ARE VERBATIM … Add nothing before or after it").
- Lesson: broad exact-wording rules the LLM cannot reliably follow lower Instruction Adherence; security is already enforced by the server (non-disclosing messages, persistent lockout), so it does not need a verbatim prompt rule.

## Remaining partial pattern in the baseline (to fix one at a time)
1. Orchestrator RULES #2 "If it fails, give only its message" vs HOW YOU SOUND ("acknowledge feeling", "ask if there's anything else") — contradictory instructions on the same turn.
2. RULES #4 ("a refund REQUEST is not a completed refund: say 'refund request'") is stale now that refunds are executed.
3. RULES #5 ("never claim a live transfer") contradicts the HUMAN REQUEST handover rule.
