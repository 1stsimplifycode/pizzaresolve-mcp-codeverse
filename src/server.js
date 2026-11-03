// PizzaResolve_MCP_Codeverse - Streamable HTTP MCP server for the Talkdesk AI Agent Platform.
// Stateless: every request builds a fresh MCP server; all durable state lives in Talkdesk Data Tables.
import http from "node:http";
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { PizzaService } from "./service.js";
import { TalkdeskStore, MemoryStore } from "./store.js";
import { seedRows } from "./seed_data.js";
import { loadConfig } from "./config.js";
import { buildTelecomServer } from "./telecom/server_tools.js";
import { portalPage, portalResult } from "./portal.js";

const cfg = loadConfig();
const log = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o })); // no customer PII is ever passed to log()
const store = cfg.mode === "talkdesk" ? new TalkdeskStore(cfg.talkdesk) : new MemoryStore(seedRows());
const service = new PizzaService(store, { log });
const DATA_SOURCE = cfg.mode === "talkdesk" ? "TALKDESK_DATA_TABLES" : "LOCAL_MEMORY_SIMULATION";

const ISSUES = "NOT_RECEIVED, LATE, CHARGED_TWICE, ORDER_MISSING, REFUND_NOT_RECEIVED, WANTS_HUMAN, WRONG_ADDRESS, MISSING_ITEMS, WRONG_ITEMS, OTHER";

function reply(obj) {
  const out = { data_source: DATA_SOURCE, ...obj };
  return { content: [{ type: "text", text: JSON.stringify(out) }] };
}
async function safe(tool, fn) {
  const started = Date.now();
  try { const r = await fn(); log({ tool, ms: Date.now() - started, decision: r.decision || r.outcome || (r.verified ? "VERIFIED" : "") }); return reply(r); }
  catch (e) {
    log({ tool, ms: Date.now() - started, error: String(e && e.message).slice(0, 200) });
    return reply({ decision: "INSUFFICIENT_EVIDENCE", reason_code: "TOOL_ERROR", customer_message: "Something went wrong while checking our systems, so I can't confirm anything right now. Nothing has been changed." });
  }
}

function buildServer() {
  const mcp = new McpServer({ name: "PizzaResolve_MCP_Codeverse", version: "1.0.0" });

  mcp.tool("verify_customer",
    "Identity & order association specialist. ALWAYS call this first, before discussing any order. Checks that the caller owns the order or payment reference using the last 4 digits of the account phone and the delivery postcode. Returns session_id when verified. Enforces lockout after repeated failures. Never reveals whether a reference exists. requester must be 'self' unless the caller says the order belongs to someone else (then pass a short word such as 'brother').",
    { reference: z.string().describe("Order number like ORD-7002 or payment reference like PAY-9001"),
      phone_last4: z.string().describe("Last 4 digits of the phone number on the account"),
      postcode: z.string().describe("Delivery postcode"),
      requester: z.string().optional().describe("'self' if the caller is the account holder, otherwise who they are (e.g. 'brother')"),
      conversation_id: z.string().optional().describe("Platform conversation/interaction id (mapped by Talkdesk, not typed by the caller)") },
    async (a) => safe("verify_customer", () => service.verifyCustomer(a)));

  mcp.tool("investigate_order",
    "Case analysis & orchestration: runs the payment specialist and the delivery specialist over the order, payment, kitchen/courier and refund records and reconciles them. Returns decision (RESOLVED_VERIFIED, ACTION_REQUIRED, ACTION_PENDING, INSUFFICIENT_EVIDENCE, CONFLICTING_RECORDS, ESCALATION_REQUIRED, SECURITY_BLOCKED), reason_code, evidence references, authorized_actions and customer_message. Relay customer_message; never add facts it does not contain. Requires session_id from verify_customer.",
    { session_id: z.string().describe("session_id returned by verify_customer"),
      reference: z.string().describe("Order or payment reference being discussed"),
      reported_issues: z.string().optional().describe("Comma-separated list of what the customer reports, from: " + ISSUES) },
    async (a) => safe("investigate_order", () => service.investigateOrder({ ...a, reported_issues: String(a.reported_issues || "").split(/[,;\s]+/).filter(Boolean) })));

  mcp.tool("request_refund",
    "Payment & refund specialist. Raises an idempotent refund REQUEST only when policy authorised it in investigate_order. The amount is decided by policy, not by you. Repeating the call never creates a second refund. A request is not a completed refund: say only what customer_message says.",
    { session_id: z.string(), reference: z.string().describe("Order or payment reference"),
      payment_id: z.string().optional().describe("Payment id from authorized_actions (e.g. PAY-9004B) when there is more than one") },
    async (a) => safe("request_refund", () => service.requestRefund(a)));

  mcp.tool("open_delivery_investigation",
    "Delivery investigation & recovery specialist. Opens one delivery investigation for an overdue, stalled or disputed delivery when policy allows it. Idempotent. Does not promise a replacement.",
    { session_id: z.string(), reference: z.string().describe("Order reference") },
    async (a) => safe("open_delivery_investigation", () => service.openDeliveryInvestigation(a)));

  mcp.tool("record_human_review",
    "Human escalation specialist. Records the verified case for review by a person, with a server-built summary so the customer need not repeat themselves. There is NO live transfer in this channel: never say you are transferring or connecting the customer. Idempotent per order.",
    { session_id: z.string(), reference: z.string(),
      customer_request: z.string().optional().describe("One short sentence of what the customer wants (no phone numbers or card details)") },
    async (a) => safe("record_human_review", () => service.recordHumanReview(a)));

  // ---------------- multi-agent extension (Supervisor + specialist agents) ----------------
  mcp.tool("get_customer_context",
    "Identity & Context specialist. Signs in a customer who logged in on the PizzaResolve portal (login_code like LC-ABCD2345, single use) OR refreshes the context of an existing session_id. Returns session_id, first name, the customer's own recent orders and open cases. Never returns other customers' data.",
    { login_code: z.string().optional().describe("Login code the customer got from the PizzaResolve login page, e.g. LC-ABCD2345"),
      session_id: z.string().optional().describe("Existing session_id, if already verified") },
    async (a) => safe("get_customer_context", () => service.customerContext(a)));

  mcp.tool("resolve_case",
    "Case coordination for the Supervisor: runs several department specialists for ONE verified order at the same time (PAYMENT, DELIVERY, ORDER_ISSUE, ADDRESS, COUPON, CANCEL, HUMAN), resolves conflicts between them, and returns one plan with action_ids. Call again with confirm_actions (the action_ids the customer agreed to) to execute them safely in order. Relay customer_message only.",
    { session_id: z.string(), reference: z.string().describe("Order or payment reference"),
      departments: z.string().describe("Comma-separated departments or customer issues, e.g. 'PAYMENT,DELIVERY' or 'NOT_RECEIVED,CHARGED_TWICE'"),
      issue_type: z.string().optional().describe("For ORDER_ISSUE: WRONG_ITEM, MISSING_ITEM, WRONG_QUANTITY, DAMAGED, WRONG_CUSTOMISATION, PARTIAL"),
      item: z.string().optional(), new_address_line: z.string().optional(), new_postcode: z.string().optional(), coupon_code: z.string().optional(),
      confirm_actions: z.string().optional().describe("Comma-separated action_ids from the previous plan that the customer explicitly agreed to") },
    async (a) => safe("resolve_case", () => service.resolveCase(a)));

  mcp.tool("report_order_issue",
    "Order Issue specialist: checks a wrong, missing, short, damaged or wrongly customised item against the kitchen pack-scan record, logs the complaint, and (only if verified and the customer chooses) raises an item refund request or a replacement request. Idempotent.",
    { session_id: z.string(), reference: z.string().describe("Order reference"),
      issue_type: z.string().describe("WRONG_ITEM, MISSING_ITEM, WRONG_QUANTITY, DAMAGED, WRONG_CUSTOMISATION or PARTIAL"),
      item: z.string().optional().describe("Item the customer mentions, e.g. 'paneer pizza'"),
      description: z.string().optional().describe("One short sentence from the customer (no phone or card numbers)"),
      remedy: z.string().optional().describe("Leave empty to assess. 'REFUND' or 'REPLACEMENT' only after the customer chose it") },
    async (a) => safe("report_order_issue", () => service.reportOrderIssue(a)));

  mcp.tool("check_address_change",
    "Address Modification specialist: checks whether the delivery address of an order can still change (fulfilment stage, dispatch cutoff, delivery zone, same store) and, only with apply='true' after the customer confirms, changes it with a version check. Never changes an order that has left the restaurant.",
    { session_id: z.string(), reference: z.string().describe("Order reference"),
      new_address_line: z.string().optional(), new_postcode: z.string().optional().describe("6-digit postcode"),
      apply: z.string().optional().describe("'true' only after the customer confirmed the new address; otherwise leave empty") },
    async (a) => safe("check_address_change", () => service.checkAddressChange(a)));

  mcp.tool("check_coupon",
    "Offers & Coupons specialist: validates a coupon against the promotions system (exists, active, expiry, minimum order, eligibility, stacking), recomputes the discount and compares it with the bill. With request_adjustment='true' after the customer agrees, raises one correction request for an under-applied discount. Idempotent.",
    { session_id: z.string(), reference: z.string().describe("Order reference"),
      coupon_code: z.string().optional().describe("Coupon the customer mentions; defaults to the one on the order"),
      request_adjustment: z.string().optional().describe("'true' only after the customer agreed to the correction request") },
    async (a) => safe("check_coupon", () => service.checkCoupon(a)));

  return mcp;
}

function bearerOk(req) {
  if (!cfg.bearer) return true;
  const h = String(req.headers.authorization || "");
  const got = Buffer.from(h.startsWith("Bearer ") ? h.slice(7) : "");
  const want = Buffer.from(cfg.bearer);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// In-memory sliding-window rate limiter (per client address). Durable lockouts live in the ledger.
const hits = new Map();
function rateLimited(key, limit, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((x) => now - x < windowMs);
  arr.push(now); hits.set(key, arr);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
  return arr.length > limit;
}
const clientIp = (req) => String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/portal" || url.pathname === "/portal/login") {
    const sec = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" };
    if (req.method === "GET") { res.writeHead(200, sec); res.end(portalPage()); return; }
    if (req.method !== "POST" || url.pathname !== "/portal/login") { res.writeHead(405).end(); return; }
    if (rateLimited("portal:" + clientIp(req), 10, 60000)) { res.writeHead(429, sec); res.end(portalResult({ ok: false, reason: "RATE_LIMITED" })); return; }
    let body = ""; for await (const c of req) { body += c; if (body.length > 2048) { res.writeHead(413).end(); return; } }
    const f = new URLSearchParams(body);
    const r = await service.portalLogin({ login_id: f.get("login_id"), pin: f.get("pin") }).catch(() => ({ ok: false, reason: "SYSTEM_UNAVAILABLE" }));
    res.writeHead(r.ok ? 200 : 401, sec); res.end(portalResult(r)); return;
  }
  if (url.pathname === "/healthz") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, server: "PizzaResolve_MCP_Codeverse", data_source: DATA_SOURCE, routes: ["/mcp (PizzaResolve)", "/portal (customer login)", "/telecom/mcp (TelecomResolve)"], tools: 10 })); return; }
  const route = url.pathname === "/mcp" ? "pizza" : url.pathname === "/telecom/mcp" ? "telecom" : null;
  if (!route) { res.writeHead(404).end(); return; }
  if (!bearerOk(req)) { log({ http: "401", path: url.pathname }); res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
  if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }).end(); return; }
  if (rateLimited("mcp:" + clientIp(req), 600, 60000)) { log({ http: "429", path: url.pathname }); res.writeHead(429).end(); return; }
  let body = "";
  for await (const c of req) { body += c; if (body.length > 256 * 1024) { res.writeHead(413).end(); return; } }
  let parsed; try { parsed = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
  // Audit trace of every authenticated MCP request (method + tool name only; never arguments).
  for (const m of Array.isArray(parsed) ? parsed : [parsed]) log({ route, rpc: m && m.method, tool: m && m.params && m.params.name, ua: String(req.headers["user-agent"] || "").slice(0, 60) });
  const mcp = route === "telecom" ? buildTelecomServer({ cfg, log }) : buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { transport.close(); mcp.close(); });
  try {
    await mcp.connect(transport);
    await transport.handleRequest(req, res, parsed);
  } catch (e) {
    log({ http: "500", error: String(e && e.message).slice(0, 200) });
    if (!res.headersSent) res.writeHead(500).end();
  }
});

server.listen(cfg.port, () => log({ start: "PizzaResolve_MCP_Codeverse", port: cfg.port, data_source: DATA_SOURCE, auth: cfg.bearer ? "bearer" : "NONE" }));
