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
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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
    const { error } = await supabase.from(table).insert(payload);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function tryUpsert(table, payload, onConflict) {
  try {
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
      <title>MLearning</title>
      <style>
        body {
          background: #0b1220;
          color: #e5e7eb;
          font-family: system-ui, sans-serif;
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100vh;
          margin: 0;
        }
        .card {
          background: #020617;
          border: 1px solid #1e293b;
          border-radius: 12px;
          padding: 32px;
          text-align: center;
          box-shadow: 0 20px 40px rgba(0,0,0,0.4);
        }
        h1 {
          margin-bottom: 20px;
        }
        a {
          display: inline-block;
          margin-top: 16px;
          padding: 10px 16px;
          background: #3b82f6;
          color: white;
          text-decoration: none;
          border-radius: 6px;
          font-weight: bold;
        }
        a:hover {
          background: #2563eb;
        }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>🧠 MLearning is alive ⚡</h1>
        <p>Embedded learning system running.</p>
        <a href="/panel">Open Control Panel</a>
      </div>
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
})

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

// =============================
// Panel: Test OpenAI analysis
// =============================
app.post("/panel/analyze-test", requirePanelToken, async (req, res) => {
  try {
    const insight = await analyzeEvent({
      summary: "Test event from panel",
      context: {
        source: "panel",
        purpose: "validate OpenAI loop",
        timestamp: new Date().toISOString(),
      },
    });

    res.json({
      ok: true,
      insight,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

console.log("🔎 Registered panel routes:");

if (app._router && app._router.stack) {
  app._router.stack
    .filter(r => r.route)
    .filter(r => r.route.path.startsWith("/panel"))
    .forEach(r => {
      const methods = Object.keys(r.route.methods).join(",").toUpperCase();
      console.log(`  ${methods.padEnd(6)} ${r.route.path}`);
    });
} else {
  console.log("  (no routes registered yet)");
}

/* =============================
   SERVER START
============================= */
app.get("/panel", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "panel.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MLearning running on port ${PORT}`);
});
