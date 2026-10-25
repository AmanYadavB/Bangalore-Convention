import test from "node:test";
import assert from "node:assert";

const BASE = (process.env.STAGING_URL || "https://bangalore-convention-staging.amankumaryadavasasmd.workers.dev").replace(/\/+$/, "");

test("Public API Health", async (t) => {
  await t.test("GET /api/pricing → JSON array with required ticket fields", async () => {
    const res = await fetch(`${BASE}/api/pricing`);
    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
    const data = await res.json();
    assert.ok(Array.isArray(data), "Expected pricing response to be an array");
    assert.ok(data.length > 0, "Pricing array is unexpectedly empty");
    const first = data[0];
    assert.ok("id" in first, "Pricing item missing 'id'");
    assert.ok("name" in first, "Pricing item missing 'name'");
    assert.ok("price" in first, "Pricing item missing 'price'");
    assert.strictEqual(typeof first.price, "number", "Ticket price should be a number");
  });

  await t.test("GET /api/site → JSON configuration and window flags", async () => {
    const res = await fetch(`${BASE}/api/site`);
    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
    const data = await res.json();
    assert.ok(typeof data.registrationsOpen === "boolean", "registrationsOpen must be boolean");
    assert.ok("checkinOpens" in data, "Missing field: checkinOpens");
    assert.ok("checkinCloses" in data, "Missing field: checkinCloses");
    assert.ok(typeof data.payment === "object" && data.payment !== null, "Missing payment config object");
  });

  await t.test("GET /api/reflections → JSON object with channelUrl and items array", async () => {
    const res = await fetch(`${BASE}/api/reflections`);
    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
    const data = await res.json();
    assert.ok(typeof data === "object" && data !== null, "Expected JSON object");
    assert.ok("channelUrl" in data, "Missing field: channelUrl");
    assert.ok(Array.isArray(data.items), "Expected items to be an array");
  });

  await t.test("GET /api/auth/me → JSON with { authenticated: false } for anonymous visitor", async () => {
    const res = await fetch(`${BASE}/api/auth/me`);
    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
    const data = await res.json();
    assert.strictEqual(data.authenticated, false, "Expected authenticated: false for anonymous visitor");
  });
});
