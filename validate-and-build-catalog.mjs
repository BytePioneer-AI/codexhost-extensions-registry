import { createHash } from "node:crypto";
import { lstat, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Script } from "node:vm";
import { z } from "zod";
import {
  DESKTOP_EXTENSION_ICON_MAX_BYTES,
  DESKTOP_EXTENSION_MANIFEST_MAX_BYTES,
  DESKTOP_EXTENSION_SCREENSHOT_MAX_BYTES,
  DESKTOP_EXTENSION_SCRIPT_MAX_BYTES,
  DESKTOP_EXTENSION_STYLE_MAX_BYTES,
  DESKTOP_EXTENSION_ZIP_MAX_BYTES,
  compareExtensionVersions,
  desktopExtensionCatalogEntrySchema,
  desktopExtensionCatalogSchema,
  desktopExtensionHttpUrlSchema,
  desktopExtensionIdSchema,
  desktopExtensionManifestSchema,
  desktopExtensionScreenshotMimeType,
  desktopExtensionZipUrlSchema,
  isGitHubDesktopExtensionZipballUrl,
  readDesktopExtensionZip,
} from "./runtime.mjs";

const github = /^https:\/\/github\.com\/([\w-]+)\/([\w-][\w.-]*)\/?$/u;
const githubHeaders = {
  accept: "application/vnd.github+json",
  "user-agent": "codexhost-desktop-extension-registry",
};
const safeAssetName = /^[\w.-]+\.zip$/iu;
const sourceSchema = z.strictObject({
  id: desktopExtensionIdSchema,
  repository: z.string().regex(github),
  asset: z.string().regex(safeAssetName).optional(),
  trustTier: z.enum(["official", "community"]).default("community"),
  minCodexHostVersion: z.string().min(1).optional(),
  allowChildProcess: z.boolean().optional(),
});
const legacySourcesSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sources: z.array(sourceSchema),
});

async function readSourceJson(path, parse) {
  try {
    return parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    throw new Error(`${path}: ${error.message}`, { cause: error });
  }
}

export async function loadSources(input = new URL("sources/", import.meta.url)) {
  const path = resolve(input instanceof URL ? fileURLToPath(input) : input);
  const info = await lstat(path);
  const ids = new Set();
  const sources = [];
  function add(source, filename) {
    if (ids.has(source.id)) throw new Error(`Duplicate source ID: ${source.id}`);
    if (filename !== undefined && filename !== `${source.id}.json`)
      throw new Error(`Source ID ${source.id} does not match filename ${filename}`);
    ids.add(source.id);
    sources.push(source);
  }

  if (info.isDirectory()) {
    const files = await readdir(path, { withFileTypes: true });
    files.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const file of files) {
      if (!file.name.toLowerCase().endsWith(".json")) continue;
      const id = file.name.slice(0, -5);
      if (!file.isFile() || !file.name.endsWith(".json") || !desktopExtensionIdSchema.safeParse(id).success)
        throw new Error(`Invalid source filename (expected a regular <id>.json file): ${file.name}`);
      add(await readSourceJson(join(path, file.name), (doc) => sourceSchema.parse(doc)), file.name);
    }
  } else if (info.isFile()) {
    const entries = await readSourceJson(path, (doc) => {
      if (doc && Object.hasOwn(doc, "sources")) return legacySourcesSchema.parse(doc).sources;
      return [sourceSchema.parse(doc)];
    });
    for (const source of entries) add(source);
  } else {
    throw new Error(`Expected a sources directory or JSON file: ${path}`);
  }
  return sources.sort((a, b) => a.id.localeCompare(b.id, "en"));
}
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const utf8 = new TextDecoder("utf-8", { fatal: true });
const assetOrigins = new Set([
  "https://github.com",
  "https://release-assets.githubusercontent.com",
  "https://objects.githubusercontent.com",
  "https://github-releases.githubusercontent.com",
]);
const checks = [
  ["eval", /\beval\s*\(/u],
  ["Function constructor", /\bnew\s+Function\b/u],
  ["child_process", /\bchild_process\b/u],
];

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
      if (!location || (headers && !zipball))
        throw new Error("Unexpected GitHub API or asset redirect");
      url = new URL(location, url);
      if (
        !(zipball ? url.origin === "https://codeload.github.com" : assetOrigins.has(url.origin)) ||
        url.username ||
        url.password
      )
        throw new Error("Untrusted GitHub archive or asset redirect");
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

function assetUrl(asset, owner, repo) {
  const url = new URL(asset.browser_download_url);
  if (
    url.origin !== "https://github.com" ||
    url.username ||
    url.password ||
    !url.pathname.toLowerCase().startsWith(`/${owner}/${repo}/releases/download/`.toLowerCase())
  )
    throw new Error("Release asset URL does not belong to the source repository");
  return url.href;
}

function getResource(files, path, limit) {
  const bytes = files.get(path);
  if (!bytes || bytes.length > limit) throw new Error(`Missing or oversized resource: ${path}`);
  return bytes;
}

function validateImage(bytes, path, label) {
  const mime = desktopExtensionScreenshotMimeType(path);
  const valid =
    mime === "image/png"
      ? bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a"
      : mime === "image/jpeg"
        ? bytes.subarray(0, 3).toString("hex") === "ffd8ff"
        : mime === "image/webp" &&
          bytes.subarray(0, 4).toString() === "RIFF" &&
          bytes.subarray(8, 12).toString() === "WEBP";
  if (!valid) throw new Error(`${label} type does not match ${path}`);
}

async function loadGitHubJson(url, headers, missingOk = false) {
  const bytes = await download(url, 1024 * 1024, { headers, missingOk });
  return bytes === undefined ? undefined : JSON.parse(utf8.decode(bytes));
}

async function readRepositoryStars(api, headers) {
  try {
    const metadata = await loadGitHubJson(api, headers);
    const { data } = desktopExtensionCatalogEntrySchema.shape.stars.safeParse(
      metadata?.stargazers_count,
    );
    return data;
  } catch {
    return undefined;
  }
}

async function readDownloadCounts() {
  try {
    const { data } = desktopExtensionHttpUrlSchema.safeParse(
      process.env.CODEXHOST_DESKTOP_EXTENSIONS_STATS_URL?.trim() || process.env.STATS_URL,
    );
    if (data === undefined) return;
    const url = new URL(data);
    url.pathname = `${url.pathname.replace(/\/+$/u, "")}/stats.json`;
    url.search = "";
    url.hash = "";
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5_000) });
    const bytes = await readResponseBytes(response, 1024 * 1024, "Download stats");
    const { downloads } = JSON.parse(utf8.decode(bytes));
    if (downloads && typeof downloads === "object" && !Array.isArray(downloads)) return downloads;
  } catch {
    // Optional data; missing counts must not prevent publishing the index.
  }
}

async function selectPackage(source, { owner, repo, api, headers }) {
  const release = await loadGitHubJson(`${api}/releases/latest`, headers, true);
  if (release !== undefined) {
    if (
      release.draft ||
      release.prerelease ||
      !release.published_at ||
      !Array.isArray(release.assets)
    )
      throw new Error("Expected a public stable Release");
    const zipAssets = release.assets.filter(
      ({ name }) =>
        typeof name === "string" &&
        safeAssetName.test(name) &&
        (!source.asset || name === source.asset),
    );
    if (zipAssets.length > 1)
      throw new Error("Multiple Release .zip assets; set asset in the source entry to disambiguate");
    const [asset] = zipAssets;
    if (asset)
      return {
        downloadUrl: assetUrl(asset, owner, repo),
        asset,
        release,
        date: release.published_at,
      };
  }
  if (source.asset) throw new Error(`Expected Release .zip asset ${source.asset}`);

  // Pin the catalog to the commit we validate, not a moving default branch.
  const [head] = await loadGitHubJson(`${api}/commits?per_page=1`, headers);
  const sha = z
    .string()
    .regex(/^[a-f0-9]{40}$/u)
    .parse(head?.sha);
  return {
    downloadUrl: `${api}/zipball/${sha}`,
    sha,
    date: z.iso.datetime().parse(head?.commit?.committer?.date),
  };
}

const v1Shape = desktopExtensionManifestSchema.shape;
const portablePath = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.includes("\\") &&
      !p.split("/").some((part) => !part || part === "." || part === ".." || /[. ]$/u.test(part)) &&
      !/[\x00-\x1f\x7f<>"|*]/u.test(p),
    "Expected a portable relative resource path",
  );
const moduleEntry = portablePath.refine((p) => p.endsWith(".mjs"), "Expected a .mjs entry");
const cssStyle = portablePath.refine((p) => p.endsWith(".css"), "Expected a .css style");
const frontendEntry = { apiVersion: z.literal(1), entry: moduleEntry, style: cssStyle.optional() };
const titleText = z.string().trim().min(1).max(128);
const canonicalPath = (path) => path.normalize("NFC").toLowerCase();
const manifestV2Schema = z
  .strictObject({
    manifestVersion: z.literal(2),
    id: v1Shape.id,
    name: v1Shape.name,
    version: v1Shape.version,
    description: v1Shape.description,
    details: v1Shape.details,
    author: v1Shape.author,
    repository: v1Shape.repository,
    icon: v1Shape.icon,
    screenshots: v1Shape.screenshots,
    categories: v1Shape.categories,
    settingsSchema: v1Shape.settingsSchema,
    slots: v1Shape.slots,
    page: z
      .strictObject({ ...frontendEntry, title: z.strictObject({ en: titleText, "zh-CN": titleText }).optional() })
      .optional(),
    widget: z.strictObject(frontendEntry).optional(),
    desktop: z
      .strictObject({
        apiVersion: z.literal(1),
        script: portablePath,
        style: portablePath.optional(),
      })
      .optional(),
    web: z
      .strictObject({
        apiVersion: z.literal(1),
        entry: moduleEntry.optional(),
        style: cssStyle.optional(),
      })
      .refine(({ entry, style }) => entry !== undefined || style !== undefined, "Expected a Web script or style")
      .optional(),
    backend: z
      .strictObject({
        apiVersion: z.literal(1),
        entry: moduleEntry,
        targets: z.array(z.enum(["desktop", "web"])).min(1).max(2).optional(),
      })
      .optional(),
  })
  .refine(
    ({ page, widget, desktop, web, backend }) => Boolean(page || widget || desktop || web || backend),
    "Expected at least one page, widget, desktop, Web, or backend entry",
  )
  .refine(
    ({ page, widget, web, backend }) =>
      !backend || [page?.entry, widget?.entry, web?.entry].every(
        (entry) => entry === undefined || canonicalPath(entry) !== canonicalPath(backend.entry),
      ),
    { path: ["backend", "entry"], message: "A backend entry cannot also be a frontend entry" },
  );

export function parseManifest(raw) {
  if (raw && typeof raw === "object" && raw.manifestVersion === 2) {
    return manifestV2Schema.parse(raw);
  }
  return desktopExtensionManifestSchema.parse(raw);
}

function resolveV2TargetsAndApis(manifest) {
  if (manifest.manifestVersion === 1) {
    return {
      targets: ["desktop"],
      apis: {
        desktop: manifest.desktopApi,
        ...(manifest.backend ? { backend: 1 } : {}),
      },
    };
  }
  const { page, widget, desktop, web, backend } = manifest;
  const unified = page || widget || (backend && !desktop && !web);
  const backendTargets = backend?.targets ?? [];
  // Preserve target/API inference for older v2 packages with an explicitly targeted backend.
  const desktopApi = desktop?.apiVersion ?? (!unified && backendTargets.includes("desktop") ? 1 : undefined);
  const webApi = web?.apiVersion ?? (!unified && backendTargets.includes("web") ? 1 : undefined);
  const targets = unified
    ? ["desktop", "web"]
    : [...(desktopApi ? ["desktop"] : []), ...(webApi ? ["web"] : [])];
  const apis = {
    ...(page ? { page: page.apiVersion } : {}),
    ...(widget ? { widget: widget.apiVersion } : {}),
    ...(desktopApi ? { desktop: desktopApi } : {}),
    ...(webApi ? { web: webApi } : {}),
    ...(backend ? { backend: backend.apiVersion } : {}),
  };
  return { targets, apis };
}

async function validateSource(source, previous, starsByRepository, downloads) {
  const [, owner, repositoryName] = github.exec(source.repository);
  const repo = repositoryName.replace(/\.git$/iu, "");
  const api = `https://api.github.com/repos/${owner}/${repo}`;
  const headers = { ...githubHeaders };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  const selected = await selectPackage(source, { owner, repo, api, headers });
  const { asset, release, date } = selected;
  const downloadUrl = desktopExtensionZipUrlSchema.parse(selected.downloadUrl);
  // The catalog URL must work for unauthenticated users, even when metadata uses a token.
  const zip = await download(
    downloadUrl,
    DESKTOP_EXTENSION_ZIP_MAX_BYTES,
    asset ? {} : { headers: githubHeaders },
  );
  const sha256 = digest(zip);
  if (asset?.digest != null && asset.digest !== `sha256:${sha256}`)
    throw new Error("Release SHA-256 does not match GitHub's digest");
  const files = readDesktopExtensionZip(zip);
  const manifest = parseManifest(
    JSON.parse(
      utf8.decode(getResource(files, "manifest.json", DESKTOP_EXTENSION_MANIFEST_MAX_BYTES)),
    ),
  );
  if (manifest.id !== source.id) throw new Error("Manifest id does not match the source entry");
  if (manifest.version !== manifest.version.trim())
    throw new Error("Manifest version has surrounding whitespace");
  if (
    previous &&
    (compareExtensionVersions(manifest.version, previous.version) < 0 ||
      (previous.version === manifest.version && previous.sha256 !== sha256))
  )
    throw new Error("Package is a downgrade or changed ZIP bytes without a version bump");
  if (manifest.desktop) {
    const { script, style } = manifest.desktop;
    if (!files.has(script))
      throw new Error(
        `Missing entry file ${script}. Commit the built JavaScript entry or publish a Release .zip.`,
      );
    const sourceCode = utf8.decode(getResource(files, script, DESKTOP_EXTENSION_SCRIPT_MAX_BYTES));
    new Script(`(function(define) { "use strict";\n${sourceCode}\n})`);
    if (style) utf8.decode(getResource(files, style, DESKTOP_EXTENSION_STYLE_MAX_BYTES));
  }
  if (manifest.manifestVersion === 2) {
    for (const frontend of [manifest.page, manifest.widget, manifest.web]) {
      if (!frontend) continue;
      const { entry, style } = frontend;
      if (entry) utf8.decode(getResource(files, entry, DESKTOP_EXTENSION_SCRIPT_MAX_BYTES));
      if (style) utf8.decode(getResource(files, style, DESKTOP_EXTENSION_STYLE_MAX_BYTES));
    }
  }
  const backendScript = manifest.manifestVersion === 2 ? manifest.backend?.entry : manifest.backend?.script;
  if (backendScript)
    utf8.decode(getResource(files, backendScript, DESKTOP_EXTENSION_SCRIPT_MAX_BYTES));
  if (source.allowChildProcess && !backendScript)
    throw new Error("allowChildProcess requires the extension manifest to declare a backend entry");
  const backendDir =
    backendScript && canonicalPath(backendScript).includes("/")
      ? canonicalPath(backendScript).slice(0, canonicalPath(backendScript).lastIndexOf("/") + 1)
      : undefined;
  const frontendFiles = new Set(
    [
      manifest.desktop?.script,
      ...(manifest.manifestVersion === 2
        ? [manifest.page?.entry, manifest.widget?.entry, manifest.web?.entry]
        : []),
    ]
      .filter(Boolean)
      .map(canonicalPath),
  );
  const frontendDirs = new Set(
    [...frontendFiles]
      .map((entry) => {
        const slash = entry.lastIndexOf("/");
        return slash > 0 ? entry.slice(0, slash + 1) : undefined;
      })
      .filter((dir) => dir && dir !== backendDir),
  );
  const isFrontendFile = (file) => {
    const normalized = canonicalPath(file);
    if (frontendFiles.has(normalized)) return true;
    for (const dir of frontendDirs) {
      if (normalized.startsWith(dir)) return true;
    }
    return false;
  };
  const exemptedChildProcessFiles = [];
  for (const [file, bytes] of files) {
    if (
      !frontendFiles.has(canonicalPath(file)) &&
      file !== backendScript &&
      !/\.[cm]?[jt]sx?$/iu.test(file)
    )
      continue;
    const code = utf8.decode(bytes);
    const hits = checks.filter(([, pattern]) => pattern.test(code)).map(([label]) => label);
    const blockedHits = [];
    for (const label of hits) {
      if (label === "child_process" && source.allowChildProcess && !isFrontendFile(file)) {
        exemptedChildProcessFiles.push(file);
        continue;
      }
      blockedHits.push(label);
    }
    if (blockedHits.length) throw new Error(`Static scan flagged ${file}: ${blockedHits.join(", ")}`);
  }
  async function resolveImage(path, maxBytes, label) {
    const bytes = getResource(files, path, maxBytes);
    validateImage(bytes, path, label);
    let url;
    if (release) {
      const matches = release.assets.filter(({ name }) => name === path.split("/").at(-1));
      if (matches.length !== 1)
        throw new Error(`Also attach ${path} to the Release as an individual image asset`);
      url = assetUrl(matches[0], owner, repo);
    } else {
      url = `https://raw.githubusercontent.com/${owner}/${repo}/${selected.sha}/${path.split("/").map(encodeURIComponent).join("/")}`;
    }
    if (!bytes.equals(await download(url, maxBytes)))
      throw new Error(`Published ${label.toLowerCase()} differs from ZIP: ${path}`);
    return url;
  }
  const icon = manifest.icon
    ? await resolveImage(manifest.icon, DESKTOP_EXTENSION_ICON_MAX_BYTES, "Icon")
    : undefined;
  const screenshots = [];
  for (const path of manifest.screenshots ?? []) {
    screenshots.push(
      await resolveImage(path, DESKTOP_EXTENSION_SCREENSHOT_MAX_BYTES, "Screenshot"),
    );
  }
  // Multiple sources can publish distinct assets from the same GitHub repository.
  const repositoryKey = api.toLowerCase();
  if (!starsByRepository.has(repositoryKey))
    starsByRepository.set(repositoryKey, await readRepositoryStars(api, headers));
  const baseEntry = desktopExtensionCatalogEntrySchema.parse({
    id: manifest.id,
    version: manifest.version,
    name: manifest.name,
    description: manifest.description,
    details: manifest.details,
    author: manifest.author,
    repository: manifest.repository ?? source.repository,
    stars: starsByRepository.get(repositoryKey),
    downloads,
    categories: manifest.categories,
    slots: manifest.slots,
    trustTier: source.trustTier,
    icon,
    screenshots: screenshots.length ? screenshots : undefined,
    downloadUrl,
    sha256,
    publishedAt: previous?.publishedAt ?? date,
    updatedAt: date,
    minCodexHostVersion: source.minCodexHostVersion,
  });
  const { targets, apis } = resolveV2TargetsAndApis(manifest);
  const v2Entry = {
    ...baseEntry,
    format: "codexhost",
    targets,
    apis,
  };
  return {
    v1Entry: manifest.manifestVersion === 1 ? baseEntry : undefined,
    v2Entry,
    exemptedChildProcessFiles,
  };
}

function inline(text) {
  // GitHub job summaries and report artifacts contain untrusted metadata.
  return String(text)
    .replace(/[\r\n]+/gu, " ")
    .replace(/[&<>`|\[\]()]/gu, (character) => `&#${character.charCodeAt(0)};`)
    .slice(0, 800);
}

export async function buildCatalog({
  directory = new URL("./", import.meta.url),
  sourcesPath = new URL("sources/", directory),
  checkOnly = false,
} = {}) {
  const report = [
    "# Desktop & Web extension safety report",
    "",
    "ZIP integrity, bundle layout, metadata, images and static patterns only. Passing is not a code audit or sandbox.",
    "",
  ];
  const catalogPath = new URL("catalog.json", directory);
  const catalogV2Path = new URL("catalog.v2.json", directory);
  const entries = [];
  const entriesV2 = [];
  const starsByRepository = new Map();
  let failed = false;
  try {
    const sources = await loadSources(sourcesPath);
    const previous = await readFile(catalogPath, "utf8")
      .then((data) => desktopExtensionCatalogSchema.parse(JSON.parse(data)))
      .catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      });
    const previousV2 = await readFile(catalogV2Path, "utf8")
      .then((data) => JSON.parse(data))
      .catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      });
    const existing = new Map(
      (previousV2?.extensions ?? previous?.extensions ?? []).map((entry) => [entry.id, entry]),
    );
    const counts = checkOnly ? undefined : await readDownloadCounts();
    if (!checkOnly && counts === undefined && (process.env.CODEXHOST_DESKTOP_EXTENSIONS_STATS_URL?.trim() || process.env.STATS_URL)) {
      console.warn("Download stats unavailable; preserving previous catalog download counts.");
    }
    for (const source of sources) {
      try {
        const previousEntry = existing.get(source.id);
        const count =
          counts !== undefined && Object.hasOwn(counts, source.id)
            ? counts[source.id]
            : previousEntry?.downloads;
        const { data: downloads } =
          desktopExtensionCatalogEntrySchema.shape.downloads.safeParse(count);
        const { v1Entry, v2Entry, exemptedChildProcessFiles } = await validateSource(
          source,
          previousEntry,
          starsByRepository,
          downloads,
        );
        if (v1Entry) entries.push(v1Entry);
        entriesV2.push(v2Entry);
        const notes = [];
        if (source.allowChildProcess) {
          notes.push(
            exemptedChildProcessFiles.length
              ? `allowChildProcess (${exemptedChildProcessFiles.map(inline).join(", ")})`
              : "allowChildProcess (unused)",
          );
        }
        report.push(
          `- PASS — ${inline(v2Entry.id)} ${inline(v2Entry.version)} (${v2Entry.trustTier}, ${v2Entry.targets.join("+")}) · ${inline(source.repository)} · ${inline(v2Entry.downloadUrl)} · SHA-256: ${v2Entry.sha256}${notes.length ? ` · ${notes.join(" · ")}` : ""}`,
        );
      } catch (error) {
        failed = true;
        report.push(`- FAIL — ${inline(source.id)}: ${inline(error.message)}`);
      }
    }
    const now = new Date().toISOString();
    if (!failed && !checkOnly && JSON.stringify(entries) !== JSON.stringify(previous?.extensions)) {
      const catalog = desktopExtensionCatalogSchema.parse({
        schemaVersion: 1,
        generatedAt: now,
        extensions: entries,
      });
      const temporary = new URL("catalog.json.tmp", directory);
      await writeFile(temporary, `${JSON.stringify(catalog, null, 2)}\n`);
      await rename(temporary, catalogPath);
    }
    if (
      !failed &&
      !checkOnly &&
      JSON.stringify(entriesV2) !== JSON.stringify(previousV2?.extensions)
    ) {
      const catalogV2 = {
        schemaVersion: 2,
        generatedAt: now,
        extensions: entriesV2,
      };
      const temporaryV2 = new URL("catalog.v2.json.tmp", directory);
      await writeFile(temporaryV2, `${JSON.stringify(catalogV2, null, 2)}\n`);
      await rename(temporaryV2, catalogV2Path);
    }
  } catch (error) {
    failed = true;
    report.push(`- FAIL — ${inline(error.message)}`);
  }
  const markdown = `${report.join("\n")}\n`;
  await writeFile(new URL("safety-report.md", directory), markdown);
  return { failed, markdown };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2);
  let checkOnly = false;
  let sourcesPath;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--check-only" && !checkOnly) {
      checkOnly = true;
    } else if (arg === "--sources" && sourcesPath === undefined && args[i + 1] && !args[i + 1].startsWith("--")) {
      sourcesPath = args[++i];
    } else {
      throw new Error("Usage: node validate-and-build-catalog.mjs [--check-only] [--sources <dir-or-file>]");
    }
  }
  const { failed, markdown } = await buildCatalog({ sourcesPath, checkOnly });
  if (failed) process.exitCode = 1;
  console.log(markdown);
}
