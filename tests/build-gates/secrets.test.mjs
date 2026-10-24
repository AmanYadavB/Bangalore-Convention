import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

// High-confidence patterns for sensitive credentials
const SECRET_PATTERNS = [
  { name: "Live Stripe/Razorpay Key", regex: /sk_live_[0-9a-zA-Z]{24}/ },
  { name: "Google API Key", regex: /AIza[0-9A-Za-z-_]{35}/ },
  { name: "AWS Access Key", regex: /(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/ },
  { name: "GitHub Personal Access Token", regex: /gh[pousr]_[A-Za-z0-9_]{36,255}/ },
  { name: "Generic Private Key", regex: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/ },
  { name: "Live Deepgram API Key Pattern", regex: /(?:DEEPGRAM_API_KEY|deepgram_api_key)\s*[:=]\s*["'][a-f0-9]{40}["']/i },
  { name: "Live Resend API Key", regex: /re_[A-Za-z0-9]{24,}/ },
];

const SCAN_DIRS = [".", "shared", "public/js"];
const SCAN_EXTENSIONS = new Set([".js", ".mjs", ".toml", ".json"]);
const IGNORED_DIRS = new Set([".git", ".claude", "node_modules", ".wrangler"]);
const IGNORED_FILES = new Set([".dev.vars"]); // Local-only ignored dev vars

function collectFiles(dir) {
  let files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files = files.concat(collectFiles(fullPath));
    } else if (SCAN_EXTENSIONS.has(path.extname(entry.name)) && !IGNORED_FILES.has(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

test("Secret & Credential Hygiene Verification", async (t) => {
  const filesToScan = [
    "worker.js",
    "dev-server.js",
    "wrangler.toml",
    "wrangler.staging.toml",
    "package.json",
    ...collectFiles("shared"),
  ];

  for (const file of filesToScan) {
    if (!fs.existsSync(file)) continue;

    await t.test(`Scanning file for accidental secret leaks: ${file}`, () => {
      const content = fs.readFileSync(file, "utf8");
      for (const { name, regex } of SECRET_PATTERNS) {
        const match = regex.exec(content);
        assert.strictEqual(
          match,
          null,
          `CRITICAL: Detected possible ${name} in file "${file}". Secrets must use Cloudflare Secrets / Environment Variables, not be committed in Git!`
        );
      }
    });
  }
});
