// Synthetic data for TelecomResolve_Codeverse - FICTIONAL operator "CodeVerse Telecom". No real subscriber data.
// Timestamps are relative to `now` so scenarios stay valid (refresh with seed_telecom.js --refresh-times).
export const TABLE_NAMES = {
  subscribers: "TC_Subscribers_Codeverse", recharges: "TC_Recharges_Codeverse", services: "TC_Services_Codeverse",
  network: "TC_Network_Status_Codeverse", refunds: "TC_Refund_Processor_Codeverse", ledger: "TC_Case_Ledger_Codeverse", config: "TC_Config_Codeverse",
};
export const COLUMNS = {
  subscribers: ["first_name", "phone_last4", "postcode", "plan_type", "status", "sim_swap_at", "circle"],
  recharges: ["account_id", "amount_paise", "status", "gateway_ref", "plan_code", "created_at"],
  services: ["account_id", "kind", "txn_id", "plan_code", "vas_code", "amount_paise", "channel", "created_at"],
  network: ["pincode", "status", "cause", "started_at", "eta"],
  refunds: ["account_id", "txn_id", "status", "processor_ref", "amount_paise", "created_at"],
  ledger: ["kind", "status", "account_id", "ref", "txn_id", "category", "amount_paise", "reason", "target_by", "priority", "summary", "findings", "evidence", "customer_note", "channel", "human_access", "session", "created_at", "expires_at"],
  config: ["mode", "scope", "note"],
};

export function telecomSeedRows(now = Date.now()) {
  const ago = (m) => new Date(now - m * 60000).toISOString();
  const sub = (key, first_name, phone_last4, postcode, extra = {}) => ({ key, value: { first_name, phone_last4, postcode, plan_type: "PREPAID", status: "ACTIVE", sim_swap_at: "", circle: "Karnataka", ...extra } });
  const rc = (key, account_id, amount_paise, status, plan_code, minsAgo, gateway_ref) => ({ key, value: { account_id, amount_paise: String(amount_paise), status, gateway_ref: gateway_ref || "GW-" + key, plan_code, created_at: ago(minsAgo) } });
  const credit = (key, account_id, txn_id, plan_code, minsAgo) => ({ key, value: { account_id, kind: "PLAN_CREDIT", txn_id, plan_code, vas_code: "", amount_paise: "", channel: "PROVISIONING", created_at: ago(minsAgo) } });
  return {
    subscribers: [
      sub("ACC-50001", "Meera", "4821", "560085"),                       // T1 recharge debited, never credited
      sub("ACC-50002", "Karan", "3307", "560034"),                       // T2 duplicate debit (+ replayed webhook), area degraded
      sub("ACC-50003", "Divya", "9910", "560001", { plan_type: "POSTPAID" }), // T3 value-added service without consent
      sub("ACC-50004", "Rohit", "6642", "560076"),                       // T4 known outage past ETA
      sub("ACC-50005", "Sana", "1188", "560011", { sim_swap_at: ago(5 * 60) }), // T5 recent SIM swap: fraud hold
      sub("ACC-50006", "Flagged", "0000", "560000", { status: "FLAGGED" }),
      sub("ACC-50007", "Ajay", "2468", "560078"),                        // T7 wrong plan credited
      sub("ACC-50008", "Lata", "1357", "560102"),                        // T8 refund stuck in processing
      sub("ACC-50009", "Test", "7777", "560099"),                        // automated live tests only
      sub("ACC-50010", "Nikhil", "5555", "560050"),                      // T10 credit pending / bank hold / settled refund
    ],
    recharges: [
      rc("TXN-7001", "ACC-50001", 29900, "CAPTURED", "P299", 40),
      rc("TXN-7002A", "ACC-50002", 49900, "CAPTURED", "P499", 50),
      rc("TXN-7002B", "ACC-50002", 49900, "CAPTURED", "P499", 47),
      rc("TXN-7002C", "ACC-50002", 49900, "CAPTURED", "P499", 46, "GW-TXN-7002B"), // replay of 7002B
      rc("TXN-7005", "ACC-50005", 19900, "CAPTURED", "P199", 90),
      rc("TXN-7007", "ACC-50007", 39900, "CAPTURED", "P399", 120),
      rc("TXN-7008", "ACC-50008", 29900, "CAPTURED", "P299", 9 * 1440 + 60),
      rc("TXN-7099", "ACC-50009", 9900, "CAPTURED", "P99", 600),
      rc("TXN-7098", "ACC-50009", 9900, "CAPTURED", "P99", 590),
      rc("TXN-7010", "ACC-50010", 29900, "CAPTURED", "P299", 5),
      rc("TXN-7011", "ACC-50010", 29900, "AUTHORIZED", "P299", 20),
      rc("TXN-7012", "ACC-50010", 19900, "CAPTURED", "P199", 4 * 1440),
    ],
    services: [
      credit("PC-7002A", "ACC-50002", "TXN-7002A", "P499", 49),
      credit("PC-7007", "ACC-50007", "TXN-7007", "P199", 119),            // paid P399, got P199
      { key: "VAS-8001", value: { account_id: "ACC-50003", kind: "VAS_CHARGE", txn_id: "", plan_code: "", vas_code: "CALLER_TUNE_PLUS", amount_paise: "3000", channel: "BILLING", created_at: ago(3 * 1440) } },
      { key: "VAS-8002", value: { account_id: "ACC-50003", kind: "VAS_CHARGE", txn_id: "", plan_code: "", vas_code: "CRICKET_ALERTS", amount_paise: "4900", channel: "BILLING", created_at: ago(2 * 1440) } },
      { key: "VC-8002", value: { account_id: "ACC-50003", kind: "VAS_CONSENT", txn_id: "", plan_code: "", vas_code: "CRICKET_ALERTS", amount_paise: "", channel: "SMS_DOUBLE_CONFIRMATION", created_at: ago(20 * 1440) } },
      { key: "VAS-8099", value: { account_id: "ACC-50009", kind: "VAS_CHARGE", txn_id: "", plan_code: "", vas_code: "TEST_VAS", amount_paise: "1000", channel: "BILLING", created_at: ago(1440) } },
    ],
    network: [
      { key: "NET-560076", value: { pincode: "560076", status: "OUTAGE", cause: "fibre cut on the backhaul link", started_at: ago(5 * 60), eta: ago(2 * 60) } },
      { key: "NET-560034", value: { pincode: "560034", status: "DEGRADED", cause: "planned tower maintenance", started_at: ago(30), eta: ago(-120) } },
    ],
    refunds: [
      { key: "RF-7008", value: { account_id: "ACC-50008", txn_id: "TXN-7008", status: "PROCESSING", processor_ref: "", amount_paise: "29900", created_at: ago(9 * 1440) } },
      { key: "RF-7012", value: { account_id: "ACC-50010", txn_id: "TXN-7012", status: "SETTLED", processor_ref: "RRN-55120934", amount_paise: "19900", created_at: ago(3 * 1440) } },
    ],
    ledger: [],
    config: [
      { key: "FAULT-BILLING", value: { mode: "OFF", scope: "ACC-50009", note: "set mode ON to simulate a billing outage for the test account" } },
      { key: "FAULT-NETWORK", value: { mode: "OFF", scope: "ALL", note: "set mode ON to simulate network-status outage" } },
    ],
  };
}
