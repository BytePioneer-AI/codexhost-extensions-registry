// Product telemetry, D1-backed extension stats, and authenticated dashboard queries.

export const EXTENSION_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const VERSION_PATTERN = /^[0-9A-Za-z._+-]{1,40}$/u;
const LOCALE_PATTERN = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/u;
const COUNTRY_PATTERN = /^[A-Z]{2}$/u;

export const ALLOWED_SURFACES = new Set([
  "codex-desktop",
  "web",
  "web-desktop-shell",
  "web-mobile",
  "ssh-remote",
  "cli",
]);

export const ALLOWED_OS = new Set(["darwin", "win32", "linux"]);
export const ALLOWED_ARCH = new Set(["arm64", "x64", "ia32", "arm"]);

export const ALLOWED_HARNESSES = new Set([
  "codex",
  "claude-code",
  "antigravity",
  "pi",
  "opencode",
  "cursor-cli",
  "deepseek-harness",
  "grok",
  "omp",
  "qwen-code",
  "kiro-cli",
  "codebuddy",
  "workbuddy",
  "devin",
  "hermes",
  "qoder",
  "qoder-cn",
  "kimi-code",
  "zcode",
  "copilot",
  "custom",
]);

export const ALLOWED_REMOTE_ACCESS_CHANNELS = new Set([
  "official-relay",
  "self-hosted-relay",
  "tailscale-serve",
  "tailscale-funnel",
  "tailscale-ip",
  "lan",
  "custom-proxy",
  "remote-peer",
]);

export const ALLOWED_REMOTE_CONFIGURED = new Set([
  "official-relay",
  "self-hosted-relay",
  "tailscale-serve",
  "tailscale-funnel",
  "lan-listen",
  "custom-proxy",
  "remote-peer",
]);

export const ALLOWED_FEATURES = new Set([
  "delegation",
  "remote-peer",
  "notifications",
  "schedules",
  "no-codex-account",
]);

const MAX_HEARTBEAT_BYTES = 8 * 1024;
const MAX_EXTENSIONS_PER_HEARTBEAT = 64;
const MAX_REMOTE_COUNT_PER_DAY = 100_000;
const DAILY_DEVICE_STATE_RETENTION_DAYS = 14;
const DASHBOARD_COOKIE_HTTPS = "__Host-ch_dash_session";
const DASHBOARD_COOKIE_HTTP = "ch_dash_session";
const DASHBOARD_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export function utcDayString(nowMs = Date.now()) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function utcMonthString(day) {
  return day.slice(0, 7);
}

export function isoWeekString(day) {
  const date = new Date(`${day}T00:00:00Z`);
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date - yearStart) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

export function diffUtcDays(fromDay, toDay) {
  const fromMs = Date.parse(`${fromDay}T00:00:00Z`);
  const toMs = Date.parse(`${toDay}T00:00:00Z`);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return Number.NaN;
  return Math.round((toMs - fromMs) / 86_400_000);
}

export function addUtcDays(day, deltaDays) {
  const ms = Date.parse(`${day}T00:00:00Z`) + deltaDays * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

function sanitizeString(value, pattern, maxLen = 64) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLen) return null;
  if (pattern && !pattern.test(trimmed)) return null;
  return trimmed;
}

function sanitizeAllowedList(raw, allowedSet, maxItems = 32) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const v = item.trim();
    if (!allowedSet.has(v) || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= maxItems) break;
  }
  return out.sort();
}

function sanitizeExtensionList(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const v = item.trim();
    if (v.length > 64 || !EXTENSION_ID_PATTERN.test(v) || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= MAX_EXTENSIONS_PER_HEARTBEAT) break;
  }
  return out.sort();
}

function sanitizeRemoteCounts(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = Object.create(null);
  for (const [channel, count] of Object.entries(raw)) {
    if (!ALLOWED_REMOTE_ACCESS_CHANNELS.has(channel)) continue;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count <= 0) continue;
    out[channel] = Math.min(count, MAX_REMOTE_COUNT_PER_DAY);
  }
  return out;
}

export function normalizeLocale(raw) {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().replaceAll("_", "-").split(".")[0];
  if (!LOCALE_PATTERN.test(cleaned)) return null;
  const [lang, region] = cleaned.split("-");
  if (!lang) return null;
  return region ? `${lang.toLowerCase()}-${region.toUpperCase()}` : lang.toLowerCase();
}

export function parseHeartbeatPayload(body, cfCountry) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Invalid JSON object" };
  }
  const installId = sanitizeString(body.installId, UUID_V4_PATTERN, 36)?.toLowerCase();
  if (!installId) {
    return { ok: false, error: "Invalid installId" };
  }

  const appVersion = sanitizeString(body.appVersion, VERSION_PATTERN, 40);
  const codexDesktopVersion = sanitizeString(body.codexDesktopVersion, VERSION_PATTERN, 40);
  const os = typeof body.os === "string" && ALLOWED_OS.has(body.os) ? body.os : null;
  const arch = typeof body.arch === "string" && ALLOWED_ARCH.has(body.arch) ? body.arch : null;
  const locale = normalizeLocale(body.locale);
  const country =
    typeof cfCountry === "string" && COUNTRY_PATTERN.test(cfCountry.toUpperCase())
      ? cfCountry.toUpperCase()
      : null;

  const surfaces = sanitizeAllowedList(body.surfaces, ALLOWED_SURFACES, 12);
  const harnesses = sanitizeAllowedList(body.harnesses, ALLOWED_HARNESSES, 32);
  const extensions = sanitizeExtensionList(body.extensions);
  const remoteCounts = sanitizeRemoteCounts(body.remoteAccessCounts);
  const remoteAccessSet = new Set(
    sanitizeAllowedList(body.remoteAccess, ALLOWED_REMOTE_ACCESS_CHANNELS, 12),
  );
  for (const channel of Object.keys(remoteCounts)) {
    remoteAccessSet.add(channel);
  }
  const remoteAccess = [...remoteAccessSet].sort();
  const remoteConfigured = sanitizeAllowedList(
    body.remoteConfigured,
    ALLOWED_REMOTE_CONFIGURED,
    12,
  );
  const features = sanitizeAllowedList(body.features, ALLOWED_FEATURES, 16);

  return {
    ok: true,
    data: {
      installId,
      appVersion,
      codexDesktopVersion,
      os,
      arch,
      locale,
      country,
      surfaces,
      harnesses,
      extensions,
      remoteAccess,
      remoteConfigured,
      features,
      remoteCounts,
    },
  };
}

export async function readBoundedJson(request, maxBytes = MAX_HEARTBEAT_BYTES) {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return { ok: false, status: 413, error: "Payload too large" };
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    return { ok: false, status: 413, error: "Payload too large" };
  }
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, error: "Invalid JSON" };
  }
}

function safeParseArray(text) {
  if (typeof text !== "string") return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function safeParseCounts(text) {
  if (typeof text !== "string") return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out = Object.create(null);
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function incDailyStmt(db, day, metric, dim, delta = 1) {
  return db
    .prepare(
      `INSERT INTO daily_metrics (day, metric, dim, count) VALUES (?, ?, ?, ?)
       ON CONFLICT(day, metric, dim) DO UPDATE SET count = MAX(0, count + excluded.count)`,
    )
    .bind(day, metric, dim, delta);
}

function incPeriodStmt(db, periodType, periodKey, metric, dim, delta = 1) {
  return db
    .prepare(
      `INSERT INTO period_metrics (period_type, period_key, metric, dim, count) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(period_type, period_key, metric, dim) DO UPDATE SET count = MAX(0, count + excluded.count)`,
    )
    .bind(periodType, periodKey, metric, dim, delta);
}

export async function recordHeartbeat(db, heartbeat, nowMs = Date.now()) {
  const day = utcDayString(nowMs);
  const week = isoWeekString(day);
  const month = utcMonthString(day);
  const nowIso = new Date(nowMs).toISOString();

  const [device, prevState] = await Promise.all([
    db
      .prepare(
        `SELECT install_id, first_seen_day, last_seen_day, last_seen_week, last_seen_month,
                retained_d1, retained_d7, retained_w1
         FROM devices WHERE install_id = ?`,
      )
      .bind(heartbeat.installId)
      .first(),
    db
      .prepare(
        `SELECT app_version, codex_desktop_version, os, arch, locale, country,
                surfaces_json, harnesses_json, extensions_json,
                remote_access_json, remote_configured_json, features_json, remote_counts_json
         FROM daily_device_state WHERE day = ? AND install_id = ?`,
      )
      .bind(day, heartbeat.installId)
      .first(),
  ]);

  const statements = [];
  const isNewDevice = !device;
  const isFirstToday = !prevState;

  let nextRetD1 = device ? Number(device.retained_d1) || 0 : 0;
  let nextRetD7 = device ? Number(device.retained_d7) || 0 : 0;
  let nextRetW1 = device ? Number(device.retained_w1) || 0 : 0;

  if (isNewDevice) {
    statements.push(incDailyStmt(db, day, "new_users", "_all", 1));
    statements.push(incPeriodStmt(db, "lifetime", "_all", "total_devices", "_all", 1));
    statements.push(incPeriodStmt(db, "week", week, "wau", "_all", 1));
    statements.push(incPeriodStmt(db, "month", month, "mau", "_all", 1));
  } else {
    if (device.last_seen_week !== week) {
      statements.push(incPeriodStmt(db, "week", week, "wau", "_all", 1));
    }
    if (device.last_seen_month !== month) {
      statements.push(incPeriodStmt(db, "month", month, "mau", "_all", 1));
    }
    const ageDays = diffUtcDays(device.first_seen_day, day);
    if (ageDays === 1 && !nextRetD1) {
      nextRetD1 = 1;
      statements.push(incDailyStmt(db, device.first_seen_day, "ret_d1", "_all", 1));
    }
    if (ageDays === 7 && !nextRetD7) {
      nextRetD7 = 1;
      statements.push(incDailyStmt(db, device.first_seen_day, "ret_d7", "_all", 1));
    }
    if (ageDays >= 1 && ageDays <= 7 && !nextRetW1) {
      nextRetW1 = 1;
      statements.push(incDailyStmt(db, device.first_seen_day, "ret_w1", "_all", 1));
    }
  }

  if (isFirstToday) {
    statements.push(incDailyStmt(db, day, "dau", "_all", 1));
  }

  // Scalar daily dimensions: transition cleanly if a value becomes known or updates mid-day.
  const scalarPairs = [
    ["app_version", prevState?.app_version ?? null, heartbeat.appVersion ?? prevState?.app_version ?? null],
    [
      "codex_version",
      prevState?.codex_desktop_version ?? null,
      heartbeat.codexDesktopVersion ?? prevState?.codex_desktop_version ?? null,
    ],
    ["os", prevState?.os ?? null, heartbeat.os ?? prevState?.os ?? null],
    ["locale", prevState?.locale ?? null, heartbeat.locale ?? prevState?.locale ?? null],
    ["country", prevState?.country ?? null, heartbeat.country ?? prevState?.country ?? null],
  ];

  const prevOsArch = prevState?.os && prevState?.arch ? `${prevState.os}-${prevState.arch}` : null;
  const nextOs = heartbeat.os ?? prevState?.os ?? null;
  const nextArch = heartbeat.arch ?? prevState?.arch ?? null;
  const nextOsArch = nextOs && nextArch ? `${nextOs}-${nextArch}` : null;
  scalarPairs.push(["os_arch", prevOsArch, nextOsArch]);

  for (const [metric, prevVal, nextVal] of scalarPairs) {
    if (prevVal === nextVal) continue;
    if (prevVal) statements.push(incDailyStmt(db, day, metric, prevVal, -1));
    if (nextVal) statements.push(incDailyStmt(db, day, metric, nextVal, 1));
  }

  // Set-valued daily dimensions: union with today's already-counted set, incrementing only new dims.
  const mergeSet = (prevJson, incoming, metric, trackAny = false) => {
    const prevSet = new Set(safeParseArray(prevJson));
    const hadAny = prevSet.size > 0;
    for (const item of incoming) {
      if (!prevSet.has(item)) {
        prevSet.add(item);
        statements.push(incDailyStmt(db, day, metric, item, 1));
      }
    }
    if (trackAny && !hadAny && prevSet.size > 0) {
      statements.push(incDailyStmt(db, day, metric, "_any", 1));
    }
    return [...prevSet].sort();
  };

  const nextSurfaces = mergeSet(prevState?.surfaces_json, heartbeat.surfaces, "surface");
  const nextHarnesses = mergeSet(prevState?.harnesses_json, heartbeat.harnesses, "harness");
  const nextExtensions = mergeSet(
    prevState?.extensions_json,
    heartbeat.extensions,
    "extension_active",
  );
  const nextRemoteAccess = mergeSet(
    prevState?.remote_access_json,
    heartbeat.remoteAccess,
    "remote_access",
    true,
  );
  const nextRemoteConfigured = mergeSet(
    prevState?.remote_configured_json,
    heartbeat.remoteConfigured,
    "remote_configured",
    true,
  );
  const nextFeatures = mergeSet(prevState?.features_json, heartbeat.features, "feature");

  // Monotonic daily remote access session volume per channel (delta against today's high-water mark).
  const prevCounts = safeParseCounts(prevState?.remote_counts_json);
  const nextCounts = { ...prevCounts };
  let totalDelta = 0;
  for (const [channel, reportedCount] of Object.entries(heartbeat.remoteCounts)) {
    const prevCount = prevCounts[channel] ?? 0;
    if (reportedCount > prevCount) {
      const delta = reportedCount - prevCount;
      nextCounts[channel] = reportedCount;
      totalDelta += delta;
      statements.push(incDailyStmt(db, day, "remote_access_sessions", channel, delta));
    }
  }
  if (totalDelta > 0) {
    statements.push(incDailyStmt(db, day, "remote_access_sessions", "_all", totalDelta));
  }

  const nextAppVersion = heartbeat.appVersion ?? prevState?.app_version ?? null;
  const nextCodexVersion =
    heartbeat.codexDesktopVersion ?? prevState?.codex_desktop_version ?? null;
  const nextLocale = heartbeat.locale ?? prevState?.locale ?? null;
  const nextCountry = heartbeat.country ?? prevState?.country ?? null;

  statements.push(
    db
      .prepare(
        `INSERT INTO devices (
           install_id, first_seen_day, last_seen_day, last_seen_week, last_seen_month,
           retained_d1, retained_d7, retained_w1,
           app_version, codex_desktop_version, os, arch, locale, country
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(install_id) DO UPDATE SET
           last_seen_day = excluded.last_seen_day,
           last_seen_week = excluded.last_seen_week,
           last_seen_month = excluded.last_seen_month,
           retained_d1 = excluded.retained_d1,
           retained_d7 = excluded.retained_d7,
           retained_w1 = excluded.retained_w1,
           app_version = COALESCE(excluded.app_version, devices.app_version),
           codex_desktop_version = COALESCE(excluded.codex_desktop_version, devices.codex_desktop_version),
           os = COALESCE(excluded.os, devices.os),
           arch = COALESCE(excluded.arch, devices.arch),
           locale = COALESCE(excluded.locale, devices.locale),
           country = COALESCE(excluded.country, devices.country)`,
      )
      .bind(
        heartbeat.installId,
        device?.first_seen_day ?? day,
        day,
        week,
        month,
        nextRetD1,
        nextRetD7,
        nextRetW1,
        nextAppVersion,
        nextCodexVersion,
        nextOs,
        nextArch,
        nextLocale,
        nextCountry,
      ),
  );

  statements.push(
    db
      .prepare(
        `INSERT INTO daily_device_state (
           day, install_id, app_version, codex_desktop_version, os, arch, locale, country,
           surfaces_json, harnesses_json, extensions_json,
           remote_access_json, remote_configured_json, features_json, remote_counts_json,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(day, install_id) DO UPDATE SET
           app_version = excluded.app_version,
           codex_desktop_version = excluded.codex_desktop_version,
           os = excluded.os,
           arch = excluded.arch,
           locale = excluded.locale,
           country = excluded.country,
           surfaces_json = excluded.surfaces_json,
           harnesses_json = excluded.harnesses_json,
           extensions_json = excluded.extensions_json,
           remote_access_json = excluded.remote_access_json,
           remote_configured_json = excluded.remote_configured_json,
           features_json = excluded.features_json,
           remote_counts_json = excluded.remote_counts_json,
           updated_at = excluded.updated_at`,
      )
      .bind(
        day,
        heartbeat.installId,
        nextAppVersion,
        nextCodexVersion,
        nextOs,
        nextArch,
        nextLocale,
        nextCountry,
        JSON.stringify(nextSurfaces),
        JSON.stringify(nextHarnesses),
        JSON.stringify(nextExtensions),
        JSON.stringify(nextRemoteAccess),
        JSON.stringify(nextRemoteConfigured),
        JSON.stringify(nextFeatures),
        JSON.stringify(nextCounts),
        nowIso,
      ),
  );

  await db.batch(statements);
  return { ok: true, day, newDevice: isNewDevice };
}

export async function recordExtensionInstallD1(db, id, nowMs = Date.now()) {
  const day = utcDayString(nowMs);
  const nowIso = new Date(nowMs).toISOString();
  const [, , row] = await db.batch([
    db
      .prepare(
        `INSERT INTO extension_downloads (id, downloads, updated_at) VALUES (?, 1, ?)
         ON CONFLICT(id) DO UPDATE SET downloads = downloads + 1, updated_at = excluded.updated_at`,
      )
      .bind(id, nowIso),
    db
      .prepare(
        `INSERT INTO extension_downloads_daily (day, id, downloads) VALUES (?, ?, 1)
         ON CONFLICT(day, id) DO UPDATE SET downloads = downloads + 1`,
      )
      .bind(day, id),
    db.prepare(`SELECT downloads FROM extension_downloads WHERE id = ?`).bind(id),
  ]);
  const downloads = Number(row?.results?.[0]?.downloads ?? 1);
  return { id, downloads };
}

export async function readExtensionStatsD1(db, nowMs = Date.now()) {
  const result = await db
    .prepare(`SELECT id, downloads FROM extension_downloads ORDER BY id ASC`)
    .all();
  const downloads = Object.create(null);
  for (const row of result?.results ?? []) {
    if (
      typeof row?.id === "string" &&
      EXTENSION_ID_PATTERN.test(row.id) &&
      typeof row.downloads === "number" &&
      Number.isSafeInteger(row.downloads) &&
      row.downloads >= 0
    ) {
      downloads[row.id] = row.downloads;
    }
  }
  return {
    generatedAt: new Date(nowMs).toISOString(),
    downloads,
  };
}

export async function readWorkerMetaD1(db, key) {
  if (!db) return null;
  try {
    const row = await db.prepare(`SELECT value FROM worker_meta WHERE key = ?`).bind(key).first();
    if (typeof row?.value !== "string") return null;
    const parsed = JSON.parse(row.value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeWorkerMetaD1(db, key, value, nowMs = Date.now()) {
  if (!db) return;
  try {
    await db
      .prepare(
        `INSERT INTO worker_meta (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(key, JSON.stringify(value), new Date(nowMs).toISOString())
      .run();
  } catch {
    // Preserve availability on transient metadata write failures.
  }
}

export async function pruneOldDailyDeviceState(db, nowMs = Date.now()) {
  if (!db) return;
  const today = utcDayString(nowMs);
  const lastPruned = await readWorkerMetaD1(db, "last-prune-day");
  if (lastPruned?.day === today) return;
  const cutoff = addUtcDays(today, -DAILY_DEVICE_STATE_RETENTION_DAYS);
  try {
    await db.batch([
      db.prepare(`DELETE FROM daily_device_state WHERE day < ?`).bind(cutoff),
      db
        .prepare(
          `INSERT INTO worker_meta (key, value, updated_at) VALUES ('last-prune-day', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .bind(JSON.stringify({ day: today }), new Date(nowMs).toISOString()),
    ]);
  } catch {
    // Non-critical housekeeping; retry next scheduled tick.
  }
}

function buildDaySeries(startDay, days) {
  const list = [];
  for (let i = 0; i < days; i += 1) {
    list.push(addUtcDays(startDay, i));
  }
  return list;
}

function sortBreakdown(map) {
  return [...map.entries()]
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([dim, count]) => ({ dim, count }));
}

export async function queryDashboardOverview(db, requestedDays = 30, nowMs = Date.now()) {
  const days = Math.min(90, Math.max(1, Number.isFinite(requestedDays) ? Math.floor(requestedDays) : 30));
  const today = utcDayString(nowMs);
  const startDay = addUtcDays(today, -(days - 1));
  const currentWeek = isoWeekString(today);
  const currentMonth = utcMonthString(today);

  const [dailyMetricsRes, periodRes, extTotalRes, extDailyRes, syncMeta] = await Promise.all([
    db
      .prepare(`SELECT day, metric, dim, count FROM daily_metrics WHERE day >= ? AND day <= ?`)
      .bind(startDay, today)
      .all(),
    db
      .prepare(
        `SELECT period_type, period_key, metric, dim, count FROM period_metrics
         WHERE period_type = 'lifetime'
            OR (period_type = 'week' AND period_key >= ?)
            OR (period_type = 'month' AND period_key >= ?)`,
      )
      .bind(isoWeekString(addUtcDays(today, -84)), utcMonthString(addUtcDays(today, -365)))
      .all(),
    db
      .prepare(`SELECT id, downloads, updated_at FROM extension_downloads ORDER BY downloads DESC, id ASC`)
      .all(),
    db
      .prepare(`SELECT day, id, downloads FROM extension_downloads_daily WHERE day >= ? AND day <= ?`)
      .bind(startDay, today)
      .all(),
    readWorkerMetaD1(db, "last-sync-check"),
  ]);

  const dayList = buildDaySeries(startDay, days);
  const dayIndex = new Map(dayList.map((d, idx) => [d, idx]));
  const series = dayList.map((day) => ({
    day,
    dau: 0,
    newUsers: 0,
    retD1: 0,
    retD7: 0,
    retW1: 0,
    remoteUsers: 0,
    remoteSessions: 0,
    officialRelayUsers: 0,
    selfHostedRelayUsers: 0,
    officialRelaySessions: 0,
    selfHostedRelaySessions: 0,
    extensionInstalls: 0,
  }));

  const metricTotals = new Map();
  const metricLatestDay = new Map();
  const addAgg = (store, metric, dim, count) => {
    let map = store.get(metric);
    if (!map) {
      map = new Map();
      store.set(metric, map);
    }
    map.set(dim, (map.get(dim) ?? 0) + count);
  };

  for (const row of dailyMetricsRes?.results ?? []) {
    const idx = dayIndex.get(row.day);
    const count = Number(row.count) || 0;
    if (count <= 0) continue;

    if (idx !== undefined) {
      const point = series[idx];
      if (row.metric === "dau" && row.dim === "_all") point.dau = count;
      else if (row.metric === "new_users" && row.dim === "_all") point.newUsers = count;
      else if (row.metric === "ret_d1" && row.dim === "_all") point.retD1 = count;
      else if (row.metric === "ret_d7" && row.dim === "_all") point.retD7 = count;
      else if (row.metric === "ret_w1" && row.dim === "_all") point.retW1 = count;
      else if (row.metric === "remote_access" && row.dim === "_any") point.remoteUsers = count;
      else if (row.metric === "remote_access" && row.dim === "official-relay")
        point.officialRelayUsers = count;
      else if (row.metric === "remote_access" && row.dim === "self-hosted-relay")
        point.selfHostedRelayUsers = count;
      else if (row.metric === "remote_access_sessions" && row.dim === "_all")
        point.remoteSessions = count;
      else if (row.metric === "remote_access_sessions" && row.dim === "official-relay")
        point.officialRelaySessions = count;
      else if (row.metric === "remote_access_sessions" && row.dim === "self-hosted-relay")
        point.selfHostedRelaySessions = count;
    }

    if (row.dim !== "_all" && row.dim !== "_any") {
      addAgg(metricTotals, row.metric, row.dim, count);
      if (row.day === today) {
        addAgg(metricLatestDay, row.metric, row.dim, count);
      }
    }
  }

  // Extension daily downloads in range.
  const extRangeDownloads = new Map();
  for (const row of extDailyRes?.results ?? []) {
    const count = Number(row.downloads) || 0;
    if (count <= 0) continue;
    const idx = dayIndex.get(row.day);
    if (idx !== undefined) series[idx].extensionInstalls += count;
    extRangeDownloads.set(row.id, (extRangeDownloads.get(row.id) ?? 0) + count);
  }

  let totalDevices = 0;
  let wau = 0;
  let mau = 0;
  const weeklySeries = [];
  const monthlySeries = [];
  for (const row of periodRes?.results ?? []) {
    const count = Number(row.count) || 0;
    if (row.period_type === "lifetime" && row.metric === "total_devices") {
      totalDevices = count;
    } else if (row.period_type === "week" && row.metric === "wau") {
      weeklySeries.push({ period: row.period_key, count });
      if (row.period_key === currentWeek) wau = count;
    } else if (row.period_type === "month" && row.metric === "mau") {
      monthlySeries.push({ period: row.period_key, count });
      if (row.period_key === currentMonth) mau = count;
    }
  }
  weeklySeries.sort((a, b) => a.period.localeCompare(b.period));
  monthlySeries.sort((a, b) => a.period.localeCompare(b.period));

  // Retention rates over eligible cohorts in window.
  let d1Base = 0;
  let d1Ret = 0;
  let d7Base = 0;
  let d7Ret = 0;
  let w1Ret = 0;
  for (const p of series) {
    const age = diffUtcDays(p.day, today);
    if (age >= 1) {
      d1Base += p.newUsers;
      d1Ret += p.retD1;
    }
    if (age >= 7) {
      d7Base += p.newUsers;
      d7Ret += p.retD7;
      w1Ret += p.retW1;
    }
  }

  const activeExtToday = metricLatestDay.get("extension_active") ?? new Map();
  const activeExtRange = metricTotals.get("extension_active") ?? new Map();
  let totalExtensionDownloads = 0;
  const extensions = (extTotalRes?.results ?? []).map((row) => {
    const total = Number(row.downloads) || 0;
    totalExtensionDownloads += total;
    return {
      id: row.id,
      downloads: total,
      rangeDownloads: extRangeDownloads.get(row.id) ?? 0,
      activeDevicesToday: activeExtToday.get(row.id) ?? 0,
      activeDeviceDaysRange: activeExtRange.get(row.id) ?? 0,
      updatedAt: row.updated_at,
    };
  });

  const todayPoint = series[series.length - 1];
  const breakdownFor = (metric) => ({
    today: sortBreakdown(metricLatestDay.get(metric) ?? new Map()),
    range: sortBreakdown(metricTotals.get(metric) ?? new Map()),
  });

  return {
    generatedAt: new Date(nowMs).toISOString(),
    today,
    days,
    storage: "d1",
    summary: {
      dauToday: todayPoint.dau,
      newUsersToday: todayPoint.newUsers,
      wau,
      mau,
      totalDevices,
      remoteUsersToday: todayPoint.remoteUsers,
      remoteSessionsToday: todayPoint.remoteSessions,
      totalExtensionDownloads,
      retention: {
        d1Rate: d1Base > 0 ? Number((d1Ret / d1Base).toFixed(4)) : null,
        d1Returned: d1Ret,
        d1Cohort: d1Base,
        d7Rate: d7Base > 0 ? Number((d7Ret / d7Base).toFixed(4)) : null,
        d7Returned: d7Ret,
        d7Cohort: d7Base,
        w1Rate: d7Base > 0 ? Number((w1Ret / d7Base).toFixed(4)) : null,
        w1Returned: w1Ret,
      },
    },
    series,
    weeklySeries,
    monthlySeries,
    breakdowns: {
      surfaces: breakdownFor("surface"),
      harnesses: breakdownFor("harness"),
      remoteAccess: breakdownFor("remote_access"),
      remoteAccessSessions: breakdownFor("remote_access_sessions"),
      remoteConfigured: breakdownFor("remote_configured"),
      features: breakdownFor("feature"),
      appVersions: breakdownFor("app_version"),
      codexVersions: breakdownFor("codex_version"),
      os: breakdownFor("os"),
      osArch: breakdownFor("os_arch"),
      countries: breakdownFor("country"),
      locales: breakdownFor("locale"),
    },
    extensions,
    sync: syncMeta ?? null,
  };
}

// --- Dashboard authentication (HMAC-SHA256 signed session cookie + Bearer token) ---

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualString(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  const maxLen = Math.max(aBytes.length, bBytes.length, 1);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < maxLen; i += 1) {
    diff |= (aBytes[i % aBytes.length] ?? 0) ^ (bBytes[i % bBytes.length] ?? 0);
  }
  return diff === 0;
}

async function signSessionPayload(secret, payload) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return toHex(sig);
}

export async function createDashboardSessionCookie(secret, isHttps, nowMs = Date.now()) {
  const exp = Math.floor(nowMs / 1000) + DASHBOARD_SESSION_TTL_SECONDS;
  const payload = `v1.${exp}`;
  const sig = await signSessionPayload(secret, payload);
  const name = isHttps ? DASHBOARD_COOKIE_HTTPS : DASHBOARD_COOKIE_HTTP;
  const secureAttr = isHttps ? "; Secure" : "";
  return `${name}=${payload}.${sig}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${DASHBOARD_SESSION_TTL_SECONDS}${secureAttr}`;
}

export function clearDashboardSessionCookie(isHttps) {
  const name = isHttps ? DASHBOARD_COOKIE_HTTPS : DASHBOARD_COOKIE_HTTP;
  const secureAttr = isHttps ? "; Secure" : "";
  return `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureAttr}`;
}

function readCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key === name) return part.slice(idx + 1).trim();
  }
  return null;
}

export async function isDashboardAuthenticated(request, secret, nowMs = Date.now()) {
  if (!secret || typeof secret !== "string") return false;
  const auth = request.headers.get("authorization") || "";
  if (auth.startsWith("Bearer ")) {
    const candidate = auth.slice("Bearer ".length).trim();
    if (timingSafeEqualString(candidate, secret)) return true;
  }
  const url = new URL(request.url);
  const isHttps = url.protocol === "https:";
  const cookieVal = readCookie(request, isHttps ? DASHBOARD_COOKIE_HTTPS : DASHBOARD_COOKIE_HTTP);
  if (!cookieVal) return false;
  const parts = cookieVal.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const exp = Number(parts[1]);
  if (!Number.isSafeInteger(exp) || exp < Math.floor(nowMs / 1000)) return false;
  const expectedSig = await signSessionPayload(secret, `${parts[0]}.${parts[1]}`);
  return timingSafeEqualString(parts[2], expectedSig);
}

export function verifyDashboardToken(candidate, secret) {
  if (!secret || typeof secret !== "string" || typeof candidate !== "string") return false;
  return timingSafeEqualString(candidate.trim(), secret.trim());
}
