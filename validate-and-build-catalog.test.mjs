import assert from "node:assert/strict";
import test from "node:test";
import {
  extractChangelogFromReleases,
  extractFallbackChangelogFromFiles,
  normalizeChangelogNotes,
} from "./validate-and-build-catalog.mjs";

test("normalizeChangelogNotes normalizes line endings, collapses blank lines, and truncates cleanly", () => {
  assert.equal(normalizeChangelogNotes("   \r\n  "), undefined);
  assert.equal(normalizeChangelogNotes("line 1\r\n\r\n\r\n\r\nline 2\r\n"), "line 1\n\nline 2");
  const longText = `${"a".repeat(3800)}\n${"b".repeat(500)}`;
  const truncated = normalizeChangelogNotes(longText, 4000);
  assert.ok(truncated && truncated.length <= 4000);
  assert.ok(truncated.endsWith("…"));
  assert.equal(truncated, `${"a".repeat(3800)}…`);
});

test("extractChangelogFromReleases skips drafts/prereleases/empty bodies, deduplicates, and caps at 5", () => {
  const releases = [
    {
      id: 10,
      tag_name: "v0.3.0-beta.1",
      draft: false,
      prerelease: true,
      published_at: "2026-11-28T10:00:00Z",
      body: "Beta notes",
      html_url: "https://github.com/owner/repo/releases/tag/v0.3.0-beta.1",
    },
    {
      id: 9,
      tag_name: "v0.2.0",
      draft: false,
      prerelease: false,
      published_at: "2026-11-28T08:00:00Z",
      body: "- Added handoff links",
      html_url: "https://github.com/owner/repo/releases/tag/v0.2.0",
    },
    {
      id: 8,
      tag_name: "v0.1.9",
      draft: false,
      prerelease: false,
      published_at: "2026-11-27T08:00:00Z",
      body: "   ",
      html_url: "https://github.com/owner/repo/releases/tag/v0.1.9",
    },
    ...Array.from({ length: 6 }, (_, i) => ({
      id: 7 - i,
      tag_name: `v0.1.${5 - i}`,
      draft: false,
      prerelease: false,
      published_at: `2026-11-2${5 - i}T00:00:00Z`,
      body: `Release 0.1.${5 - i}`,
      html_url: `https://github.com/owner/repo/releases/tag/v0.1.${5 - i}`,
    })),
  ];

  const entries = extractChangelogFromReleases(releases, {
    selectedReleaseId: 9,
    manifestVersion: "0.2.0",
  });
  assert.equal(entries.length, 5);
  assert.deepEqual(entries[0], {
    version: "0.2.0",
    publishedAt: "2026-11-28T08:00:00Z",
    notes: "- Added handoff links",
    url: "https://github.com/owner/repo/releases/tag/v0.2.0",
  });
  assert.deepEqual(
    entries.map((entry) => entry.version),
    ["0.2.0", "0.1.5", "0.1.4", "0.1.3", "0.1.2"],
  );
});

test("extractFallbackChangelogFromFiles reads root CHANGELOG.md when no release notes exist", () => {
  const files = new Map([
    ["manifest.json", Buffer.from("{}")],
    ["nested/CHANGELOG.md", Buffer.from("ignored nested")],
    ["CHANGELOG.md", Buffer.from("## 0.1.1\n\n- Initial commit release\n")],
  ]);
  assert.deepEqual(
    extractFallbackChangelogFromFiles(files, {
      manifestVersion: "0.1.1",
      publishedAt: "2026-11-20T00:00:00Z",
    }),
    [
      {
        version: "0.1.1",
        publishedAt: "2026-11-20T00:00:00Z",
        notes: "## 0.1.1\n\n- Initial commit release",
      },
    ],
  );
});
