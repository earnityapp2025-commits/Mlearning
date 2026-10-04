import { analyzeEvent } from "./lib/openaiClient.js";
import express from "express";
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "2mb" }));


/* =============================
   SUPABASE
============================= */
let supabaseClient = null;

function getSupabase() {
  if (supabaseClient) return supabaseClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set"
    );
  }
  supabaseClient = createClient(url, key);
  return supabaseClient;
}

function requireSupabase(res) {
  try {
    return getSupabase();
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e.message || String(e)
    });
    return null;
  }
}

const PANEL_TOKEN = process.env.PANEL_TOKEN || ""; // set in Replit Secrets

/* =============================
   CONFIG (GUARDRAILS)
============================= */
const PROPOSALS_DIR = "fix-proposals";
const BACKUPS_DIR = "fix-backups";

const FILE_ALLOWLIST = new Set(["index.js"]);
const FIX_ALLOWLIST = new Set(["replace_single_with_maybeSingle"]);

const AUTO_APPLY_CONFIDENCE_THRESHOLD = 0.85;

/* =============================
   INSERTION ZONES (EXECUTION CONTEXT)
   You MUST keep these markers in index.js
============================= */
const INSERTION_ZONES = {
  routes: {
    marker:
      "/* =============================\n   ROUTES\n============================= */",
    description: "Safe area to insert new Express routes"
  },
  helpers: {
    marker:
      "/* =============================\n   HELPERS\n============================= */",
    description: "Safe area to insert helper functions"
  }
};

/* =============================
   SIMPLE FILE LOCK (avoids double-apply races)
============================= */
const fileLocks = new Map();
async function withFileLock(file, fn) {
  while (fileLocks.get(file)) {
    await new Promise((r) => setTimeout(r, 80));
  }
  fileLocks.set(file, true);
  try {
    return await fn();
  } finally {
    fileLocks.delete(file);
  }
}

/* =============================
   HELPERS
============================= */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf-8");
}

function writeText(filePath, content) {
  fs.writeFileSync(filePath, content, "utf-8");
}

function backupFile(targetPath) {
  ensureDir(BACKUPS_DIR);
  const base = path.basename(targetPath);
  const backupName = `${base}.${nowStamp()}.bak`;
  const backupPath = path.join(BACKUPS_DIR, backupName);
  fs.copyFileSync(targetPath, backupPath);
  return { backupName, backupPath };
}

function sha256(str) {
  return crypto.createHash("sha256").update(str).digest("hex");
}

function buildSignature(tool, message) {
  const raw =
    String(tool || "").trim().toLowerCase() +
    "|" +
    String(message || "").trim().toLowerCase();
  return sha256(raw);
}

function requirePanelAuth(req, res) {
  if (!PANEL_TOKEN) {
    return res.status(500).json({
      ok: false,
      error:
        "PANEL_TOKEN is not set. Add it to Secrets to protect apply endpoints."
    });
  }
  const got = req.headers["x-panel-token"];
  if (!got || got !== PANEL_TOKEN) {
    return res.status(401).json({ ok: false, error: "Unauthorized (bad token)" });
  }
}

function generateSemanticDiff(original, updated) {
  const o = original.split("\n");
  const u = updated.split("\n");
  const diffs = [];

  const max = Math.max(o.length, u.length);
  for (let i = 0; i < max; i++) {
    if (o[i] !== u[i]) {
      diffs.push({
        line: i + 1,
        before: o[i] ?? "",
        after: u[i] ?? ""
      });
    }
  }
  return diffs;
}

function canAutoApply({ confidenceScore, autoApplicable, fixType, targetFile }) {
  if (!autoApplicable) return false;
  if (confidenceScore < AUTO_APPLY_CONFIDENCE_THRESHOLD) return false;
  if (!FIX_ALLOWLIST.has(fixType)) return false;
  if (!FILE_ALLOWLIST.has(targetFile)) return false;
  return true;
}

/* =============================
   SAFE FIXERS (deterministic)
============================= */
function fix_replace_single_with_maybeSingle(original) {
  const updated = original.replace(/\.single\(/g, ".maybeSingle(");
  const changed = updated !== original;

  return {
    changed,
    updated,
    summary: changed
      ? "Replaced .single( with .maybeSingle( to avoid 400 errors on 0-row results."
      : "No .single( usage found."
  };
}

function runFix(fixType, original) {
  if (fixType === "replace_single_with_maybeSingle") {
    return fix_replace_single_with_maybeSingle(original);
  }
  return { changed: false, updated: original, summary: "Unknown fixType" };
}

/* =============================
   SUPABASE INSERT (tolerant)
   If a table/column doesn't exist, we fail gracefully.
============================= */
async function tryInsert(table, payload) {
  try {
    const supabase = getSupabase();
    const { error } = await supabase.from(table).insert(payload);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function tryUpsert(table, payload, onConflict) {
  try {
    const supabase = getSupabase();
    const { error } = await supabase.from(table).upsert(payload, { onConflict });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/* =============================
   ROUTES
============================= */
app.get("/", (_req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>MLearning</title>
      <style>
        :root {
          --bg: #10141c;
          --card: #181e2a;
          --ink: #f4f0e6;
          --muted: #b7b0a4;
          --line: rgba(244, 240, 230, 0.1);
          --brass: #e2b15a;
          --brass-ink: #2a210f;
          --teal: #9ee0d4;
          --danger: #ffb4a8;
          --ok: #9ddec8;
        }
        * { box-sizing: border-box; }
        body {
          margin: 0;
          min-height: 100vh;
          color: var(--ink);
          font-family: Inter, "Source Sans 3", "Segoe UI", sans-serif;
          font-size: 16.5px;
          line-height: 1.5;
          background:
            radial-gradient(900px 420px at 0% -10%, rgba(226, 177, 90, 0.16), transparent 55%),
            radial-gradient(700px 380px at 100% 0%, rgba(158, 224, 212, 0.08), transparent 50%),
            var(--bg);
        }
        a { color: var(--brass); }
        a:hover { color: #f3d7a2; }
        .wrap {
          width: min(1120px, calc(100% - 40px));
          margin: 0 auto;
          padding-bottom: 72px;
        }
        header {
          position: sticky;
          top: 0;
          z-index: 5;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          margin: 0 -8px;
          padding: 16px 8px;
          background: rgba(16, 20, 28, 0.9);
          backdrop-filter: blur(14px);
          border-bottom: 1px solid rgba(226, 177, 90, 0.28);
        }
        .brand {
          display: flex;
          align-items: center;
          gap: 10px;
          color: var(--ink);
          text-decoration: none;
          font-family: "Noto Serif Display", Georgia, serif;
          font-size: 22px;
          letter-spacing: -0.03em;
        }
        .mark {
          width: 32px;
          height: 32px;
          display: grid;
          place-items: center;
          border-radius: 9px;
          background: var(--brass);
          color: var(--brass-ink);
          font-family: "Noto Serif Display", Georgia, serif;
          font-size: 18px;
        }
        nav { display: flex; flex-wrap: wrap; gap: 6px; }
        nav a {
          color: var(--muted);
          text-decoration: none;
          padding: 8px 12px;
          border-radius: 999px;
          font-size: 14px;
          font-weight: 600;
        }
        nav a[aria-current="page"],
        nav a:hover {
          color: var(--ink);
          background: rgba(244, 240, 230, 0.06);
        }
        .hero { padding: 48px 0 8px; max-width: 740px; }
        .kicker {
          margin: 0;
          color: var(--brass);
          font-size: 12px;
          font-weight: 650;
          letter-spacing: 0.16em;
          text-transform: uppercase;
        }
        h1 {
          margin: 8px 0 14px;
          font-family: "Noto Serif Display", Georgia, serif;
          font-weight: 400;
          font-size: clamp(42px, 6vw, 68px);
          line-height: 1.02;
          letter-spacing: -0.035em;
        }
        .lede { margin: 0; color: var(--muted); font-size: 19px; max-width: 62ch; }
        .actions { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-top: 26px; }
        .button {
          display: inline-block;
          padding: 12px 18px;
          border-radius: 999px;
          background: var(--brass);
          color: var(--brass-ink);
          text-decoration: none;
          font-weight: 650;
        }
        .button:hover { color: var(--brass-ink); filter: brightness(1.06); }
        .button.secondary {
          background: transparent;
          color: var(--teal);
          box-shadow: inset 0 0 0 1.5px rgba(158, 224, 212, 0.7);
        }
        .button.secondary:hover { color: var(--teal); }
        .steps, .services {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 16px;
          margin-top: 36px;
        }
        .card {
          background: rgba(24, 30, 42, 0.92);
          border: 1px solid var(--line);
          border-radius: 18px;
          padding: 20px;
          scroll-margin-top: 84px;
        }
        .card h2 { margin: 8px 0; font-size: 18px; letter-spacing: -0.02em; }
        .card p { margin: 0; color: var(--muted); font-size: 15px; }
        .step {
          width: 26px;
          height: 26px;
          display: grid;
          place-items: center;
          border-radius: 50%;
          background: rgba(226, 177, 90, 0.16);
          color: var(--brass);
          font-family: "JetBrains Mono", ui-monospace, monospace;
          font-size: 12px;
        }
        .section-head { margin: 48px 0 0; max-width: 68ch; }
        .section-head h2 {
          margin: 8px 0 8px;
          font-family: "Noto Serif Display", Georgia, serif;
          font-weight: 400;
          font-size: 32px;
          letter-spacing: -0.03em;
        }
        .service h3 { margin: 0 0 8px; font-size: 18px; }
        .service p { margin: 0 0 10px; }
        code {
          font-family: "JetBrains Mono", ui-monospace, monospace;
          font-size: 0.86em;
          color: #f3d7a4;
          background: rgba(226, 177, 90, 0.12);
          padding: 1px 6px;
          border-radius: 6px;
        }
        .status-row { display: flex; gap: 8px; align-items: flex-start; margin-bottom: 10px; }
        .dot {
          width: 8px; height: 8px; margin-top: 7px; border-radius: 50%;
          background: var(--muted); flex: none;
        }
        #supabaseCard[data-state="ok"] .dot { background: var(--ok); }
        #supabaseCard[data-state="missing"] .dot { background: var(--danger); }
        .status { margin: 0; color: var(--ink); font-size: 14px; }
        #supabaseCard[data-state="missing"] { box-shadow: inset 3px 0 0 var(--danger); }
        #supabaseCard[data-state="ok"] { box-shadow: inset 3px 0 0 var(--ok); }
        .outlink { font-weight: 650; font-size: 14px; }
        @media (max-width: 860px) {
          .wrap { width: min(1120px, calc(100% - 28px)); }
          .steps, .services { grid-template-columns: 1fr; }
          header { align-items: flex-start; flex-direction: column; }
          h1 { font-size: 40px; }
        }
      </style>
    </head>
    <body>
      <div class="wrap">
        <header>
          <a class="brand" href="/">
            <span class="mark" aria-hidden="true">M</span>
            <span>MLearning</span>
          </a>
          <nav aria-label="Pages">
            <a href="/" aria-current="page">Home</a>
            <a href="/panel">Control panel</a>
            <a href="#services">Services</a>
          </nav>
        </header>

        <section class="hero">
          <p class="kicker">This server</p>
          <h1>MLearning is running</h1>
          <p class="lede">It records learning and error events, looks up fixes it has already verified, and can preview one allowlisted edit to <code>index.js</code>.</p>
          <div class="actions">
            <a class="button" href="/panel">Open control panel</a>
            <a class="button secondary" href="#services">See required services</a>
          </div>
        </section>

        <section class="steps" aria-label="How to use this server">
          <article class="card">
            <span class="step">1</span>
            <h2>Open the control panel</h2>
            <p>Prepare a proposal, look up a known fix, and preview the allowlisted fixer. <a href="/panel">Go to the panel</a>.</p>
          </article>
          <article class="card">
            <span class="step">2</span>
            <h2>See what is missing</h2>
            <p>Supabase, OpenAI, and the panel token each have a name and a place to set them. <a href="#services">Check services</a>.</p>
          </article>
          <article class="card">
            <span class="step">3</span>
            <h2>Preview before a write</h2>
            <p>The panel’s dry-run button calls the server in dry-run mode and leaves the file as it is. <a href="/panel#preview">Jump to dry-run</a>.</p>
          </article>
        </section>

        <div class="section-head" id="services">
          <p class="kicker">Services</p>
          <h2>What this process needs</h2>
          <p class="lede">Set these in the environment before you start <code>node index.js</code>. Keep the values out of the repository. This server has no page that stores them.</p>
        </div>
        <section class="services">
          <article class="card service" id="supabaseCard" data-state="checking">
            <h3>Supabase</h3>
            <p><code>SUPABASE_URL</code> and <code>SUPABASE_SERVICE_ROLE_KEY</code> back learning events, known fixes, the feed, proposals, and patch history. Copy the project URL and the service role key from the project’s API settings.</p>
            <div class="status-row">
              <span class="dot" aria-hidden="true"></span>
              <p class="status" id="supabaseStatus">Checking whether Supabase answers…</p>
            </div>
            <p><a class="outlink" href="https://supabase.com/dashboard" target="_blank" rel="noopener noreferrer">Open the Supabase dashboard</a></p>
          </article>
          <article class="card service">
            <h3>OpenAI</h3>
            <p><code>OPENAI_API_KEY</code> is read only by <code>POST /panel/analyze-test</code>. Call that route with <code>Authorization: Bearer</code> and your panel token. A missing key comes back as an error from that route.</p>
            <p><a class="outlink" href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">Open OpenAI API keys</a></p>
          </article>
          <article class="card service">
            <h3>Panel token</h3>
            <p><code>PANEL_TOKEN</code> protects apply routes. Send it as <code>x-panel-token</code> on <code>POST /apply-fix</code> and <code>POST /apply-proposal</code>, or as <code>Authorization: Bearer</code> on <code>POST /panel/ping</code> and <code>POST /panel/analyze-test</code>.</p>
            <p>The control panel buttons leave that header out, so dry-run’s result tells you the token state. <a href="/panel#preview">Try dry-run</a>.</p>
          </article>
        </section>
      </div>
      <script>
        fetch("/learn-feed").then(function (res) { return res.json(); }).then(function (data) {
          var status = document.getElementById("supabaseStatus");
          var card = document.getElementById("supabaseCard");
          if (!data.ok) {
            status.textContent = data.error || "Supabase did not respond.";
            card.dataset.state = "missing";
            return;
          }
          status.textContent = "Connected. The learn feed responded.";
          card.dataset.state = "ok";
        }).catch(function (err) {
          document.getElementById("supabaseStatus").textContent = err.message;
          document.getElementById("supabaseCard").dataset.state = "missing";
        });
      </script>
    </body>
    </html>
  `);
});

/* =============================
   INTROSPECT APP (reads file tree safely)
   - returns allowlisted files + markers + basic stats
============================= */
app.get("/introspect-app", async (_req, res) => {
  const root = process.cwd();
  const files = fs.readdirSync(root).slice(0, 200);

  const allowlisted = [];
  for (const f of files) {
    if (FILE_ALLOWLIST.has(f) && fs.existsSync(path.join(root, f))) {
      const full = path.join(root, f);
      const txt = readText(full);
      allowlisted.push({
        file: f,
        bytes: Buffer.byteLength(txt, "utf-8"),
        markers: Object.entries(INSERTION_ZONES).map(([k, v]) => ({
          zone: k,
          found: txt.includes(v.marker)
        }))
      });
    }
  }

  res.json({ ok: true, allowlisted, note: "Only allowlisted files are scanned." });
});

/* =============================
   LEARN EVENT (universal ingestion)
   Writes to learn_events, and optionally error_events
============================= */
app.post("/learn-event", async (req, res) => {
  const {
    source, // shell|frontend|backend|replit
    app: appName,
    level = "info",
    tool,
    message,
    context = {}
  } = req.body || {};

  if (!source || !tool || !message) {
    return res.status(400).json({
      ok: false,
      error: "Missing source, tool, or message"
    });
  }

  const supabase = requireSupabase(res);
  if (!supabase) return;

  const signatureHash = buildSignature(tool, message);

  // 1) learn_events (primary)
  await tryInsert("learn_events", [
    {
      source,
      app: appName || "MLearning",
      level,
      tool,
      message,
      context,
      signature_hash: signatureHash
    }
  ]);

  // 2) error_events (optional mirror)
  if (String(level).toLowerCase() === "error") {
    await tryInsert("error_events", [
      {
        source,
        app: appName || "MLearning",
        tool,
        message,
        context,
        signature_hash: signatureHash
      }
    ]);
  }

  // 3) return known fix if exists
  const { data: knownFix } = await supabase
    .from("verified_solutions")
    .select("*")
    .eq("signature_hash", signatureHash)
    .maybeSingle();

  return res.json({
    ok: true,
    received: true,
    signatureHash,
    known: Boolean(knownFix),
    response: knownFix
      ? {
          type: "known-fix",
          summary: knownFix.summary,
          solution: knownFix.solution,
          confidence: knownFix.confidence_score,
          auto_applicable: knownFix.auto_applicable
        }
      : {
          type: "unknown",
          summary: "I haven't seen this error before. Logged for learning."
        }
  });
});

/* =============================
   KNOWN FIX (query by tool+message)
============================= */
app.get("/known-fix", async (req, res) => {
  const { tool, message } = req.query || {};
  if (!tool || !message) {
    return res.status(400).json({ ok: false, error: "Missing tool or message" });
  }

  const supabase = requireSupabase(res);
  if (!supabase) return;

  const signatureHash = buildSignature(tool, message);

  const { data, error } = await supabase
    .from("verified_solutions")
    .select("*")
    .eq("signature_hash", signatureHash)
    .maybeSingle();

  if (error) return res.status(500).json({ ok: false, error: error.message });
  if (!data) return res.json({ ok: true, known: false, signatureHash });

  res.json({ ok: true, known: true, signatureHash, solution: data });
});

/* =============================
   SUGGEST ACTION (READ ONLY)
============================= */
app.post("/suggest-action", async (req, res) => {
  const { tool, message } = req.body;

  if (!tool || !message) {
    return res.status(400).json({
      ok: false,
      error: "Missing tool or message"
    });
  }

  const supabase = requireSupabase(res);
  if (!supabase) return;

  const signatureHash = buildSignature(tool, message);

  const { data, error } = await supabase
    .from("verified_solutions")
    .select("summary, solution, confidence_score")
    .eq("signature_hash", signatureHash)
    .maybeSingle();

  if (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }

  if (!data) {
    return res.json({
      ok: true,
      suggestion: "No known fix yet. Observe more occurrences before acting."
    });
  }

  res.json({
    ok: true,
    suggestion: data.solution || data.summary,
    confidence: data.confidence_score
  });
});


/* =============================
   LIVE LEARN EVENT FEED
============================= */
app.get("/learn-feed", async (_req, res) => {
  const supabase = requireSupabase(res);
  if (!supabase) return;

  const { data, error } = await supabase
    .from("learn_events")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }

  res.json({ ok: true, events: data });
});

/* =============================
   AUTO-APPLY DECISION (explain only)
============================= */
app.post("/auto-apply-decision", async (req, res) => {
  const { tool, message, fixType, targetFile = "index.js" } = req.body || {};
  if (!tool || !message || !fixType) {
    return res.status(400).json({ ok: false, error: "Missing tool/message/fixType" });
  }

  const supabase = requireSupabase(res);
  if (!supabase) return;

  const signatureHash = buildSignature(tool, message);

  const { data, error } = await supabase
    .from("verified_solutions")
    .select("*")
    .eq("signature_hash", signatureHash)
    .maybeSingle();

  if (error) return res.status(500).json({ ok: false, error: error.message });
  if (!data) {
    return res.json({
      ok: true,
      decision: "no",
      reason: "No verified solution exists yet."
    });
  }

  const confidenceScore = data.confidence_score ?? 0;
  const autoApplicable = data.auto_applicable === true;

  const decision = canAutoApply({
    confidenceScore,
    autoApplicable,
    fixType,
    targetFile
  });

  const reasons = [];
  if (!autoApplicable) reasons.push("Not marked auto_applicable");
  if (confidenceScore < AUTO_APPLY_CONFIDENCE_THRESHOLD)
    reasons.push(`Confidence ${confidenceScore} < ${AUTO_APPLY_CONFIDENCE_THRESHOLD}`);
  if (!FIX_ALLOWLIST.has(fixType)) reasons.push(`fixType '${fixType}' not allowlisted`);
  if (!FILE_ALLOWLIST.has(targetFile))
    reasons.push(`targetFile '${targetFile}' not allowlisted`);

  res.json({
    ok: true,
    decision: decision ? "yes" : "no",
    confidenceScore,
    autoApplicable,
    fixType,
    targetFile,
    explanation: decision ? "All criteria satisfied." : reasons
  });
});

/* =============================
   APPLY FIX (controlled deterministic fixer)
============================= */
app.post("/apply-fix", async (req, res) => {
  requirePanelAuth(req, res);
  if (res.headersSent) return;

  const { targetFile, fixType, mode = "dry-run" } = req.body || {};
  if (!targetFile || !fixType) {
    return res.status(400).json({ ok: false, error: "Missing targetFile or fixType" });
  }

  if (!FILE_ALLOWLIST.has(targetFile)) {
    return res.status(403).json({ ok: false, error: "File not allowlisted" });
  }
  if (!FIX_ALLOWLIST.has(fixType)) {
    return res.status(403).json({ ok: false, error: "Fix not allowlisted" });
  }
  if (!["dry-run", "apply"].includes(mode)) {
    return res.status(400).json({ ok: false, error: "Invalid mode" });
  }

  const targetPath = path.join(process.cwd(), targetFile);
  if (!fs.existsSync(targetPath)) {
    return res.status(404).json({ ok: false, error: "Target file not found" });
  }

  return withFileLock(targetFile, async () => {
    const original = readText(targetPath);
    const result = runFix(fixType, original);
    const diff = generateSemanticDiff(original, result.updated);

    // log attempt (optional)
    await tryInsert("fix_attempts", [
      {
        source: "panel",
        target_file: targetFile,
        fix_type: fixType,
        mode,
        changed: result.changed,
        summary: result.summary,
        diff_count: diff.length
      }
    ]);

    if (mode === "dry-run") {
      return res.json({
        ok: true,
        mode,
        targetFile,
        fixType,
        changed: result.changed,
        summary: result.summary,
        semanticDiff: diff,
        note: "Dry-run only. No files changed."
      });
    }

    const backup = backupFile(targetPath);
    writeText(targetPath, result.updated);

    // log applied patch (optional)
    await tryInsert("applied_patches", [
      {
        source: "panel",
        target_file: targetFile,
        patch_type: "fix",
        patch_key: sha256(`${fixType}|${targetFile}|${backup.backupName}`),
        summary: result.summary,
        backup_name: backup.backupName
      }
    ]);

    return res.json({
      ok: true,
      applied: true,
      backup,
      summary: result.summary
    });
  });
});

/* =============================
   APPLY PROPOSAL (controlled patch insertion)
   - writes proposal rows (code_proposals)
   - preview diff
   - apply inserts code at zone marker
============================= */
app.post("/apply-proposal", async (req, res) => {
  requirePanelAuth(req, res);
  if (res.headersSent) return;

  const {
    targetFile,
    zone,
    proposedCode,
    intent,
    mode = "dry-run",
    project = "MLearning"
  } = req.body || {};

  if (!targetFile || !zone || !proposedCode || !intent) {
    return res.status(400).json({
      ok: false,
      error: "Missing targetFile, zone, proposedCode, or intent"
    });
  }
  if (!FILE_ALLOWLIST.has(targetFile)) {
    return res.status(403).json({ ok: false, error: "Target file not allowlisted" });
  }
  if (!INSERTION_ZONES[zone]) {
    return res.status(400).json({ ok: false, error: `Unknown zone: ${zone}` });
  }
  if (!["dry-run", "apply"].includes(mode)) {
    return res.status(400).json({ ok: false, error: "Invalid mode" });
  }

  const targetPath = path.join(process.cwd(), targetFile);
  if (!fs.existsSync(targetPath)) {
    return res.status(404).json({ ok: false, error: "Target file not found" });
  }

  return withFileLock(targetFile, async () => {
    const original = readText(targetPath);
    const marker = INSERTION_ZONES[zone].marker;
    const idx = original.indexOf(marker);
    if (idx === -1) {
      return res.status(400).json({ ok: false, error: "Insertion marker not found" });
    }

    const insertionPoint = idx + marker.length;
    const normalizedCode = String(proposedCode).trim();

    const updated =
      original.slice(0, insertionPoint) +
      "\n\n" +
      normalizedCode +
      "\n\n" +
      original.slice(insertionPoint);

    const semanticDiff = generateSemanticDiff(original, updated);

    // record proposal (best-effort)
    const proposalHash = sha256(`${targetFile}|${zone}|${intent}|${normalizedCode}`);
    await tryInsert("code_proposals", [
      {
        source: "panel",
        project,
        target_file: targetFile,
        insertion_zone: zone,
        intent,
        proposed_code: normalizedCode,
        proposal_hash: proposalHash,
        mode,
        status: mode === "apply" ? "applied_requested" : "previewed"
      }
    ]);

    // optional snapshot
    await tryInsert("file_snapshots", [
      {
        project,
        file_path: targetFile,
        content_hash: sha256(original),
        bytes: Buffer.byteLength(original, "utf-8")
      }
    ]);

    if (mode === "dry-run") {
      return res.json({
        ok: true,
        mode: "dry-run",
        targetFile,
        zone,
        intent,
        proposalHash,
        semanticDiff,
        note: "Preview only. No files were modified."
      });
    }

    // prevent duplicate apply by hash (best effort)
    let supabase;
    try {
      supabase = getSupabase();
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: e.message || String(e)
      });
    }

    const { data: already } = await supabase
      .from("applied_patches")
      .select("*")
      .eq("patch_key", proposalHash)
      .maybeSingle();

    if (already) {
      return res.status(409).json({
        ok: false,
        error: "This proposalHash was already applied (duplicate prevented).",
        proposalHash
      });
    }

    const backup = backupFile(targetPath);
    writeText(targetPath, updated);

    await tryInsert("applied_patches", [
      {
        source: "panel",
        project,
        target_file: targetFile,
        patch_type: "proposal",
        patch_key: proposalHash,
        summary: intent,
        backup_name: backup.backupName
      }
    ]);

    return res.json({
      ok: true,
      applied: true,
      targetFile,
      zone,
      intent,
      proposalHash,
      backup,
      diff_count: semanticDiff.length
    });
  });
});

/* =============================
   PANEL HISTORY (pull recent proposals/patches/events)
============================= */
app.get("/panel-history", async (_req, res) => {
  const supabase = requireSupabase(res);
  if (!supabase) return;

  const out = { ok: true, proposals: [], patches: [], events: [] };

  try {
    const { data: proposals } = await supabase
      .from("code_proposals")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(25);
    out.proposals = proposals || [];
  } catch {}

  try {
    const { data: patches } = await supabase
      .from("applied_patches")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(25);
    out.patches = patches || [];
  } catch {}

  try {
    const { data: events } = await supabase
      .from("learn_events")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(25);
    out.events = events || [];
  } catch {}

  res.json(out);
});

// =============================
// Panel auth middleware
// =============================
function requirePanelToken(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.replace("Bearer ", "");

  if (!process.env.PANEL_TOKEN) {
    return res.status(500).json({ ok: false, error: "PANEL_TOKEN not set" });
  }

  if (token !== process.env.PANEL_TOKEN) {
    return res.status(401).json({ ok: false, error: "Invalid panel token" });
  }

  next();
}

// =============================
// Panel ping (API sanity check)
// =============================
app.post("/panel/ping", requirePanelToken, (req, res) => {
  res.json({
    ok: true,
    source: "MLearning backend",
    time: new Date().toISOString(),
  });
});

app.post("/panel/analyze-test", requirePanelToken, async (req, res) => {
  try {
    const { summary, context } = req.body || {};

    if (!summary) {
      return res.status(400).json({
        ok: false,
        error: "Missing summary",
      });
    }

    const analysis = await analyzeEvent({
      summary,
      context: context || {},
    });

    res.json({
      ok: true,
      analysis,
      time: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

/* =============================
   SERVER START
============================= */
app.get("/panel", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "panel.html"));
});

console.log("🔎 Registered panel routes:");

const panelRouter = app.router;
if (panelRouter && panelRouter.stack) {
  panelRouter.stack
    .filter(r => r.route)
    .filter(r => r.route.path.startsWith("/panel"))
    .forEach(r => {
      const methods = Object.keys(r.route.methods).join(",").toUpperCase();
      console.log(`  ${methods.padEnd(6)} ${r.route.path}`);
    });
} else {
  console.log("  (no routes registered yet)");
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MLearning running on port ${PORT}`);
});
