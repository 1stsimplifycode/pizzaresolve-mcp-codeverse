// Creates the PizzaResolve tables in Talkdesk Data Tables (team CodeVerse only) and seeds synthetic rows.
// Idempotent: existing tables (tables.json) are reused; existing row keys (409) are left untouched.
//   node src/seed.js --inspect        read-only: print the schema shape of the existing CRM_Codeverse table
//   node src/seed.js --create         create missing tables, write ids to tables.json
//   node src/seed.js --rows           insert missing seed rows
//   node src/seed.js --refresh-times  PUT fresh relative timestamps into existing seed rows (never touches the ledger)
// Credentials come from TD_CLIENT_ID / TD_CLIENT_SECRET env vars; nothing secret is printed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TalkdeskStore } from "./store.js";
import { seedRows, COLUMNS, TABLE_NAMES } from "./seed_data.js";
import { loadConfig } from "./config.js";

const REFERENCE_TABLE = "6ae61ca0134c9b1ff90d84ac"; // CRM_Codeverse (team CodeVerse), used only to copy schema shape + team id
const here = path.dirname(fileURLToPath(import.meta.url));
const tablesFile = path.join(here, "..", "tables.json");
const args = new Set(process.argv.slice(2));
process.env.PZ_STORE = "memory"; // loadConfig must not demand a bearer token for seeding
const cfg = loadConfig().talkdesk; // loads .env and oauthclient.json into process.env
cfg.clientId = process.env.TD_CLIENT_ID; cfg.clientSecret = process.env.TD_CLIENT_SECRET;
if (!cfg.clientId || !cfg.clientSecret) { console.error("Set TD_CLIENT_ID and TD_CLIENT_SECRET"); process.exit(2); }
const td = new TalkdeskStore({ ...cfg, tableIds: fs.existsSync(tablesFile) ? JSON.parse(fs.readFileSync(tablesFile, "utf8")) : {} });

async function api(method, p, body) {
  const tok = await td.auth();
  const res = await fetch(cfg.apiBase + p, { method, headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const txt = await res.text();
  let j; try { j = JSON.parse(txt); } catch { j = txt; }
  return { status: res.status, body: j };
}
const shape = (o, d = 0) => Array.isArray(o) ? [o.length ? shape(o[0], d + 1) : "[]"] : o && typeof o === "object" && d < 4 ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, shape(v, d + 1)])) : typeof o;

const ref = await api("GET", "/data-tables/" + REFERENCE_TABLE);
if (ref.status !== 200) { console.error("cannot read reference table:", ref.status, JSON.stringify(ref.body).slice(0, 300)); process.exit(1); }
if (args.has("--inspect")) { console.log(JSON.stringify(shape(ref.body), null, 1)); console.log("columns sample:", JSON.stringify(ref.body.columns || ref.body.schema || "").slice(0, 600)); console.log("team_ids:", JSON.stringify(ref.body.team_ids)); process.exit(0); }

const teamIds = ref.body.team_ids;
// Mirrors the live column format observed on CRM_Codeverse: {id, display_name, slug, type:"STRING"}.
const mkCol = (name) => ({ display_name: name, slug: name, type: "STRING" });
if (teamIds.length !== 1) { console.error("expected exactly one (CodeVerse) team id on the reference table; got", teamIds.length); process.exit(1); }

const ids = { ...td.o.tableIds };
if (args.has("--create")) {
  for (const [logical, name] of Object.entries(TABLE_NAMES)) {
    if (ids[logical]) { console.log("exists", logical, ids[logical]); continue; }
    const body = { name, description: "PizzaResolve synthetic system of record (" + logical + "). Team CodeVerse. No real customer data.", team_ids: teamIds, columns: ["key", ...COLUMNS[logical]].map(mkCol) };
    const r = await api("POST", "/data-tables", body);
    if (r.status === 201 || r.status === 200) { ids[logical] = r.body.id; console.log("created", name, r.body.id); fs.writeFileSync(tablesFile, JSON.stringify(ids, null, 2)); }
    else { console.error("create failed", name, r.status, JSON.stringify(r.body).slice(0, 400)); process.exit(1); }
  }
}

td.o.tableIds = ids;
const rows = seedRows();
if (args.has("--rows")) {
  for (const [logical, list] of Object.entries(rows)) {
    for (const r of list) {
      const value = Object.fromEntries(COLUMNS[logical].map((c) => [c, r.value[c] === undefined ? null : r.value[c]]));
      const res = await td.create(logical, r.key, value).catch((e) => ({ status: "ERR " + e.message }));
      console.log(logical, r.key, res.status);
    }
  }
}
if (args.has("--refresh-times")) {
  for (const logical of ["orders", "payments", "events", "refunds"]) {
    const live = await td.list(logical);
    for (const r of rows[logical]) {
      const cur = live.find((x) => x.key === r.key);
      if (!cur) { console.log("missing", logical, r.key); continue; }
      const value = Object.fromEntries(COLUMNS[logical].map((c) => [c, r.value[c] === undefined ? null : r.value[c]]));
      const res = await api("PUT", `/data-tables/${ids[logical]}/rows/${cur.id}`, { key: r.key, value });
      console.log("refresh", logical, r.key, res.status);
    }
  }
}
