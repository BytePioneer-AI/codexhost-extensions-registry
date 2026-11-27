import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const ALERT_ISSUE_TITLE = "[Alert] Extension registry sync worker unhealthy";
export const ALERT_MARKER = "<!-- worker-health-alert -->";

const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_STALE_MINUTES = 45;
const FINGERPRINT_PATTERN = /<!--\s*fingerprint:([^\s>]+)\s*-->/u;

function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "codexhost-extensions-registry-health-monitor",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function sanitizeShortText(value, fallback = "unknown") {
  if (typeof value !== "string") return fallback;
  const cleaned = value.replace(/[\r\n\t]+/gu, " ").trim().slice(0, 120);
  return cleaned || fallback;
}

function sanitizeFingerprintToken(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9:._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
}

function pickSyncSummary(sync) {
  if (!sync || typeof sync !== "object" || Array.isArray(sync)) return null;
  return {
    checkedAt: typeof sync.checkedAt === "string" ? sync.checkedAt : null,
    ok: typeof sync.ok === "boolean" ? sync.ok : null,
    needsSync: typeof sync.needsSync === "boolean" ? sync.needsSync : null,
    dispatched: typeof sync.dispatched === "boolean" ? sync.dispatched : null,
    sourceCount: typeof sync.sourceCount === "number" ? sync.sourceCount : null,
    error: typeof sync.error === "string" ? sanitizeShortText(sync.error, "") || null : null,
  };
}

export function evaluateWorkerHealth({
  healthRes,
  statsRes,
  nowMs = Date.now(),
  maxStaleMinutes = DEFAULT_MAX_STALE_MINUTES,
} = {}) {
  const problems = [];
  const problemKeys = [];
  let syncSummary = null;
  let staleMinutes = null;

  // 1. Evaluate /health
  if (!healthRes || healthRes.error) {
    const reason = sanitizeShortText(healthRes?.error, "request failed");
    problems.push(`GET /health failed: ${reason}`);
    problemKeys.push(`health:error:${sanitizeFingerprintToken(reason)}`);
  } else if (healthRes.status !== 200) {
    problems.push(`GET /health returned HTTP ${healthRes.status}`);
    problemKeys.push(`health:http-${healthRes.status}`);
  } else {
    const health = healthRes.body;
    if (!health || typeof health !== "object" || Array.isArray(health) || health.ok !== true) {
      problems.push("GET /health returned invalid payload (expected ok: true)");
      problemKeys.push("health:invalid-payload");
    } else if (!health.sync || typeof health.sync !== "object" || Array.isArray(health.sync)) {
      problems.push("Worker /health missing sync status (likely outdated deployment)");
      problemKeys.push("health:missing-sync");
    } else {
      syncSummary = pickSyncSummary(health.sync);

      if (health.sync.ok !== true) {
        const syncErr = sanitizeShortText(health.sync.error, "unknown error");
        problems.push(`Worker sync check failed: ${syncErr}`);
        problemKeys.push(`health:sync-failed:${sanitizeFingerprintToken(syncErr)}`);
      }

      const checkedAtMs =
        typeof health.sync.checkedAt === "string" ? Date.parse(health.sync.checkedAt) : Number.NaN;
      if (!Number.isFinite(checkedAtMs)) {
        problems.push("Worker /health sync.checkedAt is missing or invalid");
        problemKeys.push("health:invalid-checked-at");
      } else {
        const ageMs = nowMs - checkedAtMs;
        if (ageMs > maxStaleMinutes * 60 * 1000) {
          staleMinutes = Math.floor(ageMs / 60_000);
          problems.push(
            `Worker sync check is stale (${staleMinutes}m since ${health.sync.checkedAt}, limit ${maxStaleMinutes}m)`,
          );
          problemKeys.push("health:sync-stale");
        }
      }
    }
  }

  // 2. Evaluate /stats.json
  if (!statsRes || statsRes.error) {
    const reason = sanitizeShortText(statsRes?.error, "request failed");
    problems.push(`GET /stats.json failed: ${reason}`);
    problemKeys.push(`stats:error:${sanitizeFingerprintToken(reason)}`);
  } else if (statsRes.status !== 200) {
    problems.push(`GET /stats.json returned HTTP ${statsRes.status}`);
    problemKeys.push(`stats:http-${statsRes.status}`);
  } else {
    const stats = statsRes.body;
    if (
      !stats ||
      typeof stats !== "object" ||
      Array.isArray(stats) ||
      !stats.downloads ||
      typeof stats.downloads !== "object" ||
      Array.isArray(stats.downloads)
    ) {
      problems.push("GET /stats.json returned invalid payload (missing downloads object)");
      problemKeys.push("stats:invalid-payload");
    }
  }

  const healthy = problems.length === 0;
  const uniqueKeys = [...new Set(problemKeys)].sort();
  const fingerprint = healthy ? "healthy" : uniqueKeys.join("|");

  return {
    healthy,
    checkedAt: new Date(nowMs).toISOString(),
    maxStaleMinutes,
    staleMinutes,
    problems,
    fingerprint,
    sync: syncSummary,
    healthStatus: healthRes?.status ?? null,
    statsStatus: statsRes?.status ?? null,
  };
}

function formatSyncBlock(sync) {
  if (!sync) return "_Unavailable_";
  return ["```json", JSON.stringify(sync, null, 2), "```"].join("\n");
}

function buildAlertIssueBody(evaluation) {
  return [
    ALERT_MARKER,
    `<!-- fingerprint:${evaluation.fingerprint} -->`,
    "",
    "The extension registry Cloudflare Worker health check failed.",
    "",
    "### Detected issues",
    ...evaluation.problems.map((problem) => `- ${problem}`),
    "",
    "### Latest `/health` sync summary",
    formatSyncBlock(evaluation.sync),
    "",
    "### Quick troubleshooting",
    "1. Check recent runs of `.github/workflows/deploy-worker.yml` to verify the latest Worker build is deployed.",
    "2. Verify the Cloudflare Worker `GITHUB_TOKEN` secret is valid and still has `Actions: Read and write` + `Contents: Read` on the registry repository.",
    "3. Inspect Cloudflare Workers logs (`wrangler tail`) and KV daily quota usage for `STATS_KV`.",
    "",
    `_Checked at: ${evaluation.checkedAt}_`,
    "",
  ].join("\n");
}

function buildUpdateCommentBody(evaluation) {
  return [
    `<!-- fingerprint:${evaluation.fingerprint} -->`,
    "Worker health failure details changed:",
    "",
    ...evaluation.problems.map((problem) => `- ${problem}`),
    "",
    "Latest `/health` sync summary:",
    formatSyncBlock(evaluation.sync),
    "",
    `_Checked at: ${evaluation.checkedAt}_`,
  ].join("\n");
}

function buildRecoveryCommentBody(evaluation) {
  return [
    "Worker health check recovered (`/health` and `/stats.json` are healthy). Closing this alert automatically.",
    "",
    "Latest `/health` sync summary:",
    formatSyncBlock(evaluation.sync),
    "",
    `_Checked at: ${evaluation.checkedAt}_`,
  ].join("\n");
}

async function githubJson(url, { method = "GET", token, body, fetchImpl }) {
  const response = await fetchImpl(url, {
    method,
    headers: {
      ...githubHeaders(token),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${method} ${url} failed with HTTP ${response.status}`);
  }
  return response.json();
}

export async function reconcileAlertIssue({ repo, token, evaluation, fetchImpl = fetch }) {
  if (!repo || !token) {
    throw new Error("Both repo and token are required to reconcile alert issues");
  }

  const baseApi = `https://api.github.com/repos/${repo}`;
  const openIssues = await githubJson(`${baseApi}/issues?state=open&per_page=100`, {
    token,
    fetchImpl,
  });

  const existingIssue = Array.isArray(openIssues)
    ? openIssues.find(
        (issue) =>
          issue &&
          !issue.pull_request &&
          (issue.title === ALERT_ISSUE_TITLE ||
            (typeof issue.body === "string" && issue.body.includes(ALERT_MARKER))),
      )
    : undefined;

  if (evaluation.healthy) {
    if (!existingIssue) {
      return { action: "noop", healthy: true, issueNumber: null };
    }
    await githubJson(`${baseApi}/issues/${existingIssue.number}/comments`, {
      method: "POST",
      token,
      body: { body: buildRecoveryCommentBody(evaluation) },
      fetchImpl,
    });
    await githubJson(`${baseApi}/issues/${existingIssue.number}`, {
      method: "PATCH",
      token,
      body: { state: "closed" },
      fetchImpl,
    });
    return { action: "closed", healthy: true, issueNumber: existingIssue.number };
  }

  const issueBody = buildAlertIssueBody(evaluation);
  if (!existingIssue) {
    const created = await githubJson(`${baseApi}/issues`, {
      method: "POST",
      token,
      body: { title: ALERT_ISSUE_TITLE, body: issueBody },
      fetchImpl,
    });
    return {
      action: "created",
      healthy: false,
      issueNumber: created.number ?? null,
      fingerprint: evaluation.fingerprint,
    };
  }

  const existingFingerprint =
    typeof existingIssue.body === "string"
      ? FINGERPRINT_PATTERN.exec(existingIssue.body)?.[1] ?? null
      : null;

  if (existingFingerprint === evaluation.fingerprint) {
    return {
      action: "unchanged",
      healthy: false,
      issueNumber: existingIssue.number,
      fingerprint: evaluation.fingerprint,
    };
  }

  await githubJson(`${baseApi}/issues/${existingIssue.number}/comments`, {
    method: "POST",
    token,
    body: { body: buildUpdateCommentBody(evaluation) },
    fetchImpl,
  });
  await githubJson(`${baseApi}/issues/${existingIssue.number}`, {
    method: "PATCH",
    token,
    body: { body: issueBody },
    fetchImpl,
  });
  return {
    action: "commented",
    healthy: false,
    issueNumber: existingIssue.number,
    fingerprint: evaluation.fingerprint,
  };
}

async function fetchEndpoint(url, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body };
  } catch (error) {
    const label =
      error?.name === "TimeoutError" || error?.name === "AbortError"
        ? "timeout"
        : error?.name === "TypeError"
          ? "network error"
          : "request failed";
    return { status: 0, body: null, error: label };
  }
}

async function main() {
  const statsUrl = process.env.STATS_URL?.trim();
  if (!statsUrl) {
    console.log("STATS_URL is not set; skipping worker health check.");
    return;
  }

  const parsedStale = Number(process.env.WORKER_HEALTH_MAX_STALE_MINUTES);
  const maxStaleMinutes =
    Number.isFinite(parsedStale) && parsedStale > 0 ? parsedStale : DEFAULT_MAX_STALE_MINUTES;

  const baseUrl = statsUrl.replace(/\/+$/u, "");
  const [healthRes, statsRes] = await Promise.all([
    fetchEndpoint(`${baseUrl}/health`),
    fetchEndpoint(`${baseUrl}/stats.json`),
  ]);

  const evaluation = evaluateWorkerHealth({ healthRes, statsRes, maxStaleMinutes });
  const summaryLines = [
    `Worker health: ${evaluation.healthy ? "HEALTHY" : "UNHEALTHY"} (checkedAt=${evaluation.checkedAt})`,
    ...evaluation.problems.map((problem) => `- ${problem}`),
  ];
  console.log(summaryLines.join("\n"));

  const repo = process.env.GITHUB_REPOSITORY?.trim();
  const token = process.env.GITHUB_TOKEN?.trim();
  let reconcileResult = null;
  if (repo && token) {
    reconcileResult = await reconcileAlertIssue({ repo, token, evaluation });
    console.log(
      `Alert issue reconciliation: action=${reconcileResult.action}` +
        (reconcileResult.issueNumber ? ` issue=#${reconcileResult.issueNumber}` : ""),
    );
  } else {
    console.log("GITHUB_REPOSITORY or GITHUB_TOKEN not set; skipping issue reconciliation.");
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = [
      `### Worker health monitor: ${evaluation.healthy ? "Healthy" : "Unhealthy"}`,
      "",
      ...(evaluation.problems.length
        ? evaluation.problems.map((problem) => `- ${problem}`)
        : ["- `/health` and `/stats.json` passed."]),
      ...(reconcileResult
        ? [
            "",
            `Alert issue action: \`${reconcileResult.action}\`${reconcileResult.issueNumber ? ` (#${reconcileResult.issueNumber})` : ""}`,
          ]
        : []),
      "",
    ].join("\n");
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
