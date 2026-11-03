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
import { chatPage } from "./chat_page.js";

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

  return mcp;
}

function bearerOk(req) {
  if (!cfg.bearer) return true;
  const h = String(req.headers.authorization || "");
  const got = Buffer.from(h.startsWith("Bearer ") ? h.slice(7) : "");
  const want = Buffer.from(cfg.bearer);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/" || url.pathname === "/chat") { if (req.method !== "GET") { res.writeHead(405).end(); return; } res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); res.end(chatPage()); return; }
  if (url.pathname === "/healthz") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, server: "PizzaResolve_MCP_Codeverse", data_source: DATA_SOURCE, routes: ["/mcp (PizzaResolve)", "/chat (customer chat widget)", "/telecom/mcp (TelecomResolve)"] })); return; }
  const route = url.pathname === "/mcp" ? "pizza" : url.pathname === "/telecom/mcp" ? "telecom" : null;
  if (!route) { res.writeHead(404).end(); return; }
  if (!bearerOk(req)) { log({ http: "401", path: url.pathname }); res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
  if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }).end(); return; }
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
