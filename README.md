# PizzaResolve_MCP_Codeverse

Evidence-driven pizza order recovery tools for the **Talkdesk AI Agent Platform** (Team CodeVerse, Talkdesk Hackathon @ PESIT).
Talkdesk is the MCP client; this server is the remote tool layer. **All business data lives in Talkdesk Data Tables** (`PZ_*_Codeverse`, team CodeVerse); this server holds no state.

## Tools (one Talkdesk MCP skill each)
| Tool | Specialist | Writes |
|---|---|---|
| `verify_customer` | Identity & order association (synthetic knowledge-based check: reference + phone last 4 + postcode; lockout after 3 failures / 30 min per reference) | `SESSION`, `VERIFY_ATTEMPT` rows |
| `investigate_order` | Orchestrator: payment + delivery + refund specialists, deterministic reconciliation | none |
| `request_refund` | Payment & refund: policy-authorised, amount set by policy, idempotent (`REFREQ-<payment>` unique key) | `REFUND_REQUEST` row |
| `open_delivery_investigation` | Delivery recovery, idempotent (`INV-<order>`) | `DELIVERY_INVESTIGATION` row |
| `record_human_review` | Human escalation: queues a server-built summary; **no live transfer exists**, and the tool says so | `ESCALATION` row |

Every response carries `data_source` (`TALKDESK_DATA_TABLES` or `LOCAL_MEMORY_SIMULATION`) so simulation can never be mistaken for live execution.

## Run
```
npm ci
npm test                         # 25 local scenario tests (MemoryStore)
node test/live_talkdesk_check.js # live checks against Talkdesk tables (needs credentials)
PZ_STORE=talkdesk MCP_BEARER_TOKEN=... TD_CLIENT_ID=... TD_CLIENT_SECRET=... npm start
```
Endpoint: `POST /mcp` (Streamable HTTP, JSON responses, stateless). Health: `GET /healthz`.
Secrets are environment variables only; never commit them.
