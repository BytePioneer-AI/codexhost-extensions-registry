const prefix = "count:";
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const githubRepoPattern =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u;
const safeAssetName = /^(?!\.\.?$)[^/\\\r\n]+\.zip$/iu;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

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

async function fetchGitHubJson(url, token, { missingOk = false } = {}) {
  const response = await fetch(url, { headers: githubHeaders(token) });
  if (missingOk && response.status === 404) return undefined;
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${url}`);
  return response.json();
}

async function fetchRepoFileJson(repo, path, token) {
  const response = await fetch(
    `https://api.github.com/repos/${repo}/contents/${path}?ref=main`,
    { headers: githubHeaders(token, "application/vnd.github.raw+json") },
  );
  if (!response.ok) throw new Error(`GitHub contents ${response.status}: ${path}`);
  return response.json();
}

async function resolveExpectedDownloadUrl(source, token) {
  const match = githubRepoPattern.exec(source.repository ?? "");
  if (!match) return undefined;
  const [, owner, repo] = match;
  const api = `https://api.github.com/repos/${owner}/${repo}`;

  // Prefer latest public stable Release .zip asset; fall back to default-branch HEAD commit.
  const release = await fetchGitHubJson(`${api}/releases/latest`, token, { missingOk: true });
  if (
    release &&
    !release.draft &&
    !release.prerelease &&
    release.published_at &&
    Array.isArray(release.assets)
  ) {
    const zipAssets = release.assets.filter(
      ({ name }) =>
        typeof name === "string" &&
        safeAssetName.test(name) &&
        (!source.asset || name === source.asset),
    );
    if (zipAssets.length === 1 && typeof zipAssets[0].browser_download_url === "string") {
      return zipAssets[0].browser_download_url;
    }
  }
  if (source.asset) return undefined;

  const commits = await fetchGitHubJson(`${api}/commits?per_page=1`, token, { missingOk: true });
  const sha = Array.isArray(commits) ? commits[0]?.sha : undefined;
  return typeof sha === "string" && /^[a-f0-9]{40}$/u.test(sha) ? `${api}/zipball/${sha}` : undefined;
}

async function checkAndDispatchSync(env) {
  const token = env.GITHUB_TOKEN?.trim();
  if (!token) return;

  const registryRepo = env.REGISTRY_REPO || "BytePioneer-AI/codexhost-extensions-registry";
  const workflow = env.REGISTRY_WORKFLOW || "registry-sync.yml";

  const [sourcesDoc, catalogDoc] = await Promise.all([
    fetchRepoFileJson(registryRepo, "sources.json", token),
    fetchRepoFileJson(registryRepo, "catalog.json", token),
  ]);

  const sources = Array.isArray(sourcesDoc?.sources) ? sourcesDoc.sources : [];
  const entries = Array.isArray(catalogDoc?.extensions) ? catalogDoc.extensions : [];
  const currentUrls = new Map(entries.map((entry) => [entry.id, entry.downloadUrl]));
  const sourceIds = new Set(sources.map((source) => source.id));

  let needsSync = entries.some((entry) => !sourceIds.has(entry.id));
  if (!needsSync) {
    for (const source of sources) {
      try {
        const expectedUrl = await resolveExpectedDownloadUrl(source, token);
        if (expectedUrl && currentUrls.get(source.id) !== expectedUrl) {
          needsSync = true;
          break;
        }
      } catch {
        // Ignore transient per-source API errors so one repo cannot block others.
      }
    }
  }

  if (!needsSync) return;

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
    throw new Error(`Failed to dispatch ${workflow}: ${response.status}`);
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

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(checkAndDispatchSync(env));
  },
  async fetch(request, { STATS_KV: kv }) {
    const { method } = request;
    const { pathname } = new URL(request.url);
    if (method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (method === "GET" && pathname === "/health") return json({ ok: true });
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
        const downloads = await snapshot(kv);
        return json({ generatedAt: new Date().toISOString(), downloads }, 200, {
          "Cache-Control": "public, max-age=300",
        });
      }
      return json({ error: "Not found" }, 404);
    } catch {
      return json({ error: "Stats unavailable" }, 503);
    }
  },
};
