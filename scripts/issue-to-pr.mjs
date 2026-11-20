import { readFile, writeFile } from "node:fs/promises";
import {
  DESKTOP_EXTENSION_MANIFEST_MAX_BYTES,
  DESKTOP_EXTENSION_ZIP_MAX_BYTES,
  desktopExtensionIdSchema,
  desktopExtensionManifestSchema,
  isGitHubDesktopExtensionZipballUrl,
  readDesktopExtensionZip,
} from "../runtime.mjs";

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

async function resolveExtensionManifest(owner, repo) {
  const api = `https://api.github.com/repos/${owner}/${repo}`;
  const headers = authHeaders();
  const release = await loadGitHubJson(`${api}/releases/latest`, headers, true);
  let downloadUrl;
  let useApiHeaders = false;
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
  const manifest = desktopExtensionManifestSchema.parse(JSON.parse(utf8.decode(manifestBytes)));
  const id = desktopExtensionIdSchema.parse(manifest.id);
  return { id, manifest };
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
  const { id } = await resolveExtensionManifest(owner, repo);

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

  await setOutput("status", "prepared");
  await setOutput("extension_id", id);
  await setOutput("repository_url", repository);
  console.log(`Prepared sources.json entry for ${id} (${repository}).`);
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  await setOutput("status", "error");
  await setOutput("error_message", message);
  console.error(message);
  process.exitCode = 1;
});
