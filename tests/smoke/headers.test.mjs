import test from "node:test";
import assert from "node:assert";

const BASE = (process.env.STAGING_URL || "https://bangalore-convention-staging.amankumaryadavasasmd.workers.dev").replace(/\/+$/, "");

test("Security Headers on HTML Responses", async (t) => {
  const res = await fetch(`${BASE}/`);
  assert.strictEqual(res.status, 200, `Expected 200 for homepage, got ${res.status}`);

  await t.test("X-Content-Type-Options: nosniff", () => {
    const val = res.headers.get("x-content-type-options");
    assert.strictEqual(val, "nosniff", `Expected nosniff, got: ${val}`);
  });

  await t.test("X-Frame-Options or CSP frame-ancestors is enforced", () => {
    const xfo = res.headers.get("x-frame-options");
    const csp = res.headers.get("content-security-policy") ?? "";
    const hasFrameGuard = Boolean(xfo) || csp.includes("frame-ancestors");
    assert.ok(hasFrameGuard, "Neither X-Frame-Options nor CSP frame-ancestors header found");
  });

  await t.test("Content-Security-Policy is present on HTML", () => {
    const csp = res.headers.get("content-security-policy");
    assert.ok(csp, "Missing Content-Security-Policy header");
    assert.ok(csp.includes("default-src"), "CSP missing default-src directive");
  });

  await t.test("Referrer-Policy is configured", () => {
    const ref = res.headers.get("referrer-policy");
    assert.ok(ref, "Missing Referrer-Policy header");
    assert.strictEqual(ref, "strict-origin-when-cross-origin");
  });

  await t.test("Permissions-Policy restricts sensitive device APIs", () => {
    const perm = res.headers.get("permissions-policy");
    assert.ok(perm, "Missing Permissions-Policy header");
    assert.ok(perm.includes("camera=(self)"), "Permissions-Policy should allow camera only for (self)");
  });
});
