// Read-only: prints the live PZ_Action_Ledger_Codeverse rows (action rows by default; --all includes sessions/attempts).
// Session ids are masked. Usage: node test/ledger_dump.js [--all] [filter]
import fs from "node:fs";
import { TalkdeskStore } from "../src/store.js";
import { loadConfig } from "../src/config.js";

process.env.PZ_STORE = "memory";
const cfg = loadConfig().talkdesk;
cfg.clientId = process.env.TD_CLIENT_ID; cfg.clientSecret = process.env.TD_CLIENT_SECRET;
cfg.tableIds = JSON.parse(fs.readFileSync(new URL("../tables.json", import.meta.url), "utf8"));
const all = process.argv.includes("--all");
const filter = process.argv.slice(2).find((a) => !a.startsWith("--")) || "";
const rows = await new TalkdeskStore(cfg).list("ledger");
const mask = (s) => String(s || "").replace(/VS-[A-Z2-7]{10}/g, "VS-…");
const shown = rows.filter((r) => (all || !/^(VS-|ATT-)/.test(r.key)) && r.key.includes(filter)).sort((a, b) => String(a.value.created_at).localeCompare(String(b.value.created_at)));
for (const r of shown) console.log([r.key, r.value.kind, r.value.status, r.value.amount_paise || "", r.value.reason || "", r.value.created_at].join(" | "));
const count = (p) => rows.filter((r) => r.key.startsWith(p)).length;
console.log(`total rows ${rows.length} | REFREQ ${count("REFREQ-")} | INV ${count("INV-")} | ESC ${count("ESC-")} | SESSION ${count("VS-")} | ATT ${count("ATT-")}`);
void mask;
