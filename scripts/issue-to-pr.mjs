import { readFile, writeFile } from "node:fs/promises";
import {
  DESKTOP_EXTENSION_MANIFEST_MAX_BYTES,
  DESKTOP_EXTENSION_ZIP_MAX_BYTES,
  desktopExtensionIdSchema,
  isGitHubDesktopExtensionZipballUrl,
  readDesktopExtensionZip,
} from "../runtime.mjs";
import { parseManifest } from "../validate-and-build-catalog.mjs";

const githubRepoPattern =
  /https:\/\/github\.com\/([\w-]+)\/([\w-][\w.-]*?)(?:\.git)?(?:[/?#][^\s)\]>]*)?(?=[\s)\]>]|$)/iu;
const githubHeaders = {
  accept: "application/vnd.github+json",
  "user-agent": "codexhost-desktop-extension-registry",
};
const safeAssetName = /^[\w.-]+\.zip$/iu;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const assetOrigins = new Set([
  "https://github.com",
  "https://release-assets.githubusercontent.com",
  "https://objects.githubusercontent.com",
  "https://github-releases.githubusercontent.com",
]);

function authHeaders() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  return token ? { ...githubHeaders, authorization: `Bearer ${token}` } : { ...githubHeaders };
}

async function readResponseBytes(response, limit, label) {
  const { body } = response;
  if (!response.ok || !body || Number(response.headers.get("content-length")) > limit) {
    await body?.cancel();
    throw new Error(`${label} unavailable or too large (HTTP ${response.status})`);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > limit) throw new Error(`${label} exceeds the size limit`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function download(input, limit, { headers, missingOk = false } = {}) {
  let url = new URL(input);
  const zipball = isGitHubDesktopExtensionZipballUrl(url);
  const signal = AbortSignal.timeout(15_000);
  for (let redirects = 0; redirects <= 4; redirects++) {
    const response = await fetch(url, { headers, signal, redirect: "manual" });
    const body = response.body;
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await body?.cancel();
      const location = response.headers.get("location");
      if (!location || (headers && !zipball)) {
        throw new Error("Unexpected GitHub API or asset redirect");
      }
      url = new URL(location, url);
      if (
        !(zipball ? url.origin === "https://codeload.github.com" : assetOrigins.has(url.origin)) ||
        url.username ||
        url.password
      ) {
        throw new Error("Untrusted GitHub archive or asset redirect");
      }
      continue;
    }
    if (missingOk && response.status === 404) {
      await body?.cancel();
      return undefined;
    }
    return readResponseBytes(response, limit, "GitHub download");
  }
  throw new Error("Too many GitHub asset redirects");
}

async function loadGitHubJson(url, headers, missingOk = false) {
  const bytes = await download(url, 1024 * 1024, { headers, missingOk });
  return bytes === undefined ? undefined : JSON.parse(utf8.decode(bytes));
}

function extractRepositoryUrl(issueBody) {
  const body = String(issueBody ?? "");
  const sectionMatch = /###\s*GitHub repository URL\s*\r?\n+([\s\S]*?)(?:\r?\n###\s|$)/iu.exec(body);
  const searchArea = sectionMatch ? sectionMatch[1] : body;
  const match = githubRepoPattern.exec(searchArea);
  if (!match) {
    throw new Error(
      "Could not find a valid public GitHub repository URL (`https://github.com/owner/repo`) in the issue body.",
    );
  }
  const owner = match[1];
  const repo = match[2].replace(/\.git$/iu, "");
  return {
    owner,
    repo,
    repository: `https://github.com/${owner}/${repo}`,
  };
}

function resolveReleaseImageUrl(release, owner, repo, relativePath) {
  if (!release || !Array.isArray(release.assets)) return undefined;
  const baseName = relativePath.split("/").at(-1);
  const matches = release.assets.filter(({ name }) => name === baseName);
  if (matches.length !== 1) return undefined;
  const url = new URL(matches[0].browser_download_url);
  if (
    url.origin !== "https://github.com" ||
    url.username ||
    url.password ||
    !url.pathname.toLowerCase().startsWith(`/${owner}/${repo}/releases/download/`.toLowerCase())
  ) {
    return undefined;
  }
  return url.href;
}

function resolveRawImageUrl(owner, repo, sha, relativePath) {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${sha}/${relativePath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

async function resolveExtensionManifest(owner, repo) {
  const api = `https://api.github.com/repos/${owner}/${repo}`;
  const headers = authHeaders();
  const release = await loadGitHubJson(`${api}/releases/latest`, headers, true);
  let downloadUrl;
  let useApiHeaders = false;
  let usedRelease;
  let commitSha;
  if (release && !release.draft && !release.prerelease && Array.isArray(release.assets)) {
    const zipAssets = release.assets.filter(
      ({ name }) => typeof name === "string" && safeAssetName.test(name),
    );
    if (zipAssets.length > 1) {
      throw new Error(
        "Multiple Release .zip assets found; keep a single .zip asset in the latest Release or submit a PR with sources[].asset set.",
      );
    }
    if (zipAssets.length === 1) {
      downloadUrl = zipAssets[0].browser_download_url;
      usedRelease = release;
    }
  }
  if (!downloadUrl) {
    const commits = await loadGitHubJson(`${api}/commits?per_page=1`, headers);
    const sha = commits?.[0]?.sha;
    if (!sha || !/^[a-f0-9]{40}$/u.test(sha)) {
      throw new Error("Could not resolve default branch HEAD commit for the repository.");
    }
    downloadUrl = `${api}/zipball/${sha}`;
    useApiHeaders = true;
    commitSha = sha;
  }
  const zip = await download(
    downloadUrl,
    DESKTOP_EXTENSION_ZIP_MAX_BYTES,
    useApiHeaders ? { headers: githubHeaders } : {},
  );
  const files = readDesktopExtensionZip(zip);
  const manifestBytes = files.get("manifest.json");
  if (!manifestBytes || manifestBytes.length > DESKTOP_EXTENSION_MANIFEST_MAX_BYTES) {
    throw new Error("Missing or oversized manifest.json in the extension package.");
  }
  const manifest = parseManifest(JSON.parse(utf8.decode(manifestBytes)));
  const id = desktopExtensionIdSchema.parse(manifest.id);

  const resolveImage = (relativePath) =>
    usedRelease
      ? resolveReleaseImageUrl(usedRelease, owner, repo, relativePath)
      : commitSha
        ? resolveRawImageUrl(owner, repo, commitSha, relativePath)
        : undefined;

  const iconUrl = manifest.icon ? resolveImage(manifest.icon) : undefined;
  const screenshotUrls = (manifest.screenshots ?? [])
    .map((path) => resolveImage(path))
    .filter(Boolean);

  return { id, manifest, iconUrl, screenshotUrls, releaseTag: usedRelease?.tag_name };
}

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

function pickLocalized(value) {
  if (typeof value === "string") {
    return { zh: value.trim(), en: undefined };
  }
  if (!value || typeof value !== "object") {
    return { zh: undefined, en: undefined };
  }
  const zh =
    (typeof value["zh-CN"] === "string" && value["zh-CN"].trim()) ||
    (typeof value.zh === "string" && value.zh.trim()) ||
    undefined;
  const en =
    (typeof value.en === "string" && value.en.trim()) ||
    (typeof value["en-US"] === "string" && value["en-US"].trim()) ||
    undefined;
  if (!zh && !en) {
    const first = Object.values(value).find((item) => typeof item === "string" && item.trim());
    return { zh: first?.trim(), en: undefined };
  }
  return { zh, en };
}

function formatCodeList(items, fallback = "无") {
  if (!Array.isArray(items) || items.length === 0) return fallback;
  return items.map((item) => `\`${item}\``).join(" · ");
}

function buildPrPreview({
  issueNumber,
  issueAuthorLogin,
  repository,
  id,
  manifest,
  iconUrl,
  screenshotUrls,
  releaseTag,
}) {
  const name = pickLocalized(manifest.name);
  const primaryName = name.zh || name.en || id;
  const secondaryName = name.zh && name.en && name.zh !== name.en ? name.en : undefined;

  const description = pickLocalized(manifest.description);
  const details = pickLocalized(manifest.details);
  const capabilities = [
    manifest.page ? "工作区页面" : null,
    manifest.widget ? "悬浮组件" : null,
    manifest.desktop || manifest.web ? "前端 UI" : null,
    manifest.backend ? "独立 Node 后端" : null,
    manifest.settingsSchema?.length ? "声明式设置" : null,
  ].filter(Boolean);

  const lines = [`Closes #${issueNumber}`, ""];

  if (iconUrl) {
    const titleHtml = secondaryName
      ? `<strong>${escapeHtml(primaryName)}</strong>（${escapeHtml(secondaryName)}）`
      : `<strong>${escapeHtml(primaryName)}</strong>`;
    lines.push(
      "<table>",
      "  <tr>",
      `    <td width="64" align="center"><img src="${escapeHtml(iconUrl)}" width="48" height="48" alt="${escapeHtml(id)}" /></td>`,
      "    <td>",
      `      ${titleHtml}<br/>`,
      `      <code>${escapeHtml(id)}</code> · <code>v${escapeHtml(manifest.version)}</code>${manifest.author ? ` · 作者：<code>${escapeHtml(manifest.author)}</code>` : ""}`,
      "    </td>",
      "  </tr>",
      "</table>",
      "",
    );
  } else {
    const titleText = secondaryName ? `${primaryName}（${secondaryName}）` : primaryName;
    lines.push(
      `## ${titleText}`,
      "",
      `\`${id}\` · \`v${manifest.version}\`${manifest.author ? ` · 作者：\`${manifest.author}\`` : ""}`,
      "",
    );
  }

  lines.push(
    "| 项目 | 内容 |",
    "| --- | --- |",
    ...(issueAuthorLogin ? [`| 投稿者 | @${issueAuthorLogin} |`] : []),
    `| 仓库地址 | ${repository} |`,
    `| 发布来源 | ${releaseTag ? `Release \`${releaseTag}\`` : "默认分支源码"} |`,
    `| 分类 | ${formatCodeList(manifest.categories)} |`,
    `| 占用槽位 | ${formatCodeList(manifest.slots)} |`,
    `| 能力范围 | ${capabilities.length ? capabilities.join(" + ") : "仅声明"} |`,
    "| 自动校验 | `node validate-and-build-catalog.mjs --check-only` 通过 ✅ |",
    "",
  );

  if (description.zh || description.en) {
    lines.push("### 简介", "");
    if (description.zh) lines.push(description.zh, "");
    if (description.en && description.en !== description.zh) {
      lines.push(`> ${description.en}`, "");
    }
  }

  if (details.zh || details.en) {
    lines.push("### 详细介绍", "");
    if (details.zh) {
      lines.push(details.zh, "");
    } else if (details.en) {
      lines.push(details.en, "");
    }
    if (details.zh && details.en && details.en !== details.zh) {
      lines.push(
        "<details>",
        "<summary>English details</summary>",
        "",
        details.en,
        "",
        "</details>",
        "",
      );
    }
  }

  if (screenshotUrls.length > 0) {
    lines.push(`### 预览截图（${screenshotUrls.length} 张）`, "");
    for (let index = 0; index < screenshotUrls.length; index++) {
      lines.push(
        `<img src="${escapeHtml(screenshotUrls[index])}" alt="${escapeHtml(id)} screenshot ${index + 1}" width="420" />`,
      );
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

async function setOutput(key, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  const clean = String(value ?? "").replace(/[\r\n]+/gu, " ");
  await writeFile(outputPath, `${key}=${clean}\n`, { flag: "a", encoding: "utf8" });
}

async function main() {
  const repoFull = process.env.GITHUB_REPOSITORY;
  const issueNumber = Number(process.env.ISSUE_NUMBER);
  if (!repoFull || !Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error("Missing GITHUB_REPOSITORY or valid ISSUE_NUMBER");
  }

  const issue = await loadGitHubJson(
    `https://api.github.com/repos/${repoFull}/issues/${issueNumber}`,
    authHeaders(),
  );
  const isSubmission =
    String(issue.title ?? "").startsWith("[Desktop extension]") ||
    /###\s*GitHub repository URL/iu.test(String(issue.body ?? ""));
  if (!isSubmission) {
    await setOutput("status", "skip");
    console.log(`Issue #${issueNumber} is not an extension submission; skipping.`);
    return;
  }

  const { owner, repo, repository } = extractRepositoryUrl(issue.body);
  const { id, manifest, iconUrl, screenshotUrls, releaseTag } = await resolveExtensionManifest(
    owner,
    repo,
  );

  const sourcesPath = new URL("../sources.json", import.meta.url);
  const data = JSON.parse(await readFile(sourcesPath, "utf8"));
  const existing = data.sources.find(
    (entry) =>
      entry.id === id || entry.repository.toLowerCase() === repository.toLowerCase(),
  );
  if (existing) {
    await setOutput("status", "already-exists");
    await setOutput("extension_id", existing.id);
    await setOutput("repository_url", existing.repository);
    console.log(`Extension ${existing.id} (${existing.repository}) is already in sources.json.`);
    return;
  }

  data.sources.push({
    id,
    repository,
    trustTier: "community",
  });
  data.sources.sort((a, b) => a.id.localeCompare(b.id));
  await writeFile(sourcesPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");

  const issueAuthorLogin =
    typeof issue?.user?.login === "string" && /^[\w-]+$/u.test(issue.user.login)
      ? issue.user.login
      : "";
  const issueAuthorId = Number.isInteger(issue?.user?.id) && issue.user.id > 0 ? issue.user.id : 0;
  const issueAuthorEmail =
    issueAuthorLogin && issueAuthorId
      ? `${issueAuthorId}+${issueAuthorLogin}@users.noreply.github.com`
      : "";

  const previewMarkdown = buildPrPreview({
    issueNumber,
    issueAuthorLogin,
    repository,
    id,
    manifest,
    iconUrl,
    screenshotUrls,
    releaseTag,
  });
  await writeFile(new URL("../pr-preview.md", import.meta.url), previewMarkdown, "utf8");

  await setOutput("status", "prepared");
  await setOutput("extension_id", id);
  await setOutput("repository_url", repository);
  await setOutput("issue_author_login", issueAuthorLogin);
  await setOutput("issue_author_email", issueAuthorEmail);
  console.log(`Prepared sources.json entry and PR preview for ${id} (${repository}).`);
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  await setOutput("status", "error");
  await setOutput("error_message", message);
  console.error(message);
  process.exitCode = 1;
});
