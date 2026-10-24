import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

const CRITICAL_PAGES = [
  "index.html",
  "register.html",
  "login.html",
  "account.html",
  "about.html",
  "privacy.html",
  "refund.html",
  "terms.html",
  "checkin.html",
  "dashboard.html",
  "registrations.html",
  "expenses.html",
  "ops.html",
  "pages.html",
  "reflections.html",
  "403.html",
];

const CRITICAL_STATIC_FILES = [
  "css/style.css",
  "js/common.js",
  "favicon.svg",
];

test("Asset Integrity Verification", async (t) => {
  for (const page of CRITICAL_PAGES) {
    await t.test(`HTML Page Exists and Non-Empty: public/${page}`, () => {
      const fullPath = path.join("public", page);
      assert.ok(fs.existsSync(fullPath), `Missing required page: ${fullPath}`);
      const stats = fs.statSync(fullPath);
      assert.ok(stats.size > 50, `Page is suspiciously small or empty: ${fullPath} (${stats.size} bytes)`);
    });
  }

  for (const asset of CRITICAL_STATIC_FILES) {
    await t.test(`Static Asset Exists and Non-Empty: public/${asset}`, () => {
      const fullPath = path.join("public", asset);
      assert.ok(fs.existsSync(fullPath), `Missing required asset: ${fullPath}`);
      const stats = fs.statSync(fullPath);
      assert.ok(stats.size > 50, `Asset is empty: ${fullPath} (${stats.size} bytes)`);
    });
  }
});
