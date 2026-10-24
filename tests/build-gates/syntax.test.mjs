import test from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";

const FILES_TO_CHECK = [
  "dev-server.js",
  "public/js/common.js",
  "shared/auth-core.mjs",
  "shared/facts.mjs",
  "shared/pricing.mjs",
  "shared/qr.mjs",
];

test("Syntax Verification", async (t) => {
  for (const file of FILES_TO_CHECK) {
    await t.test(`Checking syntax: ${file}`, () => {
      try {
        execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
        assert.ok(true);
      } catch (err) {
        assert.fail(`Syntax error detected in ${file}:\n${err.stderr?.toString() || err.message}`);
      }
    });
  }
});
