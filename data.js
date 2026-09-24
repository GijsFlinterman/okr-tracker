// OKR Tracker API — proxy naar JSONBin met server-side authenticatie.
//
// Benodigde environment variables in Vercel (Settings → Environment Variables):
//   JSONBIN_BIN_ID      id van de bin
//   JSONBIN_API_KEY     JSONBin access key (bij voorkeur een Access Key met alleen
//                       read/update-rechten op deze bin, geen Master Key)
//   OKR_PASSWORD        het inlogwachtwoord
//   OKR_SESSION_SECRET  lange willekeurige string (min. 32 tekens) voor het ondertekenen
//                       van sessietokens. Wijzigen = iedereen wordt uitgelogd.

import crypto from "node:crypto";

const BIN_ID = process.env.JSONBIN_BIN_ID;
const API_KEY = process.env.JSONBIN_API_KEY;
const PASSWORD = process.env.OKR_PASSWORD;
const SECRET = process.env.OKR_SESSION_SECRET;
const BIN_URL = "https://api.jsonbin.io/v3/b/" + BIN_ID;
const SESSION_HOURS = 12;

function sign(payload) {
  return crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
}

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function makeToken() {
  const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
  const payload = String(exp);
  return payload + "." + sign(payload);
}

function validToken(req) {
  const auth = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  if (!safeEqual(sig, sign(payload))) return false;
  return Number(payload) > Date.now();
}

// Verwijdert het oude, in de data opgeslagen wachtwoord uit elke response.
function clean(record) {
  const { _auth, ...rest } = record || {};
  return rest;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (!BIN_ID || !API_KEY || !PASSWORD || !SECRET || SECRET.length < 32) {
    return res.status(500).json({ error: "Server niet geconfigureerd" });
  }

  // Inloggen: POST { password } → { token }
  if (req.method === "POST") {
    const pw = req.body && req.body.password;
    if (typeof pw === "string" && safeEqual(pw, PASSWORD)) {
      return res.status(200).json({ token: makeToken(), hours: SESSION_HOURS });
    }
    await new Promise((r) => setTimeout(r, 1000)); // remt brute-force af
    return res.status(401).json({ error: "Onjuist wachtwoord" });
  }

  if (!validToken(req)) {
    return res.status(401).json({ error: "Niet ingelogd" });
  }

  if (req.method === "GET") {
    try {
      const r = await fetch(BIN_URL + "/latest", { headers: { "X-Access-Key": API_KEY } });
      if (!r.ok) return res.status(r.status).json({ error: "Laden mislukt" });
      const d = await r.json();
      return res.status(200).json(clean(d.record));
    } catch (e) {
      return res.status(500).json({ error: "Laden mislukt" });
    }
  }

  if (req.method === "PUT") {
    const body = req.body;
    if (!body || !Array.isArray(body.objectives)) {
      return res.status(400).json({ error: "Ongeldige data" });
    }
    const toSave = { objectives: body.objectives, sprints: Array.isArray(body.sprints) ? body.sprints : [] };
    try {
      const r = await fetch(BIN_URL, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Access-Key": API_KEY },
        body: JSON.stringify(toSave),
      });
      if (!r.ok) return res.status(r.status).json({ error: "Opslaan mislukt" });
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: "Opslaan mislukt" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
