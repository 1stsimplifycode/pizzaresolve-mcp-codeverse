// Configuration from environment variables only. Secrets are never logged or written to disk by this code.
//   PORT                  default 8787
//   MCP_BEARER_TOKEN      token Talkdesk sends as "Authorization: Bearer ..." (required in talkdesk mode)
//   PZ_STORE              "talkdesk" | "memory" (default memory)
//   TD_CLIENT_ID / TD_CLIENT_SECRET   Talkdesk OAuth client (client credentials, data-tables scopes)
//   TD_TOKEN_URL          default https://pesit-hackathon.talkdeskid.com/oauth/token
//   TD_API_BASE           default https://api.talkdeskapp.com
//   PZ_TABLE_IDS          JSON {"customers":"...","orders":"...",...}  (or tables.json next to package.json)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Local-only conveniences: a gitignored .env next to package.json, and the project's oauthclient.json
// (fields id/secret). Values are loaded into memory only; nothing here prints them.
function loadLocalSecrets() {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const envFile = path.join(root, ".env");
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
  const oauthFile = process.env.PZ_OAUTH_FILE || path.join(root, "..", "..", "oauthclient.json");
  if (!process.env.TD_CLIENT_ID && fs.existsSync(oauthFile)) {
    const j = JSON.parse(fs.readFileSync(oauthFile, "utf8"));
    if (j.id && j.secret) { process.env.TD_CLIENT_ID = j.id; process.env.TD_CLIENT_SECRET = j.secret; }
  }
}

export function loadConfig() {
  loadLocalSecrets();
  const env = process.env;
  const mode = (env.PZ_STORE || "memory").toLowerCase();
  let tableIds = {};
  if (env.PZ_TABLE_IDS) tableIds = JSON.parse(env.PZ_TABLE_IDS);
  else {
    const f = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tables.json");
    if (fs.existsSync(f)) tableIds = JSON.parse(fs.readFileSync(f, "utf8"));
  }
  const cfg = {
    port: Number(env.PORT || 8787),
    bearer: env.MCP_BEARER_TOKEN || "",
    mode,
    talkdesk: {
      clientId: env.TD_CLIENT_ID, clientSecret: env.TD_CLIENT_SECRET,
      tokenUrl: env.TD_TOKEN_URL || "https://pesit-hackathon.talkdeskid.com/oauth/token",
      apiBase: env.TD_API_BASE || "https://api.talkdeskapp.com",
      tableIds,
    },
  };
  if (mode === "talkdesk") {
    const missing = ["clientId", "clientSecret"].filter((k) => !cfg.talkdesk[k]);
    if (missing.length) throw new Error("PZ_STORE=talkdesk needs TD_CLIENT_ID and TD_CLIENT_SECRET");
    if (!cfg.bearer) throw new Error("PZ_STORE=talkdesk requires MCP_BEARER_TOKEN (refusing to expose live data unauthenticated)");
  }
  return cfg;
}
