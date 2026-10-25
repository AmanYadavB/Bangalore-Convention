import test from "node:test";
import assert from "node:assert";

const BASE = (process.env.STAGING_URL || "https://bangalore-convention-staging.amankumaryadavasasmd.workers.dev").replace(/\/+$/, "");

// Purely public pages that an unauthenticated visitor can access directly.
// Must return 200 OK with content-type text/html.
const PUBLIC_PAGES = [
  "/",
  "/register.html",
  "/login.html",
  "/about.html",
  "/privacy.html",
  "/refund.html",
  "/terms.html",
  "/403.html",
];

// Admin and developer surfaces protected by RBAC.
// An unauthenticated visitor MUST be redirected to /login.html.
const PROTECTED_PAGES = [
  "/checkin.html",      // Staff door check-in desk
  "/dashboard.html",    // Staff metrics & overview
  "/registrations.html",// Staff attendee list
  "/expenses.html",     // Staff expense tracking
  "/reflections.html",  // Developer reflections broadcast
  "/ops.html",          // Developer ops & billing
  "/pages.html",        // Developer AI knowledge-base editor
];

test("Public Pages Reachability (Unauthenticated)", async (t) => {
  for (const page of PUBLIC_PAGES) {
    await t.test(`GET ${page} → 200 text/html`, async () => {
      const res = await fetch(`${BASE}${page}`);
      assert.strictEqual(res.status, 200, `Expected 200 OK for ${page}, got ${res.status}`);
      const ct = res.headers.get("content-type") ?? "";
      assert.ok(ct.includes("text/html"), `Expected text/html content-type for ${page}, got: ${ct}`);
    });
  }
});

test("Protected Pages Gate (Unauthenticated → Redirect to Login)", async (t) => {
  for (const page of PROTECTED_PAGES) {
    await t.test(`GET ${page} redirects to /login`, async () => {
      // 1. Verify redirect (302 from auth gate or 307 clean-URL to extensionless)
      const res = await fetch(`${BASE}${page}`, { redirect: "manual" });
      assert.ok(
        [301, 302, 307, 308].includes(res.status),
        `Expected redirect (302/307) for protected page ${page}, got ${res.status} (should not serve HTML directly)`
      );

      // 2. Verify following redirect lands on login page with HTTP 200
      const followRes = await fetch(`${BASE}${page}`);
      assert.strictEqual(followRes.status, 200, `Expected 200 upon reaching login page from ${page}`);
      assert.ok(
        followRes.url.includes("/login"),
        `Expected final URL to be login page, got: ${followRes.url}`
      );
    });
  }
});

test("Disabled Pages Enforcement", async (t) => {
  await t.test("GET /account.html → 404 Not Found (without setup token)", async () => {
    const res = await fetch(`${BASE}/account.html`);
    assert.strictEqual(
      res.status,
      404,
      `Expected 404 for disabled /account.html, got ${res.status}`
    );
  });
});
