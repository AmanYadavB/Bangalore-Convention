import test from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

// Standard CommonJS scripts, browser scripts, and .mjs files checked via node --check
const STANDARD_FILES = [
  "dev-server.js",
  "public/js/common.js",
  "shared/auth-core.mjs",
  "shared/facts.mjs",
  "shared/pricing.mjs",
  "shared/qr.mjs",
  "tests/build-gates/assets.test.mjs",
  "tests/build-gates/secrets.test.mjs",
  "tests/build-gates/syntax.test.mjs",
  "tests/smoke/pages.test.mjs",
  "tests/smoke/api-health.test.mjs",
  "tests/smoke/rbac.test.mjs",
  "tests/smoke/headers.test.mjs",
  "tests/telemetry/push-grafana.mjs",
];

// Cloudflare Workers ESM files with .js extension in a CommonJS package
const ESM_WORKER_FILES = [
  "worker.js",
];

test("Syntax Verification", async (t) => {
  for (const file of STANDARD_FILES) {
    await t.test(`Checking syntax: ${file}`, () => {
      try {
        execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
        assert.ok(true);
      } catch (err) {
        assert.fail(`Syntax error detected in ${file}:\n${err.stderr?.toString() || err.message}`);
      }
    });
  }

  for (const file of ESM_WORKER_FILES) {
    await t.test(`Checking syntax (ESM Worker): ${file}`, () => {
      try {
        const code = fs.readFileSync(file);
        execFileSync(process.execPath, ["--input-type=module", "--check"], {
          input: code,
          stdio: ["pipe", "pipe", "pipe"],
        });
        assert.ok(true);
      } catch (err) {
        assert.fail(`Syntax error detected in ${file}:\n${err.stderr?.toString() || err.message}`);
      }
    });
  }
});
