// Storage backends for PizzaResolve_MCP_Codeverse.
// TalkdeskStore = the real systems of record (Talkdesk Data Tables, team CodeVerse).
// MemoryStore   = identical contract for local tests only.
//
// Contract:
//   list(table)               -> [{ id, key, value }]          throws StoreUnavailable
//   create(table, key, value) -> { status: "CREATED", row }  | { status: "CONFLICT" }
//                                throws UnknownOutcome when the write may or may not have happened
//   getByKey(table, key)      -> row | null                     throws StoreUnavailable

export class StoreUnavailable extends Error { constructor(m) { super(m); this.code = "STORE_UNAVAILABLE"; } }
export class UnknownOutcome extends Error { constructor(m) { super(m); this.code = "UNKNOWN_OUTCOME"; } }

export const TABLES = ["customers", "orders", "payments", "events", "refunds", "ledger", "config"];

export class MemoryStore {
  constructor(seed = {}) {
    this.t = {};
    for (const name of TABLES) this.t[name] = new Map();
    for (const [name, rows] of Object.entries(seed)) for (const r of rows) this.t[name].set(r.key, { id: "mem-" + r.key, key: r.key, value: { ...r.value } });
    this.faults = {};        // table -> "UNAVAILABLE" | "TIMEOUT_AFTER_WRITE" | "TIMEOUT_BEFORE_WRITE"
    this.calls = [];
  }
  async list(table) {
    this.calls.push(["list", table]);
    if (this.faults[table] === "UNAVAILABLE") throw new StoreUnavailable(table + " unavailable");
    return [...this.t[table].values()].map((r) => ({ ...r, value: { ...r.value } }));
  }
  async getByKey(table, key) {
    if (this.faults[table] === "UNAVAILABLE") throw new StoreUnavailable(table + " unavailable");
    const r = this.t[table].get(key);
    return r ? { ...r, value: { ...r.value } } : null;
  }
  async create(table, key, value) {
    this.calls.push(["create", table, key]);
    const f = this.faults[table];
    if (f === "UNAVAILABLE" || f === "TIMEOUT_BEFORE_WRITE") { if (f === "TIMEOUT_BEFORE_WRITE") delete this.faults[table]; throw new UnknownOutcome("timeout"); }
    if (this.t[table].has(key)) return { status: "CONFLICT" };
    const row = { id: "mem-" + key, key, value: { ...value } };
    this.t[table].set(key, row);
    if (f === "TIMEOUT_AFTER_WRITE") { delete this.faults[table]; throw new UnknownOutcome("timeout after write"); }
    return { status: "CREATED", row };
  }
}

// ---------------- Talkdesk Data Tables ----------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class TalkdeskStore {
  /**
   * @param {object} o
   * @param {string} o.tokenUrl     e.g. https://pesit-hackathon.talkdeskid.com/oauth/token
   * @param {string} o.apiBase      e.g. https://api.talkdeskapp.com
   * @param {string} o.clientId
   * @param {string} o.clientSecret
   * @param {object} o.tableIds     { customers: "...", orders: "...", ... }
   * @param {string[]} [o.teamIds]  team ids to keep on created rows (not needed for rows)
   */
  constructor(o) {
    this.o = o;
    this.token = null;
    this.tokenExp = 0;
    this.timeoutMs = o.timeoutMs || 6000;
    this.cache = new Map(); // table -> { at, rows } for read-only reference tables
  }
  async auth() {
    if (this.token && Date.now() < this.tokenExp - 60000) return this.token;
    const body = new URLSearchParams({ grant_type: "client_credentials", scope: "data-tables:read data-tables:write" });
    const basic = Buffer.from(this.o.clientId + ":" + this.o.clientSecret).toString("base64");
    const res = await this.fetchT(this.o.tokenUrl, { method: "POST", headers: { Authorization: "Basic " + basic, "Content-Type": "application/x-www-form-urlencoded" }, body });
    if (!res.ok) throw new StoreUnavailable("token " + res.status);
    const j = await res.json();
    this.token = j.access_token;
    this.tokenExp = Date.now() + (j.expires_in || 600) * 1000;
    return this.token;
  }
  async fetchT(url, init) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try { return await fetch(url, { ...init, signal: ac.signal }); }
    finally { clearTimeout(timer); }
  }
  id(table) {
    const id = this.o.tableIds[table];
    if (!id) throw new StoreUnavailable("no table id configured for " + table);
    return id;
  }
  // Reads are idempotent: bounded retry with backoff (3 attempts max).
  async list(table) {
    let last;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const rows = [];
        for (let page = 1; page <= 10; page++) {
          const tok = await this.auth();
          const res = await this.fetchT(`${this.o.apiBase}/data-tables/${this.id(table)}/rows?per_page=100&page=${page}`, { headers: { Authorization: "Bearer " + tok } });
          if (res.status === 401) { this.token = null; throw new Error("401"); }
          if (res.status === 429 || res.status >= 500) throw new Error("http " + res.status);
          if (!res.ok) throw new StoreUnavailable(table + " read " + res.status);
          const j = await res.json();
          const batch = Array.isArray(j._embedded) ? j._embedded : (j._embedded && j._embedded.rows) || [];
          for (const r of batch) rows.push({ id: r.id, key: String(r.key), value: r.value || {} });
          const total = Number(j.total);
          if (batch.length < 100 || (Number.isFinite(total) && rows.length >= total)) break;
        }
        return rows;
      } catch (e) {
        last = e;
        if (e instanceof StoreUnavailable) throw e;
        await sleep(250 * (attempt + 1) ** 2);
      }
    }
    throw new StoreUnavailable(table + " read failed: " + (last && last.message));
  }
  async getByKey(table, key) {
    const rows = await this.list(table);
    return rows.find((r) => r.key === key) || null;
  }
  // Writes are NOT blindly retried. Uniqueness is enforced by Talkdesk (duplicate key -> 409).
  // After a timeout we re-read: present -> treat as created by us only if the value matches.
  async create(table, key, value) {
    let res;
    try {
      const tok = await this.auth();
      res = await this.fetchT(`${this.o.apiBase}/data-tables/${this.id(table)}/rows`, {
        method: "POST", headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
    } catch (e) {
      throw new UnknownOutcome("create " + key + ": " + e.message);
    }
    if (res.status === 201 || res.status === 200) {
      const j = await res.json().catch(() => ({}));
      return { status: "CREATED", row: { id: j.id, key: j.key || key, value: j.value || value } };
    }
    if (res.status === 409) return { status: "CONFLICT" };
    if (res.status >= 500 || res.status === 429) throw new UnknownOutcome("create " + key + " http " + res.status);
    const txt = await res.text().catch(() => "");
    throw new StoreUnavailable("create " + key + " rejected " + res.status + " " + txt.slice(0, 200));
  }
}
