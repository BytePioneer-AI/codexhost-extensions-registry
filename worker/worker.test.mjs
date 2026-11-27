import test from "node:test";
import assert from "node:assert/strict";
import worker, { checkAndDispatchSync, refreshStatsSnapshot, resetSyncState } from "./worker.js";

function createMockKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  const stats = { getCalls: 0, putCalls: 0, listCalls: 0 };
  return {
    store,
    stats,
    async get(keyOrKeys) {
      stats.getCalls += 1;
      if (Array.isArray(keyOrKeys)) {
        const result = new Map();
        for (const key of keyOrKeys) {
          result.set(key, store.has(key) ? store.get(key) : null);
        }
        return result;
      }
      return store.has(keyOrKeys) ? store.get(keyOrKeys) : null;
    },
    async put(key, value) {
      stats.putCalls += 1;
      store.set(key, value);
    },
    async list({ prefix = "" } = {}) {
      stats.listCalls += 1;
      const keys = [...store.keys()]
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

function createMockEdgeCache() {
  const entries = new Map();
  const stats = { matchCalls: 0, putCalls: 0, keys: [] };
  return {
    stats,
    async match(request) {
      stats.matchCalls += 1;
      const key = typeof request === "string" ? request : request.url;
      const cached = entries.get(key);
      return cached ? cached.clone() : undefined;
    },
    async put(request, response) {
      stats.putCalls += 1;
      const key = typeof request === "string" ? request : request.url;
      stats.keys.push(key);
      entries.set(key, response.clone());
    },
  };
}

function makeRegistryGraphQLResponse(sources, catalogExtensions) {
  return Response.json({
    data: {
      repository: {
        sources: {
          entries: [
            { name: ".gitkeep", type: "blob", object: { text: "" } },
            ...sources.map((source) => ({
              name: `${source.id}.json`,
              type: "blob",
              object: { text: JSON.stringify(source) },
            })),
          ],
        },
        catalog: {
          text: JSON.stringify({
            schemaVersion: 2,
            generatedAt: "2026-11-27T04:03:16.128Z",
            extensions: catalogExtensions,
          }),
        },
      },
    },
  });
}

async function withMockedGlobals({ fetchImpl, cachesValue, nowMs }, fn) {
  const originalFetch = globalThis.fetch;
  const hasCaches = Object.hasOwn(globalThis, "caches");
  const originalCaches = globalThis.caches;
  const originalNow = Date.now;

  if (fetchImpl) globalThis.fetch = fetchImpl;
  if (cachesValue !== undefined) {
    Object.defineProperty(globalThis, "caches", {
      value: cachesValue,
      configurable: true,
      writable: true,
    });
  }
  if (typeof nowMs === "function") Date.now = nowMs;

  try {
    resetSyncState();
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
    if (cachesValue !== undefined) {
      if (hasCaches) {
        Object.defineProperty(globalThis, "caches", {
          value: originalCaches,
          configurable: true,
          writable: true,
        });
      } else {
        delete globalThis.caches;
      }
    }
    Date.now = originalNow;
    resetSyncState();
  }
}

function makeCtx() {
  const pending = [];
  return {
    waitUntil(promise) {
      pending.push(Promise.resolve(promise));
    },
    async flush() {
      await Promise.all(pending);
    },
  };
}

test("GraphQL batch check uses exactly 2 fetches for 35 unchanged extensions and does not dispatch", async () => {
  const sources = [];
  const catalog = [];
  const repoMap = new Map();

  for (let i = 0; i < 35; i += 1) {
    const id = `ext-${i}`;
    const owner = `owner-${i}`;
    const repo = `repo-${i}`;
    const downloadUrl = `https://github.com/${owner}/${repo}/releases/download/v1.0.0/${id}-1.0.0.zip`;
    sources.push({ id, repository: `https://github.com/${owner}/${repo}`, trustTier: "community" });
    catalog.push({ id, downloadUrl });
    repoMap.set(`${owner}/${repo}`, {
      latestRelease: {
        isDraft: false,
        isPrerelease: false,
        publishedAt: "2026-11-26T00:00:00Z",
        releaseAssets: {
          nodes: [
            { name: "icon.png", downloadUrl: `https://github.com/${owner}/${repo}/releases/download/v1.0.0/icon.png` },
            { name: `${id}-1.0.0.zip`, downloadUrl },
          ],
        },
      },
      defaultBranchRef: { target: { oid: "a".repeat(40) } },
    });
  }

  const calls = [];
  await withMockedGlobals(
    {
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : null });
        if (String(url) === "https://api.github.com/graphql") {
          const { query, variables } = JSON.parse(init.body);
          if (query.includes("query RegistryState")) {
            return makeRegistryGraphQLResponse(sources, catalog);
          }
          const data = {};
          for (let i = 0; Object.hasOwn(variables, `o${i}`); i += 1) {
            data[`r${i}`] = repoMap.get(`${variables[`o${i}`]}/${variables[`n${i}`]}`);
          }
          return Response.json({ data });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
    },
    async () => {
      const ctx = makeCtx();
      await worker.scheduled({}, { GITHUB_TOKEN: "ghp_test_token" }, ctx);
      await ctx.flush();

      assert.equal(calls.length, 2);
      assert.equal(calls[0].url, "https://api.github.com/graphql");
      assert.equal(calls[1].url, "https://api.github.com/graphql");

      const healthRes = await worker.fetch(new Request("https://stats.example.com/health"), {});
      const health = await healthRes.json();
      assert.equal(health.ok, true);
      assert.equal(health.sync.ok, true);
      assert.equal(health.sync.needsSync, false);
      assert.equal(health.sync.dispatched, false);
      assert.equal(health.sync.sourceCount, 35);
      assert.equal(health.sync.error, null);
    },
  );
});

test("GraphQL batching splits >40 unique repositories into multiple batches", async () => {
  const sources = [];
  const catalog = [];
  for (let i = 0; i < 45; i += 1) {
    const id = `ext-${i}`;
    const downloadUrl = `https://github.com/org/repo-${i}/releases/download/v1.0.0/${id}.zip`;
    sources.push({ id, repository: `https://github.com/org/repo-${i}` });
    catalog.push({ id, downloadUrl });
  }

  let fetchCount = 0;
  await withMockedGlobals(
    {
      fetchImpl: async (url, init) => {
        fetchCount += 1;
        assert.equal(String(url), "https://api.github.com/graphql");
        const { query, variables } = JSON.parse(init.body);
        if (query.includes("query RegistryState")) {
          return makeRegistryGraphQLResponse(sources, catalog);
        }
        const data = {};
        for (let i = 0; Object.hasOwn(variables, `o${i}`); i += 1) {
          const owner = variables[`o${i}`];
          const repo = variables[`n${i}`];
          const idx = repo.slice("repo-".length);
          data[`r${i}`] = {
            latestRelease: {
              isDraft: false,
              isPrerelease: false,
              publishedAt: "2026-11-26T00:00:00Z",
              releaseAssets: {
                nodes: [
                  {
                    name: `ext-${idx}.zip`,
                    downloadUrl: `https://github.com/${owner}/${repo}/releases/download/v1.0.0/ext-${idx}.zip`,
                  },
                ],
              },
            },
            defaultBranchRef: { target: { oid: "b".repeat(40) } },
          };
        }
        return Response.json({ data });
      },
    },
    async () => {
      const summary = await checkAndDispatchSync({ GITHUB_TOKEN: "ghp_test_token" });
      assert.equal(summary.ok, true);
      assert.equal(summary.needsSync, false);
      assert.equal(summary.dispatched, false);
      assert.equal(fetchCount, 3);
    },
  );
});

test("Dispatches workflow when an extension publishes a new Release .zip asset", async () => {
  const sources = [
    {
      id: "hdd-fairy",
      repository: "https://github.com/biground/codex-host-theme-hdd-fairy",
      trustTier: "community",
    },
  ];
  const catalog = [
    {
      id: "hdd-fairy",
      downloadUrl:
        "https://github.com/biground/codex-host-theme-hdd-fairy/releases/download/v2.0.1/hdd-fairy-2.0.1.zip",
    },
  ];

  const dispatchCalls = [];
  await withMockedGlobals(
    {
      fetchImpl: async (url, init) => {
        const href = String(url);
        if (href === "https://api.github.com/graphql") {
          const { query } = JSON.parse(init.body);
          if (query.includes("query RegistryState")) {
            return makeRegistryGraphQLResponse(sources, catalog);
          }
          return Response.json({
            data: {
              r0: {
                latestRelease: {
                  isDraft: false,
                  isPrerelease: false,
                  publishedAt: "2026-11-27T08:00:00Z",
                  releaseAssets: {
                    nodes: [
                      {
                        name: "icon-180.png",
                        downloadUrl:
                          "https://github.com/biground/codex-host-theme-hdd-fairy/releases/download/v2.2.0/icon-180.png",
                      },
                      {
                        name: "hdd-fairy-2.2.0.zip",
                        downloadUrl:
                          "https://github.com/biground/codex-host-theme-hdd-fairy/releases/download/v2.2.0/hdd-fairy-2.2.0.zip",
                      },
                    ],
                  },
                },
                defaultBranchRef: { target: { oid: "1".repeat(40) } },
              },
            },
          });
        }
        if (
          href ===
          "https://api.github.com/repos/BytePioneer-AI/codexhost-extensions-registry/actions/workflows/registry-sync.yml/dispatches"
        ) {
          dispatchCalls.push({ method: init.method, body: JSON.parse(init.body) });
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected fetch: ${href}`);
      },
    },
    async () => {
      const summary = await checkAndDispatchSync({ GITHUB_TOKEN: "ghp_test_token" });
      assert.equal(summary.ok, true);
      assert.equal(summary.needsSync, true);
      assert.equal(summary.dispatched, true);
      assert.equal(dispatchCalls.length, 1);
      assert.deepEqual(dispatchCalls[0], { method: "POST", body: { ref: "main" } });
    },
  );
});

test("Respects source.asset disambiguation and never falls back to default branch when source.asset is set", async () => {
  const sources = [
    {
      id: "multi-zip",
      repository: "https://github.com/example/multi-zip",
      asset: "target.zip",
    },
  ];
  const catalog = [
    {
      id: "multi-zip",
      downloadUrl: "https://github.com/example/multi-zip/releases/download/v1.0.0/target.zip",
    },
  ];

  let dispatched = false;
  await withMockedGlobals(
    {
      fetchImpl: async (url, init) => {
        const href = String(url);
        if (href === "https://api.github.com/graphql") {
          const { query } = JSON.parse(init.body);
          if (query.includes("query RegistryState")) {
            return makeRegistryGraphQLResponse(sources, catalog);
          }
          // Missing target.zip in release; must NOT fall back to defaultBranchRef zipball URL.
          return Response.json({
            data: {
              r0: {
                latestRelease: {
                  isDraft: false,
                  isPrerelease: false,
                  publishedAt: "2026-11-27T08:00:00Z",
                  releaseAssets: {
                    nodes: [
                      {
                        name: "other.zip",
                        downloadUrl:
                          "https://github.com/example/multi-zip/releases/download/v1.1.0/other.zip",
                      },
                    ],
                  },
                },
                defaultBranchRef: { target: { oid: "c".repeat(40) } },
              },
            },
          });
        }
        dispatched = true;
        return new Response(null, { status: 204 });
      },
    },
    async () => {
      const summary = await checkAndDispatchSync({ GITHUB_TOKEN: "ghp_test_token" });
      assert.equal(summary.ok, true);
      assert.equal(summary.needsSync, false);
      assert.equal(dispatched, false);
    },
  );
});

test("Does not fall back to default branch when latest release has multiple ambiguous .zip assets", async () => {
  const sources = [
    {
      id: "ambiguous-zip",
      repository: "https://github.com/example/ambiguous-zip",
    },
  ];
  const catalog = [
    {
      id: "ambiguous-zip",
      downloadUrl: "https://github.com/example/ambiguous-zip/releases/download/v1.0.0/ext.zip",
    },
  ];

  let dispatched = false;
  await withMockedGlobals(
    {
      fetchImpl: async (url, init) => {
        const href = String(url);
        if (href === "https://api.github.com/graphql") {
          const { query } = JSON.parse(init.body);
          if (query.includes("query RegistryState")) {
            return makeRegistryGraphQLResponse(sources, catalog);
          }
          return Response.json({
            data: {
              r0: {
                latestRelease: {
                  isDraft: false,
                  isPrerelease: false,
                  publishedAt: "2026-11-27T08:00:00Z",
                  releaseAssets: {
                    nodes: [
                      {
                        name: "a.zip",
                        downloadUrl:
                          "https://github.com/example/ambiguous-zip/releases/download/v1.1.0/a.zip",
                      },
                      {
                        name: "b.zip",
                        downloadUrl:
                          "https://github.com/example/ambiguous-zip/releases/download/v1.1.0/b.zip",
                      },
                    ],
                  },
                },
                defaultBranchRef: { target: { oid: "e".repeat(40) } },
              },
            },
          });
        }
        dispatched = true;
        return new Response(null, { status: 204 });
      },
    },
    async () => {
      const summary = await checkAndDispatchSync({ GITHUB_TOKEN: "ghp_test_token" });
      assert.equal(summary.ok, true);
      assert.equal(summary.needsSync, false);
      assert.equal(dispatched, false);
    },
  );
});

test("Matches default-branch zipball URL format and dispatches when HEAD commit changes", async () => {
  const oldSha = "127af5944ae2e8370af0f68c15d3cf129c470ef8";
  const newSha = "999af5944ae2e8370af0f68c15d3cf129c470ef8";
  const sources = [
    {
      id: "sidebar-delegation-badges",
      repository: "https://github.com/lpmasser/codexhost-sidebar-delegation-badges",
      trustTier: "community",
    },
  ];
  const catalog = [
    {
      id: "sidebar-delegation-badges",
      downloadUrl: `https://api.github.com/repos/lpmasser/codexhost-sidebar-delegation-badges/zipball/${oldSha}`,
    },
  ];

  let activeSha = oldSha;
  let dispatchCount = 0;

  await withMockedGlobals(
    {
      fetchImpl: async (url, init) => {
        const href = String(url);
        if (href === "https://api.github.com/graphql") {
          const { query } = JSON.parse(init.body);
          if (query.includes("query RegistryState")) {
            return makeRegistryGraphQLResponse(sources, catalog);
          }
          return Response.json({
            data: {
              r0: {
                latestRelease: null,
                defaultBranchRef: { target: { oid: activeSha } },
              },
            },
          });
        }
        if (href.endsWith("/dispatches")) {
          dispatchCount += 1;
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected fetch: ${href}`);
      },
    },
    async () => {
      const first = await checkAndDispatchSync({ GITHUB_TOKEN: "ghp_test_token" });
      assert.equal(first.needsSync, false);
      assert.equal(dispatchCount, 0);

      activeSha = newSha;
      const second = await checkAndDispatchSync({ GITHUB_TOKEN: "ghp_test_token" });
      assert.equal(second.needsSync, true);
      assert.equal(second.dispatched, true);
      assert.equal(dispatchCount, 1);
    },
  );
});

test("Dispatches immediately when a catalog extension has been removed from sources/", async () => {
  const sources = [
    { id: "kept-ext", repository: "https://github.com/org/kept-ext" },
  ];
  const catalog = [
    {
      id: "kept-ext",
      downloadUrl: "https://github.com/org/kept-ext/releases/download/v1.0.0/kept-ext.zip",
    },
    {
      id: "removed-ext",
      downloadUrl: "https://github.com/org/removed-ext/releases/download/v1.0.0/removed-ext.zip",
    },
  ];

  const urls = [];
  await withMockedGlobals(
    {
      fetchImpl: async (url, init) => {
        const href = String(url);
        urls.push(href);
        if (href === "https://api.github.com/graphql") {
          const { query } = JSON.parse(init.body);
          assert.ok(query.includes("query RegistryState"));
          return makeRegistryGraphQLResponse(sources, catalog);
        }
        if (href.endsWith("/dispatches")) {
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected fetch: ${href}`);
      },
    },
    async () => {
      const summary = await checkAndDispatchSync({ GITHUB_TOKEN: "ghp_test_token" });
      assert.equal(summary.ok, true);
      assert.equal(summary.needsSync, true);
      assert.equal(summary.dispatched, true);
      assert.equal(urls.length, 2);
    },
  );
});

test("GraphQL partial error (null repo + errors) does not block healthy extension sync", async () => {
  const sources = [
    { id: "deleted-repo", repository: "https://github.com/gone/deleted-repo" },
    { id: "hdd-fairy", repository: "https://github.com/biground/codex-host-theme-hdd-fairy" },
  ];
  const catalog = [
    {
      id: "deleted-repo",
      downloadUrl: "https://github.com/gone/deleted-repo/releases/download/v1.0.0/deleted-repo.zip",
    },
    {
      id: "hdd-fairy",
      downloadUrl:
        "https://github.com/biground/codex-host-theme-hdd-fairy/releases/download/v2.0.1/hdd-fairy-2.0.1.zip",
    },
  ];

  let dispatchCount = 0;
  await withMockedGlobals(
    {
      fetchImpl: async (url, init) => {
        const href = String(url);
        if (href === "https://api.github.com/graphql") {
          const { query } = JSON.parse(init.body);
          if (query.includes("query RegistryState")) {
            return makeRegistryGraphQLResponse(sources, catalog);
          }
          return Response.json({
            data: {
              r0: null,
              r1: {
                latestRelease: {
                  isDraft: false,
                  isPrerelease: false,
                  publishedAt: "2026-11-27T09:00:00Z",
                  releaseAssets: {
                    nodes: [
                      {
                        name: "hdd-fairy-2.2.0.zip",
                        downloadUrl:
                          "https://github.com/biground/codex-host-theme-hdd-fairy/releases/download/v2.2.0/hdd-fairy-2.2.0.zip",
                      },
                    ],
                  },
                },
                defaultBranchRef: { target: { oid: "2".repeat(40) } },
              },
            },
            errors: [
              {
                type: "NOT_FOUND",
                path: ["r0"],
                message: "Could not resolve to a Repository with the name 'gone/deleted-repo'.",
              },
            ],
          });
        }
        if (href.endsWith("/dispatches")) {
          dispatchCount += 1;
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected fetch: ${href}`);
      },
    },
    async () => {
      const summary = await checkAndDispatchSync({ GITHUB_TOKEN: "ghp_test_token" });
      assert.equal(summary.ok, true);
      assert.equal(summary.needsSync, true);
      assert.equal(summary.dispatched, true);
      assert.equal(summary.error, null);
      assert.equal(dispatchCount, 1);
    },
  );
});

test("/health exposes sanitized sync status without leaking secrets and throttles KV writes", async () => {
  const secretToken = "ghp_SUPER_SECRET_DO_NOT_LEAK_12345";
  const kv = createMockKv();
  let currentNow = Date.parse("2026-11-27T10:00:00.000Z");
  let mode = "ok";

  const sources = [{ id: "ext-a", repository: "https://github.com/org/ext-a" }];
  const catalog = [
    {
      id: "ext-a",
      downloadUrl: "https://github.com/org/ext-a/releases/download/v1.0.0/ext-a.zip",
    },
  ];

  await withMockedGlobals(
    {
      nowMs: () => currentNow,
      fetchImpl: async (url, init) => {
        const href = String(url);
        if (mode === "unauthorized") {
          return new Response(`Bad credentials for Bearer ${secretToken}`, { status: 401 });
        }
        if (href === "https://api.github.com/graphql") {
          const { query } = JSON.parse(init.body);
          if (query.includes("query RegistryState")) {
            return makeRegistryGraphQLResponse(sources, catalog);
          }
          const version = mode === "updated" ? "v1.1.0" : "v1.0.0";
          return Response.json({
            data: {
              r0: {
                latestRelease: {
                  isDraft: false,
                  isPrerelease: false,
                  publishedAt: "2026-11-27T09:00:00Z",
                  releaseAssets: {
                    nodes: [
                      {
                        name: "ext-a.zip",
                        downloadUrl: `https://github.com/org/ext-a/releases/download/${version}/ext-a.zip`,
                      },
                    ],
                  },
                },
                defaultBranchRef: { target: { oid: "d".repeat(40) } },
              },
            },
          });
        }
        if (href.endsWith("/dispatches")) {
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected fetch: ${href}`);
      },
    },
    async () => {
      const env = { GITHUB_TOKEN: secretToken, STATS_KV: kv };

      // 1. Initial successful check persists to KV.
      await checkAndDispatchSync(env);
      assert.equal(kv.stats.putCalls, 1);

      // 2. Repeated unchanged check 5 minutes later does NOT write to KV.
      currentNow += 5 * 60 * 1000;
      await checkAndDispatchSync(env);
      assert.equal(kv.stats.putCalls, 1);

      // 3. After cold start, hydrating from KV still avoids rewriting within 1 hour.
      resetSyncState();
      currentNow += 5 * 60 * 1000;
      await checkAndDispatchSync(env);
      assert.equal(kv.stats.putCalls, 1);

      // 4. Failure state transition writes to KV and sanitizes error (no token/header leak).
      mode = "unauthorized";
      currentNow += 5 * 60 * 1000;
      await checkAndDispatchSync(env);
      assert.equal(kv.stats.putCalls, 2);

      const healthRes = await worker.fetch(new Request("https://stats.example.com/health"), env);
      assert.equal(healthRes.status, 200);
      const rawHealth = await healthRes.text();
      assert.equal(rawHealth.includes(secretToken), false);
      assert.equal(rawHealth.includes("Bearer"), false);
      assert.equal(rawHealth.includes("Authorization"), false);
      const health = JSON.parse(rawHealth);
      assert.equal(health.ok, true);
      assert.equal(health.sync.ok, false);
      assert.equal(health.sync.error, "GitHub GraphQL HTTP 401");

      // 5. Repeated failure within 15 minutes does NOT rewrite KV.
      currentNow += 5 * 60 * 1000;
      await checkAndDispatchSync(env);
      assert.equal(kv.stats.putCalls, 2);

      // 6. Failure persisting >=15 minutes triggers periodic refresh write.
      currentNow += 16 * 60 * 1000;
      await checkAndDispatchSync(env);
      assert.equal(kv.stats.putCalls, 3);

      // 7. Recovery + dispatch writes to KV.
      mode = "updated";
      currentNow += 5 * 60 * 1000;
      await checkAndDispatchSync(env);
      assert.equal(kv.stats.putCalls, 4);

      // 8. Warm isolate with >10m old in-memory sync refreshes newer state from KV on /health.
      const newerSummary = {
        checkedAt: new Date(currentNow + 12 * 60 * 1000).toISOString(),
        ok: true,
        needsSync: false,
        dispatched: false,
        sourceCount: 1,
        error: null,
      };
      await kv.put("meta:last-sync-check", JSON.stringify(newerSummary));
      currentNow += 12 * 60 * 1000;
      const refreshedHealthRes = await worker.fetch(new Request("https://stats.example.com/health"), env);
      const refreshedHealth = await refreshedHealthRes.json();
      assert.equal(refreshedHealth.sync.checkedAt, newerSummary.checkedAt);

      // 9. Cold-start /health reads from KV cleanly; KV failure still returns { ok: true, sync: null }.
      resetSyncState();
      const coldHealthRes = await worker.fetch(new Request("https://stats.example.com/health"), env);
      const coldHealth = await coldHealthRes.json();
      assert.equal(coldHealth.ok, true);
      assert.equal(coldHealth.sync.checkedAt, newerSummary.checkedAt);

      resetSyncState();
      const brokenKv = {
        async get() {
          throw new Error("KV quota exceeded");
        },
      };
      const fallbackRes = await worker.fetch(new Request("https://stats.example.com/health"), {
        STATS_KV: brokenKv,
      });
      assert.equal(fallbackRes.status, 200);
      assert.deepEqual(await fallbackRes.json(), { ok: true, sync: null });
    },
  );
});

test("/stats.json uses Edge Cache to avoid repeated kv.list() calls and POST /install/:id updates counts", async () => {
  const kv = createMockKv({
    "count:hdd-fairy": "42",
    "meta:last-sync-check": JSON.stringify({ ok: true }),
  });
  const edgeCache = createMockEdgeCache();

  await withMockedGlobals(
    {
      cachesValue: { default: edgeCache },
    },
    async () => {
      const env = { STATS_KV: kv };

      // OPTIONS CORS preflight
      const optRes = await worker.fetch(
        new Request("https://stats.example.com/stats.json", { method: "OPTIONS" }),
        env,
      );
      assert.equal(optRes.status, 204);
      assert.equal(optRes.headers.get("Access-Control-Allow-Origin"), "*");

      // First GET /stats.json -> cache miss, hits KV once, populates normalized cache key.
      const ctx1 = makeCtx();
      const res1 = await worker.fetch(
        new Request("https://stats.example.com/stats.json?v=1"),
        env,
        ctx1,
      );
      await ctx1.flush();
      assert.equal(res1.status, 200);
      assert.equal(res1.headers.get("Cache-Control"), "public, max-age=300, s-maxage=300");
      assert.equal(res1.headers.get("Access-Control-Allow-Origin"), "*");
      const body1 = await res1.json();
      assert.deepEqual(body1.downloads, { "hdd-fairy": 42 });
      assert.equal(kv.stats.listCalls, 1);
      assert.equal(edgeCache.stats.putCalls, 1);
      assert.equal(edgeCache.stats.keys[0], "https://stats.example.com/stats.json");

      // Second GET /stats.json with different query string -> cache hit, zero new kv.list() calls.
      const res2 = await worker.fetch(
        new Request("https://stats.example.com/stats.json?v=2&utm=test"),
        env,
      );
      assert.equal(res2.status, 200);
      const body2 = await res2.json();
      assert.deepEqual(body2, body1);
      assert.equal(kv.stats.listCalls, 1);

      // POST /install/:id increments counts and validates IDs.
      const badRes = await worker.fetch(
        new Request("https://stats.example.com/install/Invalid_ID", { method: "POST" }),
        env,
      );
      assert.equal(badRes.status, 400);

      const post1 = await worker.fetch(
        new Request("https://stats.example.com/install/hdd-fairy", { method: "POST" }),
        env,
      );
      assert.equal(post1.status, 200);
      assert.deepEqual(await post1.json(), { id: "hdd-fairy", downloads: 43 });

      const post2 = await worker.fetch(
        new Request("https://stats.example.com/install/new-ext", { method: "POST" }),
        env,
      );
      assert.equal(post2.status, 200);
      assert.deepEqual(await post2.json(), { id: "new-ext", downloads: 1 });
    },
  );
});

test("/stats.json gracefully falls back when caches.default is unavailable", async () => {
  const kv = createMockKv({ "count:mcp-hub": "7" });

  await withMockedGlobals(
    {
      cachesValue: undefined,
    },
    async () => {
      const res = await worker.fetch(new Request("https://stats.example.com/stats.json"), {
        STATS_KV: kv,
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("Cache-Control"), "public, max-age=300, s-maxage=300");
      const body = await res.json();
      assert.deepEqual(body.downloads, { "mcp-hub": 7 });
      assert.equal(kv.stats.listCalls, 1);
    },
  );
});

test("/stats.json reads single-key KV snapshot with zero kv.list() calls and scheduled refresh throttles", async () => {
  let currentNow = Date.parse("2026-11-27T12:00:00.000Z");
  const kv = createMockKv({
    "count:hdd-fairy": "50",
    "meta:stats-snapshot": JSON.stringify({
      generatedAt: new Date(currentNow).toISOString(),
      downloads: { "hdd-fairy": 50 },
    }),
  });

  await withMockedGlobals(
    {
      cachesValue: undefined,
      nowMs: () => currentNow,
    },
    async () => {
      // Cold edge POP miss reads only meta:stats-snapshot via kv.get() -> ZERO kv.list() calls!
      const res1 = await worker.fetch(new Request("https://stats.example.com/stats.json"), {
        STATS_KV: kv,
      });
      assert.equal(res1.status, 200);
      assert.deepEqual((await res1.json()).downloads, { "hdd-fairy": 50 });
      assert.equal(kv.stats.listCalls, 0);

      // Refresh within 15 minutes skips kv.list().
      currentNow += 5 * 60 * 1000;
      await refreshStatsSnapshot(kv, { nowMs: currentNow });
      assert.equal(kv.stats.listCalls, 0);
      assert.equal(kv.stats.putCalls, 0);

      // After 15 minutes with unchanged counts, scans once but skips unnecessary kv.put().
      currentNow += 15 * 60 * 1000;
      await refreshStatsSnapshot(kv, { nowMs: currentNow });
      assert.equal(kv.stats.listCalls, 1);
      assert.equal(kv.stats.putCalls, 0);

      // After an install increments count + 15 minutes pass, refresh updates meta:stats-snapshot.
      await kv.put("count:hdd-fairy", "51");
      const putsBeforeRefresh = kv.stats.putCalls;
      currentNow += 15 * 60 * 1000;
      await refreshStatsSnapshot(kv, { nowMs: currentNow });
      assert.equal(kv.stats.listCalls, 2);
      assert.equal(kv.stats.putCalls, putsBeforeRefresh + 1);

      const res2 = await worker.fetch(new Request("https://stats.example.com/stats.json"), {
        STATS_KV: kv,
      });
      assert.equal(res2.status, 200);
      assert.deepEqual((await res2.json()).downloads, { "hdd-fairy": 51 });
      assert.equal(kv.stats.listCalls, 2);
    },
  );
});

test("POST /sync returns 202 when dispatching, 200 when unchanged, and enforces 60s cooldown (429)", async () => {
  const sources = [
    {
      id: "hdd-fairy",
      repository: "https://github.com/biground/codex-host-theme-hdd-fairy",
    },
  ];
  const catalog = [
    {
      id: "hdd-fairy",
      downloadUrl:
        "https://github.com/biground/codex-host-theme-hdd-fairy/releases/download/v2.0.1/hdd-fairy-2.0.1.zip",
    },
  ];

  let latestVersion = "v2.2.0";
  let currentNow = Date.parse("2026-11-27T12:00:00.000Z");
  let fetchCalls = 0;
  const edgeCache = createMockEdgeCache();
  const kv = createMockKv();

  await withMockedGlobals(
    {
      cachesValue: { default: edgeCache },
      nowMs: () => currentNow,
      fetchImpl: async (url, init) => {
        fetchCalls += 1;
        const href = String(url);
        if (href === "https://api.github.com/graphql") {
          const { query } = JSON.parse(init.body);
          if (query.includes("query RegistryState")) {
            return makeRegistryGraphQLResponse(sources, catalog);
          }
          const verNum = latestVersion.slice(1);
          return Response.json({
            data: {
              r0: {
                latestRelease: {
                  isDraft: false,
                  isPrerelease: false,
                  publishedAt: "2026-11-27T09:00:00Z",
                  releaseAssets: {
                    nodes: [
                      {
                        name: `hdd-fairy-${verNum}.zip`,
                        downloadUrl: `https://github.com/biground/codex-host-theme-hdd-fairy/releases/download/${latestVersion}/hdd-fairy-${verNum}.zip`,
                      },
                    ],
                  },
                },
                defaultBranchRef: { target: { oid: "f".repeat(40) } },
              },
            },
          });
        }
        if (href.endsWith("/dispatches")) {
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected fetch: ${href}`);
      },
    },
    async () => {
      const env = { GITHUB_TOKEN: "ghp_test_token", STATS_KV: kv };

      // OPTIONS /sync supports CORS preflight
      const optRes = await worker.fetch(
        new Request("https://stats.example.com/sync", { method: "OPTIONS" }),
        env,
      );
      assert.equal(optRes.status, 204);
      assert.equal(optRes.headers.get("Access-Control-Allow-Origin"), "*");

      // 1. First POST /sync detects new release -> 202 + dispatches
      const ctx1 = makeCtx();
      const res1 = await worker.fetch(
        new Request("https://stats.example.com/sync", {
          method: "POST",
          body: JSON.stringify({ force: true, malicious: "ignored" }),
        }),
        env,
        ctx1,
      );
      await ctx1.flush();
      assert.equal(res1.status, 202);
      assert.equal(res1.headers.get("Access-Control-Allow-Origin"), "*");
      const body1 = await res1.json();
      assert.equal(body1.ok, true);
      assert.equal(body1.needsSync, true);
      assert.equal(body1.dispatched, true);
      assert.equal(fetchCalls, 3);

      // 2. Second POST /sync 20s later -> 429 with Retry-After, zero new GitHub fetches
      currentNow += 20 * 1000;
      const res2 = await worker.fetch(
        new Request("https://stats.example.com/sync", { method: "POST" }),
        env,
      );
      assert.equal(res2.status, 429);
      assert.equal(res2.headers.get("Retry-After"), "40");
      assert.equal(res2.headers.get("Access-Control-Allow-Origin"), "*");
      const body2 = await res2.json();
      assert.equal(body2.ok, true);
      assert.equal(body2.throttled, true);
      assert.equal(body2.retryAfterSeconds, 40);
      assert.equal(body2.sync.dispatched, true);
      assert.equal(fetchCalls, 3);

      // 3. Even after cold isolate reset, Edge Cache still enforces the remaining cooldown
      resetSyncState();
      currentNow += 15 * 1000; // 35s elapsed total -> 25s remaining
      const res3 = await worker.fetch(
        new Request("https://stats.example.com/sync", { method: "POST" }),
        env,
      );
      assert.equal(res3.status, 429);
      assert.equal(res3.headers.get("Retry-After"), "25");
      assert.equal(fetchCalls, 3);

      // 4. After 60s elapse, POST /sync runs again; with no changes returns 200 and does not dispatch
      currentNow += 26 * 1000; // 61s elapsed total
      latestVersion = "v2.0.1";
      const res4 = await worker.fetch(
        new Request("https://stats.example.com/sync", { method: "POST" }),
        env,
      );
      assert.equal(res4.status, 200);
      const body4 = await res4.json();
      assert.equal(body4.ok, true);
      assert.equal(body4.needsSync, false);
      assert.equal(body4.dispatched, false);
      assert.equal(fetchCalls, 5);
    },
  );
});

test("Concurrent POST /sync requests share one single-flight GitHub check", async () => {
  const sources = [{ id: "ext-a", repository: "https://github.com/org/ext-a" }];
  const catalog = [
    {
      id: "ext-a",
      downloadUrl: "https://github.com/org/ext-a/releases/download/v1.0.0/ext-a.zip",
    },
  ];

  let releaseFirstFetch;
  const gate = new Promise((resolve) => {
    releaseFirstFetch = resolve;
  });
  let fetchCalls = 0;

  await withMockedGlobals(
    {
      cachesValue: { default: createMockEdgeCache() },
      fetchImpl: async (url, init) => {
        fetchCalls += 1;
        const { query } = JSON.parse(init.body);
        if (query.includes("query RegistryState")) {
          await gate;
          return makeRegistryGraphQLResponse(sources, catalog);
        }
        return Response.json({
          data: {
            r0: {
              latestRelease: {
                isDraft: false,
                isPrerelease: false,
                publishedAt: "2026-11-27T09:00:00Z",
                releaseAssets: {
                  nodes: [
                    {
                      name: "ext-a.zip",
                      downloadUrl: "https://github.com/org/ext-a/releases/download/v1.0.0/ext-a.zip",
                    },
                  ],
                },
              },
              defaultBranchRef: { target: { oid: "a".repeat(40) } },
            },
          },
        });
      },
    },
    async () => {
      const env = { GITHUB_TOKEN: "ghp_test_token" };
      const req1 = worker.fetch(new Request("https://stats.example.com/sync", { method: "POST" }), env);
      const req2 = worker.fetch(new Request("https://stats.example.com/sync", { method: "POST" }), env);

      releaseFirstFetch();
      const [res1, res2] = await Promise.all([req1, req2]);

      assert.equal(res1.status, 200);
      assert.equal(res2.status, 200);
      const [body1, body2] = await Promise.all([res1.json(), res2.json()]);
      assert.deepEqual(body1, body2);
      assert.equal(fetchCalls, 2);
    },
  );
});

test("POST /sync returns 503 with sanitized error when GitHub check fails", async () => {
  const secretToken = "ghp_TOP_SECRET_SYNC_TOKEN_999";

  await withMockedGlobals(
    {
      cachesValue: undefined,
      fetchImpl: async () =>
        new Response(`Unauthorized Bearer ${secretToken}`, { status: 401 }),
    },
    async () => {
      const res = await worker.fetch(
        new Request("https://stats.example.com/sync", { method: "POST" }),
        { GITHUB_TOKEN: secretToken },
      );
      assert.equal(res.status, 503);
      assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
      const raw = await res.text();
      assert.equal(raw.includes(secretToken), false);
      assert.equal(raw.includes("Bearer"), false);
      const body = JSON.parse(raw);
      assert.equal(body.ok, false);
      assert.equal(body.error, "GitHub GraphQL HTTP 401");
    },
  );
});
