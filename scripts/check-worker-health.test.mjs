import test from "node:test";
import assert from "node:assert/strict";
import {
  ALERT_ISSUE_TITLE,
  ALERT_MARKER,
  evaluateWorkerHealth,
  reconcileAlertIssue,
} from "./check-worker-health.mjs";

const NOW = Date.parse("2026-11-27T12:00:00.000Z");

function healthyHealthRes(minutesAgo = 5) {
  return {
    status: 200,
    body: {
      ok: true,
      sync: {
        checkedAt: new Date(NOW - minutesAgo * 60_000).toISOString(),
        ok: true,
        needsSync: false,
        dispatched: false,
        sourceCount: 16,
        error: null,
      },
    },
  };
}

function healthyStatsRes() {
  return {
    status: 200,
    body: {
      generatedAt: new Date(NOW).toISOString(),
      downloads: { "hdd-fairy": 42 },
    },
  };
}

function createMockGitHubApi(initialIssues = []) {
  const issues = initialIssues.map((item) => ({ ...item }));
  let nextNumber = Math.max(0, ...issues.map((item) => item.number)) + 1;
  const calls = {
    list: 0,
    createIssue: [],
    createComment: [],
    patchIssue: [],
  };

  async function fetchImpl(url, init = {}) {
    const href = String(url);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;

    if (method === "GET" && href.includes("/issues?state=open")) {
      calls.list += 1;
      return Response.json(issues.filter((issue) => issue.state === "open"));
    }
    if (method === "POST" && /\/issues$/u.test(href)) {
      const created = {
        number: nextNumber++,
        state: "open",
        title: body.title,
        body: body.body,
      };
      issues.push(created);
      calls.createIssue.push(created);
      return Response.json(created, { status: 201 });
    }
    const commentMatch = /\/issues\/(\d+)\/comments$/u.exec(href);
    if (method === "POST" && commentMatch) {
      const number = Number(commentMatch[1]);
      const comment = { number, body: body.body };
      calls.createComment.push(comment);
      return Response.json({ id: calls.createComment.length, body: body.body }, { status: 201 });
    }
    const patchMatch = /\/issues\/(\d+)$/u.exec(href);
    if (method === "PATCH" && patchMatch) {
      const number = Number(patchMatch[1]);
      const target = issues.find((issue) => issue.number === number);
      if (!target) return new Response("Not found", { status: 404 });
      if (body.state !== undefined) target.state = body.state;
      if (body.body !== undefined) target.body = body.body;
      calls.patchIssue.push({ number, body });
      return Response.json(target);
    }
    throw new Error(`Unexpected GitHub API call: ${method} ${href}`);
  }

  return { issues, calls, fetchImpl };
}

test("Healthy /health and /stats.json with no open issue performs noop", async () => {
  const evaluation = evaluateWorkerHealth({
    healthRes: healthyHealthRes(5),
    statsRes: healthyStatsRes(),
    nowMs: NOW,
  });
  assert.equal(evaluation.healthy, true);
  assert.deepEqual(evaluation.problems, []);

  const gh = createMockGitHubApi([
    // Open PR with same title must be ignored
    { number: 99, state: "open", title: ALERT_ISSUE_TITLE, body: ALERT_MARKER, pull_request: {} },
  ]);
  const result = await reconcileAlertIssue({
    repo: "BytePioneer-AI/codexhost-extensions-registry",
    token: "ghs_test_token",
    evaluation,
    fetchImpl: gh.fetchImpl,
  });

  assert.equal(result.action, "noop");
  assert.equal(result.issueNumber, null);
  assert.equal(gh.calls.createIssue.length, 0);
  assert.equal(gh.calls.createComment.length, 0);
  assert.equal(gh.calls.patchIssue.length, 0);
});

test("Detects outdated Worker missing sync field, sync.ok === false, stale checkedAt, and /stats.json 503", async () => {
  // 1. Outdated deployment: { ok: true } without sync
  const outdated = evaluateWorkerHealth({
    healthRes: { status: 200, body: { ok: true } },
    statsRes: healthyStatsRes(),
    nowMs: NOW,
  });
  assert.equal(outdated.healthy, false);
  assert.ok(
    outdated.problems.some((msg) =>
      msg.includes("Worker /health missing sync status (likely outdated deployment)"),
    ),
  );

  // 2. sync.ok === false
  const syncFailed = evaluateWorkerHealth({
    healthRes: {
      status: 200,
      body: {
        ok: true,
        sync: {
          checkedAt: new Date(NOW - 2 * 60_000).toISOString(),
          ok: false,
          needsSync: false,
          dispatched: false,
          sourceCount: 16,
          error: "GitHub GraphQL HTTP 401",
        },
      },
    },
    statsRes: healthyStatsRes(),
    nowMs: NOW,
  });
  assert.equal(syncFailed.healthy, false);
  assert.ok(syncFailed.problems.some((msg) => msg.includes("GitHub GraphQL HTTP 401")));

  // 3. Stale checkedAt (> 30 minutes)
  const stale = evaluateWorkerHealth({
    healthRes: healthyHealthRes(45),
    statsRes: healthyStatsRes(),
    nowMs: NOW,
    maxStaleMinutes: 30,
  });
  assert.equal(stale.healthy, false);
  assert.equal(stale.staleMinutes, 45);
  assert.ok(stale.problems.some((msg) => msg.includes("stale")));

  // 4. /stats.json returns 503
  const stats503 = evaluateWorkerHealth({
    healthRes: healthyHealthRes(5),
    statsRes: { status: 503, body: { error: "Stats unavailable" } },
    nowMs: NOW,
  });
  assert.equal(stats503.healthy, false);
  assert.ok(stats503.problems.some((msg) => msg.includes("HTTP 503")));

  // Creating issue for failure works and contains marker + fingerprint
  const gh = createMockGitHubApi();
  const created = await reconcileAlertIssue({
    repo: "BytePioneer-AI/codexhost-extensions-registry",
    token: "ghs_test_token",
    evaluation: stats503,
    fetchImpl: gh.fetchImpl,
  });
  assert.equal(created.action, "created");
  assert.equal(created.issueNumber, 1);
  assert.equal(gh.calls.createIssue.length, 1);
  assert.equal(gh.calls.createIssue[0].title, ALERT_ISSUE_TITLE);
  assert.ok(gh.calls.createIssue[0].body.includes(ALERT_MARKER));
  assert.ok(gh.calls.createIssue[0].body.includes(`<!-- fingerprint:${stats503.fingerprint} -->`));
});

test("Deduplicates identical failures, comments once when failure changes, and auto-closes on recovery", async () => {
  const gh = createMockGitHubApi();
  const repo = "BytePioneer-AI/codexhost-extensions-registry";
  const token = "ghs_test_token";

  // 1. Initial stale failure at 50m -> creates issue #1
  const eval1 = evaluateWorkerHealth({
    healthRes: healthyHealthRes(50),
    statsRes: healthyStatsRes(),
    nowMs: NOW,
  });
  const res1 = await reconcileAlertIssue({ repo, token, evaluation: eval1, fetchImpl: gh.fetchImpl });
  assert.equal(res1.action, "created");
  assert.equal(res1.issueNumber, 1);
  assert.equal(gh.calls.createIssue.length, 1);
  assert.equal(gh.calls.createComment.length, 0);

  // 2. Same stale failure 30m later (now 65m old) -> same fingerprint, NO new issue or comment
  const eval2 = evaluateWorkerHealth({
    healthRes: healthyHealthRes(65),
    statsRes: healthyStatsRes(),
    nowMs: NOW,
  });
  assert.equal(eval2.fingerprint, eval1.fingerprint);
  const res2 = await reconcileAlertIssue({ repo, token, evaluation: eval2, fetchImpl: gh.fetchImpl });
  assert.equal(res2.action, "unchanged");
  assert.equal(res2.issueNumber, 1);
  assert.equal(gh.calls.createIssue.length, 1);
  assert.equal(gh.calls.createComment.length, 0);

  // 3. Failure changes (now /stats.json also returns 503) -> adds 1 comment and refreshes issue body fingerprint
  const eval3 = evaluateWorkerHealth({
    healthRes: healthyHealthRes(70),
    statsRes: { status: 503, body: { error: "Stats unavailable" } },
    nowMs: NOW,
  });
  assert.notEqual(eval3.fingerprint, eval1.fingerprint);
  const res3 = await reconcileAlertIssue({ repo, token, evaluation: eval3, fetchImpl: gh.fetchImpl });
  assert.equal(res3.action, "commented");
  assert.equal(res3.issueNumber, 1);
  assert.equal(gh.calls.createComment.length, 1);
  assert.equal(gh.calls.patchIssue.length, 1);

  // 4. Repeating the new failure stays silent (no comment spam)
  const res4 = await reconcileAlertIssue({ repo, token, evaluation: eval3, fetchImpl: gh.fetchImpl });
  assert.equal(res4.action, "unchanged");
  assert.equal(gh.calls.createComment.length, 1);

  // 5. Recovery -> posts recovery comment and closes issue #1
  const evalHealthy = evaluateWorkerHealth({
    healthRes: healthyHealthRes(2),
    statsRes: healthyStatsRes(),
    nowMs: NOW,
  });
  assert.equal(evalHealthy.healthy, true);
  const res5 = await reconcileAlertIssue({
    repo,
    token,
    evaluation: evalHealthy,
    fetchImpl: gh.fetchImpl,
  });
  assert.equal(res5.action, "closed");
  assert.equal(res5.issueNumber, 1);
  assert.equal(gh.calls.createComment.length, 2);
  assert.ok(gh.calls.createComment[1].body.includes("recovered"));
  assert.equal(gh.issues[0].state, "closed");
});
