import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildPrPreview,
  detectBackendChildProcessFiles,
  evaluateAutoApproval,
  extractRepositoryUrl,
  isSubmissionIssue,
  scanFrontendAutoApproveRisks,
} from "./issue-to-pr.mjs";

function makeBaseInput(overrides = {}) {
  return {
    issueUser: { login: "alice", type: "User" },
    repositoryMeta: {
      private: false,
      archived: false,
      owner: { login: "alice", type: "User" },
    },
    isOrgPublicMember: false,
    publisherLogin: "alice",
    manifest: {
      manifestVersion: 2,
      id: "alice-theme",
      name: { en: "Alice Theme", "zh-CN": "爱丽丝主题" },
      version: "1.0.0",
      web: { apiVersion: 1, entry: "web/index.mjs", style: "web/theme.css" },
    },
    source: {
      id: "alice-theme",
      repository: "https://github.com/alice/alice-theme",
      trustTier: "community",
    },
    files: new Map([
      ["manifest.json", Buffer.from("{}")],
      ["web/index.mjs", Buffer.from("export function activate() { return true; }\n")],
      ["web/theme.css", Buffer.from(":root { --accent: #3b82f6; }\n")],
    ]),
    ...overrides,
  };
}

describe("scanFrontendAutoApproveRisks", () => {
  it("returns empty array for pure CSS or clean JS files", () => {
    const cssOnly = new Map([
      ["manifest.json", Buffer.from("{}")],
      [
        "styles/theme.css",
        Buffer.from("/* document.cookie sendBeacon new WebSocket 'node:fs' */\nbody { color: red; }\n"),
      ],
    ]);
    assert.deepEqual(scanFrontendAutoApproveRisks(cssOnly), []);

    const cleanJs = new Map([
      ["src/app.mjs", Buffer.from("export const greet = (name) => `hello ${name}`;\n")],
    ]);
    assert.deepEqual(scanFrontendAutoApproveRisks(cleanJs), []);
  });

  it("detects high-risk frontend patterns across supported JS/TS extensions", () => {
    const files = new Map([
      ["a.js", Buffer.from("const c = document.cookie;\n")],
      ["b.mjs", Buffer.from("navigator.sendBeacon('/collect', data);\n")],
      ["c.cjs", Buffer.from("const ws = new WebSocket('wss://example.com');\n")],
      ["d.ts", Buffer.from("import fs from 'node:fs';\n")],
      ["e.tsx", Buffer.from('import path from "node:path/posix"; const c = document.cookie;\n')],
      ["f.jsx", Buffer.from("export const view = () => new WebSocket('wss://a.example');\n")],
      ["ignore.css", Buffer.from("/* document.cookie */")],
    ]);

    assert.deepEqual(scanFrontendAutoApproveRisks(files), [
      { file: "a.js", rules: ["document.cookie"] },
      { file: "b.mjs", rules: ["sendBeacon"] },
      { file: "c.cjs", rules: ["new WebSocket"] },
      { file: "d.ts", rules: ["node:* builtin import"] },
      { file: "e.tsx", rules: ["document.cookie", "node:* builtin import"] },
      { file: "f.jsx", rules: ["new WebSocket"] },
    ]);
  });
});

describe("evaluateAutoApproval", () => {
  it("approves personal repository owner submitting a frontend-only extension", () => {
    const result = evaluateAutoApproval(
      makeBaseInput({
        issueUser: { login: "Alice", type: "User" },
        repositoryMeta: {
          private: false,
          archived: false,
          owner: { login: "alice", type: "User" },
        },
      }),
    );
    assert.equal(result.eligible, true);
    assert.deepEqual(result.reasons, []);
    assert.ok(result.summaryZh.length > 0);
    assert.ok(result.summaryEn.length > 0);
  });

  it("approves personal repository owner submitting a pure CSS theme without JS files", () => {
    const result = evaluateAutoApproval(
      makeBaseInput({
        manifest: {
          manifestVersion: 2,
          id: "pure-css-theme",
          name: "Pure CSS Theme",
          version: "1.0.0",
          web: { apiVersion: 1, style: "theme.css" },
        },
        files: new Map([
          ["manifest.json", Buffer.from("{}")],
          ["theme.css", Buffer.from(":root { --bg: #111; }\n")],
        ]),
      }),
    );
    assert.equal(result.eligible, true);
    assert.deepEqual(result.reasons, []);
  });

  it("rejects extensions with manifest.backend in both v2 (backend.entry) and v1 (backend.script)", () => {
    const v2Result = evaluateAutoApproval(
      makeBaseInput({
        manifest: {
          manifestVersion: 2,
          id: "with-backend-v2",
          name: "Backend V2",
          version: "1.0.0",
          page: { apiVersion: 1, entry: "page.mjs" },
          backend: { apiVersion: 1, entry: "backend.mjs" },
        },
      }),
    );
    assert.equal(v2Result.eligible, false);
    assert.match(v2Result.reasons.join("\n"), /后端|backend/iu);

    const v1Result = evaluateAutoApproval(
      makeBaseInput({
        manifest: {
          manifestVersion: 1,
          desktopApi: 1,
          id: "with-backend-v1",
          name: "Backend V1",
          version: "1.0.0",
          desktop: { script: "desktop.js" },
          backend: { script: "backend.js" },
        },
      }),
    );
    assert.equal(v1Result.eligible, false);
    assert.match(v1Result.reasons.join("\n"), /后端|backend/iu);
  });

  it("rejects submissions where issue author does not match repository owner", () => {
    const result = evaluateAutoApproval(
      makeBaseInput({
        issueUser: { login: "bob", type: "User" },
        repositoryMeta: {
          private: false,
          archived: false,
          owner: { login: "alice", type: "User" },
        },
      }),
    );
    assert.equal(result.eligible, false);
    assert.match(result.reasons.join("\n"), /@bob/);
    assert.match(result.reasons.join("\n"), /@alice/);
  });

  it("rejects Bot accounts, archived repositories, private repositories, and missing metadata", () => {
    const botResult = evaluateAutoApproval(
      makeBaseInput({
        issueUser: { login: "dependabot[bot]", type: "Bot" },
      }),
    );
    assert.equal(botResult.eligible, false);
    assert.match(botResult.reasons.join("\n"), /Bot/iu);

    const archivedResult = evaluateAutoApproval(
      makeBaseInput({
        repositoryMeta: {
          private: false,
          archived: true,
          owner: { login: "alice", type: "User" },
        },
      }),
    );
    assert.equal(archivedResult.eligible, false);
    assert.match(archivedResult.reasons.join("\n"), /归档|archived/iu);

    const privateResult = evaluateAutoApproval(
      makeBaseInput({
        repositoryMeta: {
          private: true,
          archived: false,
          owner: { login: "alice", type: "User" },
        },
      }),
    );
    assert.equal(privateResult.eligible, false);

    const missingMetaResult = evaluateAutoApproval(
      makeBaseInput({
        repositoryMeta: undefined,
      }),
    );
    assert.equal(missingMetaResult.eligible, false);
  });

  it("handles Organization repositories requiring both public membership and matching publisher", () => {
    const orgMeta = {
      private: false,
      archived: false,
      owner: { login: "acme-org", type: "Organization" },
    };

    const approved = evaluateAutoApproval(
      makeBaseInput({
        issueUser: { login: "alice", type: "User" },
        repositoryMeta: orgMeta,
        isOrgPublicMember: true,
        publisherLogin: "Alice",
      }),
    );
    assert.equal(approved.eligible, true);
    assert.deepEqual(approved.reasons, []);

    const memberNotPublisher = evaluateAutoApproval(
      makeBaseInput({
        issueUser: { login: "alice", type: "User" },
        repositoryMeta: orgMeta,
        isOrgPublicMember: true,
        publisherLogin: "bob",
      }),
    );
    assert.equal(memberNotPublisher.eligible, false);
    assert.match(memberNotPublisher.reasons.join("\n"), /发布者|publisher/iu);

    const publisherNotPublicMember = evaluateAutoApproval(
      makeBaseInput({
        issueUser: { login: "alice", type: "User" },
        repositoryMeta: orgMeta,
        isOrgPublicMember: false,
        publisherLogin: "alice",
      }),
    );
    assert.equal(publisherNotPublicMember.eligible, false);
    assert.match(publisherNotPublicMember.reasons.join("\n"), /公开成员|public member/iu);
  });

  it("rejects frontend scripts matching high-risk patterns and includes file names and rules", () => {
    const cases = [
      ["src/cookie.mjs", "console.log(document.cookie);", "document.cookie"],
      ["src/ws.js", "const s = new WebSocket('wss://example.com');", "new WebSocket"],
      ["src/beacon.ts", "navigator.sendBeacon('https://example.com', 'x');", "sendBeacon"],
      ["src/node-import.mjs", 'import fs from "node:fs";', "node:* builtin import"],
    ];

    for (const [file, code, expectedRule] of cases) {
      const result = evaluateAutoApproval(
        makeBaseInput({
          files: new Map([
            ["manifest.json", Buffer.from("{}")],
            [file, Buffer.from(code)],
          ]),
        }),
      );
      assert.equal(result.eligible, false, `expected ${file} to be rejected`);
      const joined = result.reasons.join("\n");
      assert.ok(joined.includes(file), `expected reason to include filename ${file}`);
      assert.ok(joined.includes(expectedRule), `expected reason to include rule ${expectedRule}`);
    }
  });

  it("rejects official trustTier or allowChildProcess source entries", () => {
    const officialResult = evaluateAutoApproval(
      makeBaseInput({
        source: {
          id: "alice-theme",
          repository: "https://github.com/alice/alice-theme",
          trustTier: "official",
        },
      }),
    );
    assert.equal(officialResult.eligible, false);
    assert.match(officialResult.reasons.join("\n"), /trustTier/u);

    const childProcessResult = evaluateAutoApproval(
      makeBaseInput({
        source: {
          id: "alice-theme",
          repository: "https://github.com/alice/alice-theme",
          trustTier: "community",
          allowChildProcess: true,
        },
      }),
    );
    assert.equal(childProcessResult.eligible, false);
    assert.match(childProcessResult.reasons.join("\n"), /allowChildProcess/u);
  });
});

describe("buildPrPreview", () => {
  it("renders review mode row for eligible and manual-review submissions", () => {
    const base = {
      issueNumber: 42,
      issueAuthorLogin: "alice",
      repository: "https://github.com/alice/alice-theme",
      id: "alice-theme",
      manifest: {
        id: "alice-theme",
        name: "Alice Theme",
        version: "1.0.0",
        web: { apiVersion: 1, style: "theme.css" },
      },
      iconUrl: undefined,
      screenshotUrls: [],
      releaseTag: "v1.0.0",
    };

    const eligibleMd = buildPrPreview({
      ...base,
      autoApproval: {
        eligible: true,
        reasons: [],
        summaryZh: "纯前端且仓库本人投稿，通过自动校验与安全检查",
        summaryEn: "Frontend-only extension submitted by repository owner",
      },
    });
    assert.match(eligibleMd, /\| 审核方式 \| 🟢 满足自动通过条件（纯前端且仓库本人投稿） \|/u);

    const manualMd = buildPrPreview({
      ...base,
      autoApproval: {
        eligible: false,
        reasons: ["包含本地 Node 后端（manifest.backend） (Declares a local Node backend)"],
        summaryZh: "包含本地 Node 后端（manifest.backend）",
        summaryEn: "Declares a local Node backend",
      },
    });
    assert.match(
      manualMd,
      /\| 审核方式 \| 🟡 需维护者人工审核（包含本地 Node 后端（manifest\.backend）） \|/u,
    );
  });
});

describe("isSubmissionIssue and extractRepositoryUrl", () => {
  it("accepts both standard and manual-review submission templates", () => {
    assert.equal(
      isSubmissionIssue({
        title: "[Desktop extension] My Ext",
        body: "### GitHub repository URL\n\nhttps://github.com/alice/my-ext",
      }),
      true,
    );
    assert.equal(
      isSubmissionIssue({
        title: "[Manual review] git-branch-status",
        body: "### Repository URL / 扩展仓库地址\n\nhttps://github.com/alice/git-branch-status",
      }),
      true,
    );
    assert.equal(
      isSubmissionIssue({
        title: "[Alert] Extension registry sync worker unhealthy",
        body: "Worker health check failed.",
      }),
      false,
    );

    assert.deepEqual(
      extractRepositoryUrl(
        "### Repository URL / 扩展仓库地址\n\nhttps://github.com/ABC-xiaoxuan/codexhost-git-branch-status\n\n### Extension introduction\n...",
      ),
      {
        owner: "ABC-xiaoxuan",
        repo: "codexhost-git-branch-status",
        repository: "https://github.com/ABC-xiaoxuan/codexhost-git-branch-status",
      },
    );
  });
});

describe("detectBackendChildProcessFiles", () => {
  it("returns backend files using child_process when frontend is clean", () => {
    const manifest = {
      manifestVersion: 2,
      web: { apiVersion: 1, entry: "web/index.mjs" },
      backend: { apiVersion: 1, entry: "backend/index.mjs" },
    };
    const files = new Map([
      ["web/index.mjs", Buffer.from("export function activate() {}\n")],
      ["backend/index.mjs", Buffer.from('import { execFile } from "node:child_process";\n')],
    ]);
    assert.deepEqual(detectBackendChildProcessFiles(manifest, files), ["backend/index.mjs"]);
  });

  it("returns empty array when frontend uses child_process or manifest has no backend", () => {
    const manifest = {
      manifestVersion: 2,
      web: { apiVersion: 1, entry: "web/index.mjs" },
      backend: { apiVersion: 1, entry: "backend/index.mjs" },
    };
    const frontendHit = new Map([
      ["web/index.mjs", Buffer.from('import { exec } from "node:child_process";\n')],
      ["backend/index.mjs", Buffer.from('import { execFile } from "node:child_process";\n')],
    ]);
    assert.deepEqual(detectBackendChildProcessFiles(manifest, frontendHit), []);

    const noBackend = {
      manifestVersion: 2,
      web: { apiVersion: 1, entry: "web/index.mjs" },
    };
    assert.deepEqual(detectBackendChildProcessFiles(noBackend, frontendHit), []);
  });
});
