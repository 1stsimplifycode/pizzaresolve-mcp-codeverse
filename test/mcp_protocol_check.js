// End-to-end protocol check with the official MCP client over Streamable HTTP.
// Usage: node test/mcp_protocol_check.js <url> [bearer]
// Never prints the bearer token.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.argv[2] || "http://localhost:8787/mcp";
const bearer = process.argv[3] || process.env.MCP_BEARER_TOKEN || "";
const headers = bearer ? { Authorization: "Bearer " + bearer } : {};
const client = new Client({ name: "codeverse-protocol-check", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));
const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
const v = await call("verify_customer", { reference: "ORD-7099", phone_last4: "7777", postcode: "560099", requester: "self" });
console.log("verify:", v.verified, v.data_source);
const inv = await call("investigate_order", { session_id: v.session_id, reference: "ORD-7099", reported_issues: "CHARGED_TWICE" });
console.log("investigate:", inv.decision, inv.reason_code, JSON.stringify(inv.authorized_actions));
const r1 = await call("request_refund", { session_id: v.session_id, reference: "ORD-7099", payment_id: "PAY-9099B" });
const r2 = await call("request_refund", { session_id: v.session_id, reference: "ORD-7099", payment_id: "PAY-9099B" });
console.log("refund #1:", r1.outcome, r1.request_ref, "| refund #2:", r2.outcome, "duplicate_prevented=" + r2.duplicate_prevented);
await client.close();
