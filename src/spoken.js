// Spoken-number reader for voice channels (Team CodeVerse).
// Speech-to-text hands the agent words, not digits: "eight oh oh two", "twenty four sixty eight",
// "aath hazaar chhe", "paanch chhe shunya shunya shunya ek", "entu sonne sonne eradu", "८००६".
// The language model is unreliable at turning these into digits, so the server does it with fixed rules.
// Pure functions: no I/O. Unknown words are ignored, so the result is checked for length by the caller.

// Native-script decimal digits -> ASCII (Devanagari, Bengali, Gurmukhi, Gujarati, Odia, Tamil, Telugu, Kannada, Malayalam, full-width).
const DIGIT_ZEROS = [0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0xff10];
function asciiDigits(str) {
  let out = "";
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    const z = DIGIT_ZEROS.find((b) => cp >= b && cp <= b + 9);
    out += z === undefined ? ch : String(cp - z);
  }
  return out;
}

const W = {};
const add = (value, ...words) => { for (const w of words) W[w] = value; };
// English
add(0, "ZERO", "OH", "O", "NIL", "NOUGHT", "ZIRO", "JERO", "JIRO");
add(1, "ONE", "WON"); add(2, "TWO", "TO", "TOO"); add(3, "THREE", "TREE"); add(4, "FOUR", "FOR");
add(5, "FIVE"); add(6, "SIX"); add(7, "SEVEN"); add(8, "EIGHT", "ATE"); add(9, "NINE");
add(10, "TEN"); add(11, "ELEVEN"); add(12, "TWELVE"); add(13, "THIRTEEN"); add(14, "FOURTEEN"); add(15, "FIFTEEN");
add(16, "SIXTEEN"); add(17, "SEVENTEEN"); add(18, "EIGHTEEN"); add(19, "NINETEEN");
add(20, "TWENTY"); add(30, "THIRTY"); add(40, "FORTY", "FOURTY"); add(50, "FIFTY"); add(60, "SIXTY");
add(70, "SEVENTY"); add(80, "EIGHTY"); add(90, "NINETY");
// Hindi / Hinglish (romanised and Devanagari)
add(0, "SHUNYA", "SHOONYA", "SUNYA", "SHUNYA", "SHUNY", "शून्य", "शुन्य", "ज़ीरो", "जीरो");
add(1, "EK", "AEK", "एक"); add(2, "DO", "DOH", "दो"); add(3, "TEEN", "TIN", "तीन");
add(4, "CHAR", "CHAAR", "CHARR", "चार"); add(5, "PAANCH", "PANCH", "PAANCHH", "PANCHH", "पांच", "पाँच");
add(6, "CHHE", "CHHAH", "CHHAI", "CHHAY", "CHAH", "CHE", "CHEH", "CHHEH", "CHHA", "छह", "छः", "छे", "छै");
add(7, "SAAT", "SAT", "SATH", "सात"); add(8, "AATH", "ATH", "AAT", "AATTH", "आठ"); add(9, "NAU", "NAO", "NAUU", "नौ");
add(10, "DAS", "DUS", "दस"); add(20, "BEES", "BIS", "बीस"); add(30, "TEES", "तीस"); add(40, "CHAALIS", "CHALIS", "चालीस");
add(50, "PACHAAS", "PACHAS", "पचास"); add(60, "SAATH", "साठ"); add(70, "SATTAR", "सत्तर"); add(80, "ASSI", "अस्सी"); add(90, "NABBE", "नब्बे");
// Kannada (romanised and script)
add(0, "SONNE", "SONE", "SONNI", "ಸೊನ್ನೆ"); add(1, "ONDU", "ಒಂದು"); add(2, "ERADU", "YERADU", "ಎರಡು");
add(3, "MOORU", "MURU", "ಮೂರು"); add(4, "NAALKU", "NALKU", "ನಾಲ್ಕು"); add(5, "AIDU", "AYDU", "EIDU", "ಐದು");
add(6, "AARU", "ARU", "ಆರು"); add(7, "ELU", "YELU", "ಏಳು"); add(8, "ENTU", "YENTU", "ಎಂಟು"); add(9, "OMBATTU", "ONBATTU", "ಒಂಬತ್ತು");
add(10, "HATTU", "ಹತ್ತು");
// Tamil (romanised and script)
add(0, "POOJYAM", "PUJYAM", "POOJIYAM", "SUZHIYAM", "பூஜ்ஜியம்", "பூஜ்யம்"); add(1, "ONNU", "ONDRU", "ONRU", "ஒன்று");
add(2, "RENDU", "IRANDU", "இரண்டு"); add(3, "MOONU", "MOONDRU", "MUNRU", "மூன்று"); add(4, "NAALU", "NAANGU", "NANGU", "நான்கு");
add(5, "ANJU", "AINTHU", "AINDHU", "ஐந்து"); add(6, "ஆறு"); add(7, "EZHU", "YEZHU", "ஏழு"); add(8, "ETTU", "எட்டு");
add(9, "ONBADHU", "ONBATHU", "ஒன்பது"); add(10, "PATHU", "பத்து");
// Telugu (romanised)
add(0, "SUNNA"); add(1, "OKATI"); add(3, "MOODU"); add(4, "NAALUGU"); add(7, "EDU"); add(8, "ENIMIDI"); add(9, "TOMMIDI");

const MULT = {};
for (const w of ["HUNDRED", "SAU", "सौ", "NOORU", "ನೂರು", "நூறு", "VANDA"]) MULT[w] = 100;
for (const w of ["THOUSAND", "HAZAAR", "HAZAR", "HAJAR", "HAJAAR", "हज़ार", "हजार", "SAAVIRA", "SAVIRA", "ಸಾವಿರ", "AAYIRAM", "AYIRAM", "ஆயிரம்", "VEYYI"]) MULT[w] = 1000;
const REPEAT = { DOUBLE: 2, TRIPLE: 3, DUBBLE: 2, DABAL: 2, DABBAL: 2, TRIPAL: 3 };
// Words that mean "I said it wrong, here it is again".
const CORRECTION = new Set(["SORRY", "ACTUALLY", "CORRECTION", "WAIT", "NAHI", "NAHIN", "NAHEE", "NHI", "नहीं", "MATLAB", "ILLA", "ಇಲ್ಲ", "இல்லை", "ILLAI", "KADU", "SORRI", "MEAN"]);

function tokens(raw) {
  return asciiDigits(String(raw ?? "")).toUpperCase().split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
}

// Read one stretch of speech (no corrections) into a digit string.
function readRun(toks) {
  let out = "";       // digits already fixed
  let rep = 1;        // pending "double"/"triple"
  let num = null;     // a compound number being built ("eight thousand six", "twenty four")
  let lastSmall = null; // last number < 100 appended to out (may become the head of "eight hundred")
  const flush = () => { if (num) { out += String(num.total + num.part); num = null; } };
  for (const w of toks) {
    if (/^\d+$/.test(w)) { flush(); out += w.length === 1 ? w.repeat(rep) : w; rep = 1; lastSmall = w.length === 1 ? Number(w) : null; continue; }
    if (REPEAT[w]) { flush(); rep = REPEAT[w]; lastSmall = null; continue; }
    if (MULT[w]) {
      const m = MULT[w];
      if (num && num.part > 0 && num.part < m && (num.total === 0 || num.total >= 1000 && m < 1000)) { num.total += num.part * m; num.part = 0; num.top = m; }
      else if (!num && lastSmall !== null) { out = out.slice(0, -String(lastSmall).length); num = { total: lastSmall * m, part: 0, top: m }; }
      else if (!num) num = { total: m, part: 0, top: m };   // "hundred" alone
      lastSmall = null; continue;
    }
    const v = W[w];
    if (v === undefined) continue;  // unknown word: ignore
    if (num) {
      // Inside a compound: add while it still makes sense ("thousand" + "six", "twenty" + "four").
      const p = num.part;
      if (p === 0 && v < num.top) { num.part = v; continue; }
      if (p >= 20 && p % 10 === 0 && v >= 1 && v < 10) { num.part = p + v; continue; }
      flush();
    }
    if (v >= 20 && v % 10 === 0) { num = { total: 0, part: v, top: 100 }; lastSmall = null; rep = 1; continue; }
    if (v >= 10) { out += String(v); lastSmall = v; rep = 1; continue; }
    out += String(v).repeat(rep); rep = 1; lastSmall = v;
  }
  flush();
  return out;
}

// Split the utterance at the LAST correction ("one three five, no sorry, one three five seven").
// "no" only counts as a correction once some digits were heard (so "order no eight..." still works).
function splitCorrection(raw) {
  const toks = tokens(raw);
  let cut = -1;
  for (let i = 0; i < toks.length; i++) {
    const w = toks[i];
    if (CORRECTION.has(w) || (w === "NO" && readRun(toks.slice(0, i)).length > 0)) cut = i;
  }
  if (cut < 0) return { before: toks, after: null };
  return { before: toks.slice(0, cut), after: toks.slice(cut + 1) };
}

// Digits from speech. With `len`, a short correction replaces the tail:
// "five six zero zero seven nine, no sorry, seven eight" -> 560078.
export function readDigits(raw, len = 0) {
  const { before, after } = splitCorrection(raw);
  const b = readRun(before);
  if (after === null) return b;
  const a = readRun(after);
  if (!a) return b;
  if (!len) return a;
  if (a.length >= len) return a;
  if (b.length >= len && a.length < len) { const base = b.slice(0, len); return base.slice(0, len - a.length) + a; }
  return a;
}

// Backwards-compatible name used by the service layer.
export const spokenDigits = (raw) => readDigits(raw);

export function readPhoneLast4(raw) {
  const plain = String(raw ?? "").trim();
  if (/^\d{4}$/.test(plain)) return plain;
  const d = readDigits(raw, 4);
  return d.length >= 4 ? d.slice(-4) : d;
}

export function readPostcode(raw) {
  const plain = String(raw ?? "").replace(/\s/g, "");
  if (/^\d{6}$/.test(plain)) return plain;
  const d = readDigits(raw, 6);
  return d.length === 6 ? d : plain;
}

// "summer ten" -> SUMMER10, "pizza twenty" -> PIZZA20, "flat hundred" -> FLAT100, "SUMMER10" unchanged.
export function readCoupon(raw) {
  const str = String(raw ?? "").trim();
  if (!str || /^[A-Za-z]+\d+$/.test(str.replace(/[\s-]/g, ""))) return str.replace(/[\s-]/g, "");
  const toks = tokens(str);
  let i = 0, letters = "";
  while (i < toks.length && /^[A-Z]+$/.test(toks[i]) && W[toks[i]] === undefined && !MULT[toks[i]] && !REPEAT[toks[i]]) letters += toks[i++];
  const digits = readRun(toks.slice(i));
  return letters && digits ? letters + digits : str;
}
