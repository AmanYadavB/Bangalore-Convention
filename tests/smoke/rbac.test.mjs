import test from "node:test";
import assert from "node:assert";

const BASE = (process.env.STAGING_URL || "https://bangalore-convention-staging.amankumaryadavasasmd.workers.dev").replace(/\/+$/, "");

// Read credentials from env (supports multiple naming conventions)
const STAFF_EMAIL = process.env.TEST_STAFF_EMAIL || process.env.STAFF_EMAIL;
const STAFF_PASSWORD = process.env.TEST_STAFF_PASSWORD || process.env.STAFF_PASSWORD;
const DEV_EMAIL = process.env.TEST_DEV_EMAIL || process.env.DEV_EMAIL || process.env.DEVELOPER_EMAIL;
const DEV_PASSWORD = process.env.TEST_DEV_PASSWORD || process.env.DEV_PASSWORD || process.env.DEVELOPER_PASSWORD;

// Staff Surfaces
const STAFF_PAGES = [
  "/checkin.html",
  "/dashboard.html",
  "/registrations.html",
  "/expenses.html",
];

const STAFF_APIS = [
  { method: "GET",  path: "/api/dashboard" },
  { method: "GET",  path: "/api/registrations" },
  { method: "GET",  path: "/api/expenses" },
  { method: "POST", path: "/api/checkin" },
];

// Developer Surfaces
const DEV_PAGES = [
  "/reflections.html",
  "/ops.html",
  "/pages.html",
];

const DEV_APIS = [
  { method: "GET",  path: "/api/knowledge" },
  { method: "GET",  path: "/api/report/schedule" },
  { method: "POST", path: "/api/reflections" },
];

// Helper: Signs in via POST /api/auth/login/password and extracts session cookies
async function loginAs(baseUrl, email, password) {
  if (!email || !password) return null;
  const res = await fetch(`${baseUrl}/api/auth/login/password`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(`Login failed for ${email} (${res.status}): ${data.error || "Unknown error"}`);
  }

  const rawCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const cookieHeader = rawCookies.map((c) => c.split(";")[0].trim()).join("; ");

  let csrfToken = "";
  for (const c of rawCookies) {
    const match = c.match(/(?:^|; )(__Host-)?bc_csrf=([^;]+)/);
    if (match) csrfToken = match[2];
  }

  const data = await res.json().catch(() => ({}));
  return { cookie: cookieHeader, csrfToken, user: data.user };
}

// =========================================================================
// 1. ANONYMOUS RBAC GATING (No credentials)
// =========================================================================
test("1. Anonymous RBAC Gating (Unauthenticated)", async (t) => {
  await t.test("Unauthenticated calls to Staff APIs → 401 Unauthorized", async () => {
    for (const { method, path } of STAFF_APIS) {
      const opts = {
        method,
        headers: { Origin: BASE, "Content-Type": "application/json" },
      };
      if (method === "POST") opts.body = JSON.stringify({});
      const res = await fetch(`${BASE}${path}`, opts);
      assert.strictEqual(res.status, 401, `Expected 401 for anonymous ${method} ${path}, got ${res.status}`);
    }
  });

  await t.test("Unauthenticated calls to Developer APIs → 401 Unauthorized", async () => {
    for (const { method, path } of DEV_APIS) {
      const opts = {
        method,
        headers: { Origin: BASE, "Content-Type": "application/json" },
      };
      if (method === "POST") opts.body = JSON.stringify({});
      const res = await fetch(`${BASE}${path}`, opts);
      assert.strictEqual(res.status, 401, `Expected 401 for anonymous ${method} ${path}, got ${res.status}`);
    }
  });

  await t.test("Unauthenticated access to Staff Pages → Redirect to /login", async () => {
    for (const page of STAFF_PAGES) {
      const res = await fetch(`${BASE}${page}`, { redirect: "manual" });
      assert.ok(
        [301, 302, 307, 308].includes(res.status),
        `Expected redirect (302/307) for ${page}, got ${res.status}`
      );
      const followRes = await fetch(`${BASE}${page}`);
      assert.strictEqual(followRes.status, 200);
      assert.ok(followRes.url.includes("/login"), `Expected landing on login, got: ${followRes.url}`);
    }
  });

  await t.test("Unauthenticated access to Developer Pages → Redirect to /login", async () => {
    for (const page of DEV_PAGES) {
      const res = await fetch(`${BASE}${page}`, { redirect: "manual" });
      assert.ok(
        [301, 302, 307, 308].includes(res.status),
        `Expected redirect (302/307) for ${page}, got ${res.status}`
      );
      const followRes = await fetch(`${BASE}${page}`);
      assert.strictEqual(followRes.status, 200);
      assert.ok(followRes.url.includes("/login"), `Expected landing on login, got: ${followRes.url}`);
    }
  });
});

// =========================================================================
// 2. STAFF ROLE RBAC GATING (Admin / Organising Committee)
// =========================================================================
test("2. Staff Role RBAC Gating", async (t) => {
  if (!STAFF_EMAIL || !STAFF_PASSWORD) {
    t.skip("Staff credentials not provided. Set TEST_STAFF_EMAIL and TEST_STAFF_PASSWORD in GitHub Secrets to run.");
    return;
  }

  const session = await loginAs(BASE, STAFF_EMAIL, STAFF_PASSWORD);
  assert.ok(session && session.cookie, "Staff login failed to return session cookie");

  await t.test("Verify authenticated staff session identity via /api/auth/me", async () => {
    const res = await fetch(`${BASE}/api/auth/me`, {
      headers: { Cookie: session.cookie },
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.authenticated, true, "Expected authenticated: true");
    assert.strictEqual(data.user.role, "staff", `Expected role: staff, got ${data.user?.role}`);
  });

  // A. Staff CAN access Staff Pages (HTTP 200)
  for (const page of STAFF_PAGES) {
    await t.test(`Staff accessing Staff Page: ${page} → 200 OK`, async () => {
      const res = await fetch(`${BASE}${page}`, {
        headers: { Cookie: session.cookie },
      });
      assert.strictEqual(res.status, 200, `Expected 200 OK for staff accessing ${page}, got ${res.status}`);
      const ct = res.headers.get("content-type") || "";
      assert.ok(ct.includes("text/html"), `Expected text/html content-type for ${page}`);
    });
  }

  // B. Staff CAN call Staff APIs (HTTP 200)
  for (const { method, path } of STAFF_APIS) {
    if (method === "GET") {
      await t.test(`Staff calling Staff API: ${method} ${path} → 200 OK`, async () => {
        const res = await fetch(`${BASE}${path}`, {
          method,
          headers: { Cookie: session.cookie, Origin: BASE },
        });
        assert.strictEqual(res.status, 200, `Expected 200 OK for staff calling ${path}, got ${res.status}`);
      });
    }
  }

  // C. RBAC Boundary: Staff CANNOT access Developer Pages (Redirect to /403.html?need=developer)
  for (const page of DEV_PAGES) {
    await t.test(`Staff accessing Developer Page: ${page} → Redirect to /403.html`, async () => {
      const res = await fetch(`${BASE}${page}`, {
        headers: { Cookie: session.cookie },
      });
      // Follow all redirects (307 clean-URL + 302 auth gate) and verify we land on /403
      assert.ok(
        res.url.includes("/403"),
        `Expected final URL to contain /403 for staff attempting ${page}, got: ${res.url}`
      );
    });
  }

  // D. RBAC Boundary: Staff CANNOT call Developer APIs (HTTP 403 Forbidden)
  for (const { method, path } of DEV_APIS) {
    await t.test(`Staff calling Developer API: ${method} ${path} → 403 Forbidden`, async () => {
      const opts = {
        method,
        headers: {
          Cookie: session.cookie,
          Origin: BASE,
          "Content-Type": "application/json",
          ...(session.csrfToken ? { "X-CSRF-Token": session.csrfToken } : {}),
        },
      };
      if (method === "POST") opts.body = JSON.stringify({});
      const res = await fetch(`${BASE}${path}`, opts);
      assert.strictEqual(res.status, 403, `Expected 403 Forbidden for staff calling ${path}, got ${res.status}`);
      const data = await res.json().catch(() => ({}));
      assert.ok(
        data.error && /developer/i.test(data.error),
        `Expected error stating developer access required, got: ${JSON.stringify(data)}`
      );
    });
  }
});

// =========================================================================
// 3. DEVELOPER ROLE RBAC GATING (Developer Surface)
// =========================================================================
test("3. Developer Role RBAC Gating", async (t) => {
  if (!DEV_EMAIL || !DEV_PASSWORD) {
    t.skip("Developer credentials not provided. Set TEST_DEV_EMAIL and TEST_DEV_PASSWORD in GitHub Secrets to run.");
    return;
  }

  const session = await loginAs(BASE, DEV_EMAIL, DEV_PASSWORD);
  assert.ok(session && session.cookie, "Developer login failed to return session cookie");

  await t.test("Verify authenticated developer session identity via /api/auth/me", async () => {
    const res = await fetch(`${BASE}/api/auth/me`, {
      headers: { Cookie: session.cookie },
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.authenticated, true, "Expected authenticated: true");
    assert.strictEqual(data.user.role, "developer", `Expected role: developer, got ${data.user?.role}`);
  });

  // A. Developer CAN access Developer Pages (HTTP 200)
  for (const page of DEV_PAGES) {
    await t.test(`Developer accessing Developer Page: ${page} → 200 OK`, async () => {
      const res = await fetch(`${BASE}${page}`, {
        headers: { Cookie: session.cookie },
      });
      assert.strictEqual(res.status, 200, `Expected 200 OK for developer accessing ${page}, got ${res.status}`);
      const ct = res.headers.get("content-type") || "";
      assert.ok(ct.includes("text/html"), `Expected text/html content-type for ${page}`);
    });
  }

  // B. Developer CAN call Developer APIs (HTTP 200)
  for (const { method, path } of DEV_APIS) {
    if (method === "GET") {
      await t.test(`Developer calling Developer API: ${method} ${path} → 200 OK`, async () => {
        const res = await fetch(`${BASE}${path}`, {
          method,
          headers: { Cookie: session.cookie, Origin: BASE },
        });
        assert.strictEqual(res.status, 200, `Expected 200 OK for developer calling ${path}, got ${res.status}`);
      });
    }
  }

  // C. RBAC Boundary: Developer CANNOT access Staff Pages (Redirect to /403.html?need=staff)
  for (const page of [...STAFF_PAGES, "/register.html"]) {
    await t.test(`Developer accessing Staff Page: ${page} → Redirect to /403.html`, async () => {
      const res = await fetch(`${BASE}${page}`, {
        headers: { Cookie: session.cookie },
      });
      // Follow all redirects (307 clean-URL + 302 auth gate) and verify we land on /403
      assert.ok(
        res.url.includes("/403"),
        `Expected final URL to contain /403 for developer attempting ${page}, got: ${res.url}`
      );
    });
  }

  // D. RBAC Boundary: Developer CANNOT call Staff APIs (HTTP 403 Forbidden)
  for (const { method, path } of STAFF_APIS) {
    await t.test(`Developer calling Staff API: ${method} ${path} → 403 Forbidden`, async () => {
      const opts = {
        method,
        headers: {
          Cookie: session.cookie,
          Origin: BASE,
          "Content-Type": "application/json",
          ...(session.csrfToken ? { "X-CSRF-Token": session.csrfToken } : {}),
        },
      };
      if (method === "POST") opts.body = JSON.stringify({});
      const res = await fetch(`${BASE}${path}`, opts);
      assert.strictEqual(res.status, 403, `Expected 403 Forbidden for developer calling ${path}, got ${res.status}`);
      const data = await res.json().catch(() => ({}));
      assert.ok(
        data.error && /staff/i.test(data.error),
        `Expected error stating staff access required, got: ${JSON.stringify(data)}`
      );
    });
  }
});
