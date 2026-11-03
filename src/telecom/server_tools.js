// TelecomResolve_Codeverse MCP tool definitions (served at /telecom/mcp by src/server.js).
// Tool descriptions stay under 300 characters (Talkdesk skill description limit).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TelecomService } from "./service.js";
import { telecomSeedRows } from "./seed_data.js";
import { TalkdeskStore, MemoryStore } from "../store.js";
import { ISSUES, CATEGORIES } from "./engine.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export function telecomTableIds() {
  if (process.env.TC_TABLE_IDS) return JSON.parse(process.env.TC_TABLE_IDS);
  const f = path.join(here, "..", "..", "tables_telecom.json");
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
}

let service = null, dataSource = "";
function getService(cfg, log) {
  if (service) return service;
  const live = cfg.mode === "talkdesk";
  const store = live ? new TalkdeskStore({ ...cfg.talkdesk, tableIds: telecomTableIds() }) : new MemoryStore(telecomSeedRows());
  dataSource = live ? "TALKDESK_DATA_TABLES" : "LOCAL_MEMORY_SIMULATION";
  service = new TelecomService(store, { log });
  return service;
}

export function buildTelecomServer({ cfg, log }) {
  const svc = getService(cfg, log);
  const reply = (o) => ({ content: [{ type: "text", text: JSON.stringify({ data_source: dataSource, operator: "CodeVerse Telecom (fictional)", ...o }) }] });
  const safe = async (tool, fn) => {
    const started = Date.now();
    try { const r = await fn(); log({ route: "telecom", tool, ms: Date.now() - started, decision: r.decision || r.outcome || (r.verified ? "VERIFIED" : "") }); return reply(r); }
    catch (e) { log({ route: "telecom", tool, ms: Date.now() - started, error: String(e && e.message).slice(0, 200) }); return reply({ decision: "INSUFFICIENT_EVIDENCE", reason_code: "TOOL_ERROR", customer_message: "Something went wrong while checking our systems, so I can't confirm anything right now. Nothing has been changed." }); }
  };
  const mcp = new McpServer({ name: "TelecomResolve_MCP_Codeverse", version: "1.0.0" });

  mcp.tool("verify_subscriber",
    "ALWAYS call first. Verifies the caller owns the account (ACC-50001) or recharge (TXN-7001) using mobile last 4 and PIN code. Returns session_id. Locks after repeated failures. requester='self' unless the caller says it's someone else's.",
    { reference: z.string().describe("Account number like ACC-50001 or transaction ID like TXN-7001"),
      mobile_last4: z.string().describe("Last 4 digits of the mobile number on the account"),
      pincode: z.string().describe("PIN code on the account"),
      requester: z.string().optional().describe("'self' if the account holder, otherwise who they are (e.g. 'brother')"),
      conversation_id: z.string().optional().describe("Platform interaction id (not typed by the caller)") },
    async (a) => safe("verify_subscriber", () => svc.verifySubscriber(a)));

  mcp.tool("investigate_complaint",
    "Checks recharge payments, plan credits, value-added-service consent, bills, refunds, network status and SIM security together. Returns decision, evidence, authorized_actions and customer_message. Relay customer_message only. Needs session_id.",
    { session_id: z.string(), reference: z.string().describe("Account or transaction being discussed"),
      reported_issues: z.string().optional().describe("Comma-separated, from: " + ISSUES.join(", ")),
      customer_text: z.string().optional().describe("The customer's own words, for safety screening only") },
    async (a) => safe("investigate_complaint", () => svc.investigateComplaint({ ...a, reported_issues: String(a.reported_issues || "").split(/[,;\s]+/).filter(Boolean) })));

  mcp.tool("request_refund",
    "Raises an idempotent refund REQUEST only for a charge investigate_complaint authorised; amount set by policy. Never creates a second request. A request is not a completed refund: say only what customer_message says.",
    { session_id: z.string(), reference: z.string(), txn_id: z.string().optional().describe("Charge id from authorized_actions (e.g. TXN-7002B or VAS-8001)") },
    async (a) => safe("request_refund", () => svc.requestRefund(a)));

  mcp.tool("register_complaint",
    "Registers a complaint and returns a docket number and target date. Any verified customer may register one. One open docket per category; repeats return the same docket. Categories: " + CATEGORIES.join(", ") + ".",
    { session_id: z.string(), reference: z.string(), category: z.string().describe("One of: " + CATEGORIES.join(", ")),
      summary: z.string().optional().describe("One short sentence of the complaint (no card or phone numbers)") },
    async (a) => safe("register_complaint", () => svc.registerComplaint(a)));

  mcp.tool("request_callback",
    "Requests a callback from a person with a server-built case summary (urgent for fraud/SIM-swap). There is NO live transfer in this chat: never say you are transferring. Idempotent per account.",
    { session_id: z.string(), reference: z.string(), reason: z.string().optional().describe("One short sentence of why (no card or phone numbers)") },
    async (a) => safe("request_callback", () => svc.requestCallback(a)));

  return mcp;
}
