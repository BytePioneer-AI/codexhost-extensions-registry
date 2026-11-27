const prefix = "count:";
const syncMetaKey = "meta:last-sync-check";
const syncMetaWriteIntervalMs = 15 * 60 * 1000;
const syncMetaRefreshIntervalMs = 10 * 60 * 1000;
const syncCooldownMs = 60 * 1000;
const syncCooldownCachePath = "/__internal/sync-cooldown";
const syncCooldownCacheControl = "public, max-age=60";
const graphqlEndpoint = "https://api.github.com/graphql";
const graphqlRepoBatchSize = 40;
const statsCacheControl = "public, max-age=300, s-maxage=300";

const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const repoSlugPattern = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u;
const githubRepoPattern =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u;
const safeAssetName = /^(?!\.\.?$)[^/\\\r\n]+\.zip$/iu;
const shaPattern = /^[a-f0-9]{40}$/u;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const registryStateQuery = `query RegistryState($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    sources: object(expression: "main:sources") {
      ... on Tree {
        entries {
          name
          type
          object {
            ... on Blob {
              text
            }
          }
        }
      }
    }
    catalog: object(expression: "main:catalog.v2.json") {
      ... on Blob {
        text
      }
    }
  }
}`;

let lastSyncCheck = null;
let lastPersistedAt = 0;
let lastPersistedOk;
let lastSyncTriggeredAtMs = 0;
let inFlightSyncPromise = null;

class SyncCheckError extends Error {
  constructor(safeMessage) {
    super(safeMessage);
    this.name = "SyncCheckError";
    this.safeMessage = safeMessage;
  }
}

const json = (body, status = 200, headers = {}) =>
  Response.json(body, { status, headers: { ...cors, ...headers } });

function githubHeaders(token, accept = "application/vnd.github+json") {
  return {
    Accept: accept,
    Authorization: `Bearer ${token}`,
    "User-Agent": "codexhost-extensions-registry-worker",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function sanitizeSyncError(error) {
  if (error instanceof SyncCheckError && typeof error.safeMessage === "string") {
    return error.safeMessage;
  }
  if (error?.name === "SyntaxError") return "Invalid JSON response";
  if (error?.name === "TypeError") return "Network error";
  return "Sync check failed";
}

function parseRepoSlug(slug) {
  const match = repoSlugPattern.exec(slug);
  if (!match) throw new SyncCheckError("Invalid registry repo");
  return { owner: match[1], name: match[2] };
}

async function fetchGitHubGraphQL(query, variables, token) {
  const response = await fetch(graphqlEndpoint, {
    method: "POST",
    headers: {
      ...githubHeaders(token),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    throw new SyncCheckError(`GitHub GraphQL HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (!payload || typeof payload !== "object" || !payload.data || typeof payload.data !== "object") {
    throw new SyncCheckError("GitHub GraphQL empty response");
  }
  return payload;
}

async function readRegistryState(registryRepo, token) {
  const { owner, name } = parseRepoSlug(registryRepo);
  const { data } = await fetchGitHubGraphQL(registryStateQuery, { owner, name }, token);
  const repoData = data.repository;
  if (!repoData) throw new SyncCheckError("Registry repository unavailable");

  const treeEntries = repoData.sources?.entries;
  if (!Array.isArray(treeEntries)) {
    throw new SyncCheckError("Invalid sources directory");
  }

  const sources = [];
  for (const entry of treeEntries) {
    if (typeof entry?.name !== "string" || !entry.name.endsWith(".json")) continue;
    if ((entry.type && entry.type !== "blob") || typeof entry.object?.text !== "string") {
      throw new SyncCheckError("Invalid source file");
    }
    const source = JSON.parse(entry.object.text);
    if (typeof source?.id !== "string" || entry.name !== `${source.id}.json`) {
      throw new SyncCheckError("Source ID mismatch");
    }
    sources.push(source);
  }

  const catalogText = repoData.catalog?.text;
  if (typeof catalogText !== "string") {
    throw new SyncCheckError("Missing catalog.v2.json");
  }
  const catalogDoc = JSON.parse(catalogText);
  return { sources, catalogDoc };
}

function buildSourceReposBatchQuery(repos) {
  const varDefs = [];
  const fields = [];
  const variables = {};
  for (let i = 0; i < repos.length; i += 1) {
    const { owner, repo } = repos[i];
    varDefs.push(`$o${i}: String!`, `$n${i}: String!`);
    variables[`o${i}`] = owner;
    variables[`n${i}`] = repo;
    fields.push(`r${i}: repository(owner: $o${i}, name: $n${i}) {
    latestRelease {
      isDraft
      isPrerelease
      publishedAt
      releaseAssets(first: 50) {
        nodes {
          name
          downloadUrl
        }
      }
    }
    defaultBranchRef {
      target {
        oid
      }
    }
  }`);
  }
  const query = `query SourceRepos(${varDefs.join(", ")}) {\n  ${fields.join("\n  ")}\n}`;
  return { query, variables };
}

function resolveExpectedDownloadUrlFromRepo(source, owner, repo, repoData) {
  if (!repoData) return undefined;

  const release = repoData.latestRelease;
  const assetNodes = release?.releaseAssets?.nodes;
  if (
    release &&
    !release.isDraft &&
    !release.isPrerelease &&
    release.publishedAt &&
    Array.isArray(assetNodes)
  ) {
    const zipAssets = assetNodes.filter(
      (asset) =>
        asset &&
        typeof asset.name === "string" &&
        safeAssetName.test(asset.name) &&
        (!source.asset || asset.name === source.asset),
    );
    if (zipAssets.length > 1) return undefined;
    if (zipAssets.length === 1 && typeof zipAssets[0].downloadUrl === "string") {
      return zipAssets[0].downloadUrl;
    }
  }
  if (source.asset) return undefined;

  const sha = repoData.defaultBranchRef?.target?.oid;
  return typeof sha === "string" && shaPattern.test(sha)
    ? `https://api.github.com/repos/${owner}/${repo}/zipball/${sha}`
    : undefined;
}

async function dispatchWorkflow(registryRepo, workflow, token) {
  const response = await fetch(
    `https://api.github.com/repos/${registryRepo}/actions/workflows/${workflow}/dispatches`,
    {
      method: "POST",
      headers: {
        ...githubHeaders(token),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "main" }),
    },
  );
  if (!response.ok) {
    throw new SyncCheckError(`Dispatch HTTP ${response.status}`);
  }
}

async function readStoredSyncCheck(kv) {
  if (!kv) return null;
  try {
    const raw = await kv.get(syncMetaKey);
    if (typeof raw !== "string") return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function recordSyncCheck(kv, summary, nowMs) {
  lastSyncCheck = summary;
  lastSyncTriggeredAtMs = Math.max(lastSyncTriggeredAtMs, nowMs);
  if (!kv) return;

  if (lastPersistedAt === 0) {
    const stored = await readStoredSyncCheck(kv);
    if (stored) {
      if (typeof stored.ok === "boolean") lastPersistedOk = stored.ok;
      const storedTime = Date.parse(stored.checkedAt);
      if (Number.isFinite(storedTime)) lastPersistedAt = storedTime;
    }
  }

  const stateChanged = lastPersistedOk !== summary.ok;
  const stale = !lastPersistedAt || nowMs - lastPersistedAt >= syncMetaWriteIntervalMs;
  if (!summary.dispatched && !stateChanged && !stale) return;

  try {
    await kv.put(syncMetaKey, JSON.stringify(summary));
    lastPersistedAt = nowMs;
    lastPersistedOk = summary.ok;
  } catch {
    // Ignore KV write failures so sync detection is unaffected.
  }
}

async function getLastSyncCheck(kv) {
  const memTime = lastSyncCheck?.checkedAt ? Date.parse(lastSyncCheck.checkedAt) : Number.NaN;
  const memFresh =
    lastSyncCheck && Number.isFinite(memTime) && Date.now() - memTime < syncMetaRefreshIntervalMs;
  if (memFresh) return lastSyncCheck;

  const stored = await readStoredSyncCheck(kv);
  if (stored) {
    const storedTime = Date.parse(stored.checkedAt);
    if (!lastSyncCheck || !Number.isFinite(memTime) || (Number.isFinite(storedTime) && storedTime >= memTime)) {
      lastSyncCheck = stored;
      if (typeof stored.ok === "boolean") lastPersistedOk = stored.ok;
      if (Number.isFinite(storedTime)) lastPersistedAt = storedTime;
    }
  }
  return lastSyncCheck;
}

export function resetSyncState() {
  lastSyncCheck = null;
  lastPersistedAt = 0;
  lastPersistedOk = undefined;
  lastSyncTriggeredAtMs = 0;
  inFlightSyncPromise = null;
}

export function checkAndDispatchSync(env = {}) {
  if (inFlightSyncPromise) return inFlightSyncPromise;
  const run = runSyncCheck(env).finally(() => {
    if (inFlightSyncPromise === run) inFlightSyncPromise = null;
  });
  inFlightSyncPromise = run;
  return run;
}

async function runSyncCheck(env = {}) {
  const nowMs = Date.now();
  const checkedAt = new Date(nowMs).toISOString();
  const kv = env.STATS_KV;
  const token = env.GITHUB_TOKEN?.trim();

  if (!token) {
    const summary = {
      checkedAt,
      ok: false,
      needsSync: false,
      dispatched: false,
      sourceCount: 0,
      error: "Missing GITHUB_TOKEN",
    };
    await recordSyncCheck(kv, summary, nowMs);
    return summary;
  }

  const registryRepo = env.REGISTRY_REPO || "BytePioneer-AI/codexhost-extensions-registry";
  const workflow = env.REGISTRY_WORKFLOW || "registry-sync.yml";

  let sourceCount = 0;
  let needsSync = false;
  let dispatched = false;

  try {
    const { sources, catalogDoc } = await readRegistryState(registryRepo, token);
    sourceCount = sources.length;

    const entries = Array.isArray(catalogDoc?.extensions) ? catalogDoc.extensions : [];
    const currentUrls = new Map(entries.map((entry) => [entry.id, entry.downloadUrl]));
    const sourceIds = new Set(sources.map((source) => source.id));

    needsSync = entries.some((entry) => !sourceIds.has(entry.id));

    if (!needsSync) {
      const uniqueRepos = [];
      const repoGroups = new Map();

      for (const source of sources) {
        const match = githubRepoPattern.exec(source.repository ?? "");
        if (!match) continue;
        const [, owner, repo] = match;
        const key = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
        let group = repoGroups.get(key);
        if (!group) {
          group = { owner, repo, sources: [] };
          repoGroups.set(key, group);
          uniqueRepos.push(group);
        }
        group.sources.push(source);
      }

      for (let offset = 0; offset < uniqueRepos.length && !needsSync; offset += graphqlRepoBatchSize) {
        const batch = uniqueRepos.slice(offset, offset + graphqlRepoBatchSize);
        const { query, variables } = buildSourceReposBatchQuery(batch);
        // Partial GraphQL errors leave unavailable aliases as null while returning healthy repos.
        const { data } = await fetchGitHubGraphQL(query, variables, token);

        for (let i = 0; i < batch.length; i += 1) {
          const group = batch[i];
          const repoData = data[`r${i}`];
          if (!repoData) continue;
          for (const source of group.sources) {
            const expectedUrl = resolveExpectedDownloadUrlFromRepo(
              source,
              group.owner,
              group.repo,
              repoData,
            );
            if (expectedUrl && currentUrls.get(source.id) !== expectedUrl) {
              needsSync = true;
              break;
            }
          }
          if (needsSync) break;
        }
      }
    }

    if (needsSync) {
      await dispatchWorkflow(registryRepo, workflow, token);
      dispatched = true;
    }

    const summary = {
      checkedAt,
      ok: true,
      needsSync,
      dispatched,
      sourceCount,
      error: null,
    };
    await recordSyncCheck(kv, summary, nowMs);
    return summary;
  } catch (error) {
    const summary = {
      checkedAt,
      ok: false,
      needsSync,
      dispatched,
      sourceCount,
      error: sanitizeSyncError(error),
    };
    await recordSyncCheck(kv, summary, nowMs);
    return summary;
  }
}

function readCount(value) {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) return undefined;
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : undefined;
}

async function snapshot(kv) {
  const downloads = Object.create(null);
  let cursor;
  while (true) {
    const page = await kv.list({ prefix, cursor });
    const keys = page.keys
      .map(({ name }) => name)
      .filter((key) => idPattern.test(key.slice(prefix.length)));
    // KV bulk reads accept at most 100 keys per call.
    for (let offset = 0; offset < keys.length; offset += 100) {
      const values = await kv.get(keys.slice(offset, offset + 100));
      for (const [key, value] of values) {
        const count = readCount(value);
        if (count !== undefined) downloads[key.slice(prefix.length)] = count;
      }
    }
    if (page.list_complete) return downloads;
    cursor = page.cursor;
  }
}

function getDefaultCache() {
  return typeof caches !== "undefined" && caches?.default ? caches.default : undefined;
}

async function readSyncCooldownAtMs(cache, cooldownKey, nowMs) {
  let recentAtMs = lastSyncTriggeredAtMs;
  if (lastSyncCheck?.checkedAt) {
    const checkedAtMs = Date.parse(lastSyncCheck.checkedAt);
    if (Number.isFinite(checkedAtMs) && checkedAtMs > recentAtMs) {
      recentAtMs = checkedAtMs;
    }
  }
  if (recentAtMs > 0 && nowMs - recentAtMs < syncCooldownMs) {
    return recentAtMs;
  }
  if (!cache) return recentAtMs;
  try {
    const cached = await cache.match(cooldownKey);
    if (cached) {
      const payload = await cached.json().catch(() => null);
      const cachedAtMs =
        typeof payload?.checkedAtMs === "number" && Number.isFinite(payload.checkedAtMs)
          ? payload.checkedAtMs
          : nowMs;
      if (cachedAtMs > recentAtMs) recentAtMs = cachedAtMs;
    }
  } catch {
    // Fall back to in-memory cooldown when Edge Cache is unavailable.
  }
  return recentAtMs;
}

async function writeSyncCooldown(cache, cooldownKey, checkedAtMs, ctx) {
  lastSyncTriggeredAtMs = Math.max(lastSyncTriggeredAtMs, checkedAtMs);
  if (!cache) return;
  const marker = Response.json(
    { checkedAtMs },
    { status: 200, headers: { "Cache-Control": syncCooldownCacheControl } },
  );
  const putPromise = Promise.resolve(cache.put(cooldownKey, marker)).catch(() => {});
  if (ctx?.waitUntil) {
    ctx.waitUntil(putPromise);
  } else {
    await putPromise;
  }
}

function syncResultStatus(summary) {
  if (!summary.ok) return 503;
  if (summary.dispatched) return 202;
  return 200;
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(checkAndDispatchSync(env));
  },
  async fetch(request, env = {}, ctx) {
    const kv = env.STATS_KV;
    const { method } = request;
    const url = new URL(request.url);
    const { pathname } = url;
    if (method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (method === "GET" && pathname === "/health") {
      const sync = await getLastSyncCheck(kv);
      return json({ ok: true, sync: sync ?? null });
    }
    if (method === "POST" && pathname === "/sync") {
      const cache = getDefaultCache();
      const cooldownKey = new Request(`${url.origin}${syncCooldownCachePath}`, { method: "GET" });

      if (inFlightSyncPromise) {
        const summary = await inFlightSyncPromise;
        return json(summary, syncResultStatus(summary));
      }

      const nowMs = Date.now();
      const recentAtMs = await readSyncCooldownAtMs(cache, cooldownKey, nowMs);
      if (!inFlightSyncPromise && recentAtMs > 0 && nowMs - recentAtMs < syncCooldownMs) {
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((syncCooldownMs - (nowMs - recentAtMs)) / 1000),
        );
        const sync = await getLastSyncCheck(kv);
        return json(
          { ok: true, throttled: true, retryAfterSeconds, sync: sync ?? null },
          429,
          { "Retry-After": String(retryAfterSeconds) },
        );
      }

      const summary = await checkAndDispatchSync(env);
      const checkedAtMs = Date.parse(summary.checkedAt);
      await writeSyncCooldown(
        cache,
        cooldownKey,
        Number.isFinite(checkedAtMs) ? checkedAtMs : Date.now(),
        ctx,
      );
      return json(summary, syncResultStatus(summary));
    }
    try {
      if (method === "POST" && pathname.startsWith("/install/")) {
        let id;
        try {
          id = decodeURIComponent(pathname.slice("/install/".length));
        } catch {
          return json({ error: "Invalid extension ID" }, 400);
        }
        if (!idPattern.test(id)) return json({ error: "Invalid extension ID" }, 400);
        const key = `${prefix}${id}`;
        // KV read-modify-write is approximate: concurrent installs can race.
        const downloads = (readCount(await kv.get(key)) ?? 0) + 1;
        if (!Number.isSafeInteger(downloads)) throw new Error("Counter overflow");
        await kv.put(key, String(downloads));
        return json({ id, downloads });
      }
      if (method === "GET" && pathname === "/stats.json") {
        const cache = getDefaultCache();
        const cacheKey = new Request(`${url.origin}/stats.json`, { method: "GET" });
        if (cache) {
          try {
            const cached = await cache.match(cacheKey);
            if (cached) return cached;
          } catch {
            // Fall through to KV if Edge Cache is unavailable.
          }
        }
        const downloads = await snapshot(kv);
        const response = json({ generatedAt: new Date().toISOString(), downloads }, 200, {
          "Cache-Control": statsCacheControl,
        });
        if (cache) {
          const putPromise = Promise.resolve(cache.put(cacheKey, response.clone())).catch(() => {});
          if (ctx?.waitUntil) {
            ctx.waitUntil(putPromise);
          } else {
            await putPromise;
          }
        }
        return response;
      }
      return json({ error: "Not found" }, 404);
    } catch {
      return json({ error: "Stats unavailable" }, 503);
    }
  },
};
