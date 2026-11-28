import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker, { resetSyncState } from "./worker.js";
import { pruneOldDailyDeviceState } from "./telemetry.js";

const SCHEMA_SQL = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

/** Minimal Cloudflare D1-compatible adapter backed by real in-memory SQLite (`node:sqlite`). */
function createSqliteD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(SCHEMA_SQL);

  function wrapStatement(sql, params = []) {
    return {
      sql,
      params,
      bind(...args) {
        return wrapStatement(sql, args);
      },
      async first() {
        const stmt = sqlite.prepare(sql);
        const row = stmt.get(...params);
        return row === undefined ? null : { ...row };
      },
      async all() {
        const stmt = sqlite.prepare(sql);
        const rows = stmt.all(...params).map((r) => ({ ...r }));
        return { success: true, results: rows };
      },
      async run() {
        const stmt = sqlite.prepare(sql);
        const info = stmt.run(...params);
        return { success: true, meta: { changes: info.changes } };
      },
    };
  }

  return {
    sqlite,
    prepare(sql) {
      return wrapStatement(sql);
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const s of statements) {
          const stmt = sqlite.prepare(s.sql);
          if (/^\s*SELECT\b/iu.test(s.sql)) {
            results.push({ success: true, results: stmt.all(...s.params).map((r) => ({ ...r })) });
          } else {
            const info = stmt.run(...s.params);
            results.push({ success: true, results: [], meta: { changes: info.changes } });
          }
        }
        sqlite.exec("COMMIT");
        return results;
      } catch (err) {
        sqlite.exec("ROLLBACK");
        throw err;
      }
    },
  };
}

function makeCtx() {
  const pending = [];
  return {
    waitUntil(p) {
      pending.push(Promise.resolve(p));
    },
    async flush() {
      await Promise.all(pending);
    },
  };
}

async function withFakeNow(msOrFn, fn) {
  const originalNow = Date.now;
  Date.now = typeof msOrFn === "function" ? msOrFn : () => msOrFn;
  resetSyncState();
  try {
    return await fn();
  } finally {
    Date.now = originalNow;
    resetSyncState();
  }
}

test("D1 POST /install/:id atomically increments totals and daily counts, served by GET /stats.json", async () => {
  const db = createSqliteD1();
  const env = { STATS_DB: db };
  const ctx = makeCtx();

  await withFakeNow(Date.parse("2026-11-28T10:00:00Z"), async () => {
    const r1 = await worker.fetch(
      new Request("https://ext-stats.chost.dev/install/sidebar-thread-tree", { method: "POST" }),
      env,
      ctx,
    );
    assert.equal(r1.status, 200);
    assert.deepEqual(await r1.json(), { id: "sidebar-thread-tree", downloads: 1 });

    const r2 = await worker.fetch(
      new Request("https://ext-stats.chost.dev/install/sidebar-thread-tree", { method: "POST" }),
      env,
      ctx,
    );
    assert.equal(r2.status, 200);
    assert.deepEqual(await r2.json(), { id: "sidebar-thread-tree", downloads: 2 });

    const statsRes = await worker.fetch(
      new Request("https://ext-stats.chost.dev/stats.json", { method: "GET" }),
      env,
      ctx,
    );
    assert.equal(statsRes.status, 200);
    assert.equal(statsRes.headers.get("cache-control"), "public, max-age=300, s-maxage=300");
    const stats = await statsRes.json();
    assert.deepEqual(stats.downloads, { "sidebar-thread-tree": 2 });

    const healthRes = await worker.fetch(
      new Request("https://ext-stats.chost.dev/health", { method: "GET" }),
      env,
      ctx,
    );
    const health = await healthRes.json();
    assert.equal(health.ok, true);
    assert.equal(health.storage, "d1");
  });
});

test("POST /v1/telemetry/heartbeat validates input, merges same-day updates idempotently, and tracks official vs self-hosted remote access", async () => {
  const db = createSqliteD1();
  const env = { STATS_DB: db, DASHBOARD_TOKEN: "test-admin-secret-123" };
  const ctx = makeCtx();

  const devA = "11111111-1111-4111-8111-111111111111";
  const devB = "22222222-2222-4222-8222-222222222222";

  await withFakeNow(Date.parse("2026-11-28T02:00:00Z"), async () => {
    // Reject invalid installId
    const bad = await worker.fetch(
      new Request("https://ext-stats.chost.dev/v1/telemetry/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ installId: "not-a-uuid" }),
      }),
      env,
      ctx,
    );
    assert.equal(bad.status, 400);

    // First heartbeat from devA (morning: Desktop only)
    const req1 = new Request("https://ext-stats.chost.dev/v1/telemetry/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        installId: devA,
        appVersion: "0.28.1",
        codexDesktopVersion: "26.1023.50603",
        os: "darwin",
        arch: "arm64",
        locale: "zh_CN.UTF-8",
        surfaces: ["codex-desktop"],
        harnesses: ["codex", "claude-code", "invalid-harness-should-drop"],
        extensions: ["sidebar-thread-tree", "BAD_ID!"],
        remoteConfigured: ["official-relay"],
        features: ["delegation"],
      }),
    });
    Object.defineProperty(req1, "cf", { value: { country: "CN" } });
    const h1 = await worker.fetch(req1, env, ctx);
    assert.equal(h1.status, 200);
    assert.deepEqual(await h1.json(), { ok: true, day: "2026-11-28", newDevice: true });

    // Second heartbeat from SAME devA later the same day: upgraded to 0.28.2, used Official Relay 3 times & Pi
    const req2 = new Request("https://ext-stats.chost.dev/v1/telemetry/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        installId: devA,
        appVersion: "0.28.2",
        codexDesktopVersion: "26.1023.50603",
        os: "darwin",
        arch: "arm64",
        locale: "zh-CN",
        surfaces: ["codex-desktop", "web", "web-mobile"],
        harnesses: ["codex", "claude-code", "pi"],
        extensions: ["sidebar-thread-tree"],
        remoteAccess: ["official-relay"],
        remoteAccessCounts: { "official-relay": 3 },
        remoteConfigured: ["official-relay"],
        features: ["delegation", "notifications"],
      }),
    });
    Object.defineProperty(req2, "cf", { value: { country: "CN" } });
    const h2 = await worker.fetch(req2, env, ctx);
    assert.equal(h2.status, 200);
    assert.deepEqual(await h2.json(), { ok: true, day: "2026-11-28", newDevice: false });

    // Third heartbeat from devA with higher remoteAccessCounts (5 -> delta +2, NOT +5!)
    const req3 = new Request("https://ext-stats.chost.dev/v1/telemetry/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        installId: devA,
        remoteAccessCounts: { "official-relay": 5 },
      }),
    });
    assert.equal((await worker.fetch(req3, env, ctx)).status, 200);

    // Heartbeat from devB using self-hosted relay + tailscale-serve
    const reqB = new Request("https://ext-stats.chost.dev/v1/telemetry/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        installId: devB,
        appVersion: "0.28.2",
        os: "linux",
        arch: "x64",
        locale: "en-US",
        surfaces: ["web"],
        harnesses: ["antigravity"],
        remoteAccess: ["self-hosted-relay", "tailscale-serve"],
        remoteAccessCounts: { "self-hosted-relay": 4, "tailscale-serve": 2 },
        remoteConfigured: ["self-hosted-relay", "tailscale-serve"],
        features: ["no-codex-account", "remote-peer"],
      }),
    });
    Object.defineProperty(reqB, "cf", { value: { country: "US" } });
    assert.equal((await worker.fetch(reqB, env, ctx)).status, 200);

    // Dashboard overview via Bearer token
    const overviewRes = await worker.fetch(
      new Request("https://ext-stats.chost.dev/v1/dashboard/overview?days=7", {
        headers: { Authorization: "Bearer test-admin-secret-123" },
      }),
      env,
      ctx,
    );
    assert.equal(overviewRes.status, 200);
    const data = await overviewRes.json();

    assert.equal(data.summary.dauToday, 2);
    assert.equal(data.summary.newUsersToday, 2);
    assert.equal(data.summary.wau, 2);
    assert.equal(data.summary.mau, 2);
    assert.equal(data.summary.totalDevices, 2);
    assert.equal(data.summary.remoteUsersToday, 2);
    assert.equal(data.summary.remoteSessionsToday, 11); // 5 official + 4 self-hosted + 2 tailscale-serve

    // Version transition: 0.28.1 should be decremented to 0, both devices now counted on 0.28.2
    assert.deepEqual(data.breakdowns.appVersions.today, [{ dim: "0.28.2", count: 2 }]);
    assert.deepEqual(data.breakdowns.remoteAccess.today, [
      { dim: "official-relay", count: 1 },
      { dim: "self-hosted-relay", count: 1 },
      { dim: "tailscale-serve", count: 1 },
    ]);
    assert.deepEqual(data.breakdowns.remoteAccessSessions.today, [
      { dim: "official-relay", count: 5 },
      { dim: "self-hosted-relay", count: 4 },
      { dim: "tailscale-serve", count: 2 },
    ]);
    assert.deepEqual(
      data.breakdowns.harnesses.today.map((x) => x.dim),
      ["antigravity", "claude-code", "codex", "pi"],
    );
  });
});

test("Multi-day retention (D1 / D7 / W1), WAU/MAU, and daily_device_state pruning work accurately", async () => {
  const db = createSqliteD1();
  const env = { STATS_DB: db, DASHBOARD_TOKEN: "secret-key" };
  const ctx = makeCtx();
  const dev1 = "33333333-3333-4333-8333-333333333333";
  const dev2 = "44444444-4444-4444-8444-444444444444";

  const send = async (dayIso, installId) =>
    withFakeNow(Date.parse(dayIso), () =>
      worker.fetch(
        new Request("https://ext-stats.chost.dev/v1/telemetry/heartbeat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ installId, appVersion: "0.28.2", os: "darwin", arch: "arm64" }),
        }),
        env,
        ctx,
      ),
    );

  // Day 0 (2026-11-01): dev1 and dev2 join
  assert.equal((await send("2026-11-01T09:00:00Z", dev1)).status, 200);
  assert.equal((await send("2026-11-01T10:00:00Z", dev2)).status, 200);
  // Day 1 (2026-11-02): dev1 returns (D1 + W1)
  assert.equal((await send("2026-11-02T09:00:00Z", dev1)).status, 200);
  // Day 7 (2026-11-08): dev1 returns again (D7); dev2 never returned
  assert.equal((await send("2026-11-08T09:00:00Z", dev1)).status, 200);

  await withFakeNow(Date.parse("2026-11-08T12:00:00Z"), async () => {
    const res = await worker.fetch(
      new Request("https://ext-stats.chost.dev/v1/dashboard/overview?days=14", {
        headers: { Authorization: "Bearer secret-key" },
      }),
      env,
      ctx,
    );
    const data = await res.json();
    assert.equal(data.summary.totalDevices, 2);
    assert.equal(data.summary.mau, 2);
    assert.equal(data.summary.retention.d1Cohort, 2);
    assert.equal(data.summary.retention.d1Returned, 1);
    assert.equal(data.summary.retention.d1Rate, 0.5);
    assert.equal(data.summary.retention.d7Cohort, 2);
    assert.equal(data.summary.retention.d7Returned, 1);
    assert.equal(data.summary.retention.d7Rate, 0.5);
    assert.equal(data.summary.retention.w1Rate, 0.5);
  });

  // Prune 20 days later removes old daily_device_state rows while keeping devices/metrics intact
  await pruneOldDailyDeviceState(db, Date.parse("2026-11-28T00:00:00Z"));
  const remaining = await db.prepare("SELECT COUNT(*) as c FROM daily_device_state").first();
  assert.equal(remaining.c, 0);
  const devicesStill = await db.prepare("SELECT COUNT(*) as c FROM devices").first();
  assert.equal(devicesStill.c, 2);
});

test("Dashboard cookie auth rejects invalid tokens and grants signed session cookie", async () => {
  const db = createSqliteD1();
  const env = { STATS_DB: db, DASHBOARD_TOKEN: "top-secret-token" };
  const ctx = makeCtx();

  // Unauthenticated overview -> 401
  const unauth = await worker.fetch(
    new Request("https://ext-stats.chost.dev/v1/dashboard/overview"),
    env,
    ctx,
  );
  assert.equal(unauth.status, 401);

  // Wrong token -> 401
  const badLogin = await worker.fetch(
    new Request("https://ext-stats.chost.dev/v1/dashboard/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "wrong" }),
    }),
    env,
    ctx,
  );
  assert.equal(badLogin.status, 401);

  // Correct token -> 200 + HttpOnly Secure SameSite=Strict cookie
  const goodLogin = await worker.fetch(
    new Request("https://ext-stats.chost.dev/v1/dashboard/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "top-secret-token" }),
    }),
    env,
    ctx,
  );
  assert.equal(goodLogin.status, 200);
  const setCookie = goodLogin.headers.get("set-cookie");
  assert.ok(setCookie?.startsWith("__Host-ch_dash_session=v1."));
  assert.ok(setCookie.includes("HttpOnly"));
  assert.ok(setCookie.includes("Secure"));

  const cookiePair = setCookie.split(";")[0];

  // Overview with signed cookie -> 200
  const authedOverview = await worker.fetch(
    new Request("https://ext-stats.chost.dev/v1/dashboard/overview?days=7", {
      headers: { Cookie: cookiePair },
    }),
    env,
    ctx,
  );
  assert.equal(authedOverview.status, 200);

  // Dashboard HTML renders authenticated boot flag
  const htmlRes = await worker.fetch(
    new Request("https://ext-stats.chost.dev/dashboard", {
      headers: { Cookie: cookiePair },
    }),
    env,
    ctx,
  );
  assert.equal(htmlRes.status, 200);
  const html = await htmlRes.text();
  assert.ok(html.includes('"authenticated":true'));
});
