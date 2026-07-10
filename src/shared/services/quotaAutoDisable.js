// Auto-disable depleted connections scheduler: disables connections when quota ≤ 2%
import "open-sse/index.js";

import { getSettings, getProviderConnections, updateProviderConnection } from "@/lib/localDb";
import { getClaudeUsage } from "open-sse/services/usage/claude.js";
import { getCodexUsage } from "open-sse/services/usage/codex.js";
import { getKiroUsage } from "open-sse/services/usage/kiro.js";
import { getAntigravityUsage } from "open-sse/services/usage/google.js";
import { refreshAndUpdateCredentials } from "@/app/api/usage/[connectionId]/route.js";

const DEPLETED_THRESHOLD_PERCENT = 2;
const CHECK_INTERVAL_MS = 3 * 60 * 1000; // 5 minutes
const CONCURRENCY_LIMIT = 10; // Process up to 10 connections in parallel
const CONNECTION_TIMEOUT_MS = 30000; // 30 seconds per connection

// Server-side in-memory quota cache (replaces localStorage-based getQuotaCache
// which returns {} on the server because there is no `window`).
const serverQuotaCache = new Map();

function setServerQuotaCache(connectionId, quotas) {
  serverQuotaCache.set(connectionId, { quotas, cachedAt: new Date().toISOString() });
}

function getServerQuotaCache(connectionId) {
  return serverQuotaCache.get(connectionId) || null;
}

// Usage fetcher adapters — each handler expects specific positional args,
// NOT the whole connection object.
const usageHandlers = {
  claude: (conn) => getClaudeUsage(conn.accessToken),
  codex: (conn) => getCodexUsage(conn.accessToken),
  kiro: (conn) => getKiroUsage(conn.accessToken, conn.providerSpecificData),
  antigravity: (conn) => getAntigravityUsage(conn.accessToken, conn.providerSpecificData),
};

// Survive Next.js hot reload and keep one scheduler per server process
const g = (global.__quotaAutoDisable ??= {
  interval: null,
  running: false,
  lastCheckAt: null,
});

function toFiniteNumber(value, fallback = null) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function calculatePercentage(used, total) {
  const usedNum = toFiniteNumber(used, 0);
  const totalNum = toFiniteNumber(total);
  if (totalNum === null || totalNum <= 0) return 100;
  return Math.max(0, Math.min(100, ((totalNum - usedNum) / totalNum) * 100));
}

function isQuotaDepleted(quota) {
  if (!quota) return false;
  if (quota.unlimited === true) return false;

  const remaining = toFiniteNumber(quota.remaining);
  if (remaining !== null) return remaining <= 0;

  const used = toFiniteNumber(quota.used);
  const total = toFiniteNumber(quota.total);
  if (total === null || total <= 0) return false;

  const percentageRemaining = calculatePercentage(used, total);
  return percentageRemaining <= DEPLETED_THRESHOLD_PERCENT;
}

function hasAnyDepletedQuota(quotas) {
  if (!quotas || typeof quotas !== "object") return false;
  return Object.values(quotas).some((quota) => isQuotaDepleted(quota));
}

async function fetchQuotaForConnection(connection) {
  try {
    const handler = usageHandlers[connection.provider];
    if (!handler) {
      console.log(`[quotaAutoDisable] No usage handler for provider: ${connection.provider}`);
      return null;
    }

    // Try to refresh credentials if needed (OAuth tokens might expire)
    try {
      await refreshAndUpdateCredentials(connection, false);
    } catch (refreshError) {
      console.warn(
        `[quotaAutoDisable] Failed to refresh credentials for ${connection.provider} (${connection.id}): ${refreshError.message}`
      );
      // Continue with existing credentials or cached data
    }

    // Try to fetch fresh usage data
    try {
      const usageData = await handler(connection);
      const quotas = usageData?.quotas || usageData;

      // Cache successful result server-side for fallback
      if (quotas && Object.keys(quotas).length > 0) {
        setServerQuotaCache(connection.id, quotas);
      }

      return quotas;
    } catch (fetchError) {
      console.warn(
        `[quotaAutoDisable] Failed to fetch fresh quota for ${connection.provider} (${connection.id}): ${fetchError.message}`
      );

      // Fall back to server-side in-memory cache
      const cachedData = getServerQuotaCache(connection.id);

      if (cachedData?.quotas) {
        const cacheAge = cachedData.cachedAt
          ? Math.round((Date.now() - new Date(cachedData.cachedAt).getTime()) / 1000 / 60)
          : 'unknown';
        console.log(
          `[quotaAutoDisable] Using cached quota for ${connection.provider} (${connection.id}), age: ${cacheAge} minutes`
        );
        return cachedData.quotas;
      }

      console.log(`[quotaAutoDisable] No cached quota available for ${connection.provider} (${connection.id})`);
      return null;
    }
  } catch (error) {
    console.error(
      `[quotaAutoDisable] Unexpected error for ${connection.provider} (${connection.id}):`,
      error.message
    );
    return null;
  }
}

/**
 * Process connections with concurrency limit and timeout
 */
async function processConnectionsBatched(connections, handler, { concurrency, timeout }) {
  const results = [];
  const executing = [];

  for (let i = 0; i < connections.length; i++) {
    const connection = connections[i];

    const promise = (async () => {
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Connection check timeout')), timeout)
      );

      try {
        const result = await Promise.race([
          handler(connection),
          timeoutPromise
        ]);
        return { connection, result, error: null };
      } catch (error) {
        return { connection, result: null, error };
      }
    })();

    results.push(promise);
    executing.push(promise);

    if (executing.length >= concurrency) {
      await Promise.race(executing);
      executing.splice(
        executing.findIndex(p => p === promise),
        1
      );
    }
  }

  return Promise.all(results);
}

async function checkAndDisableDepletedConnections() {
  if (g.running) {
    console.log("[quotaAutoDisable] Check already running, skipping");
    return;
  }

  g.running = true;
  g.lastCheckAt = new Date().toISOString();

  try {
    // Check if feature is enabled
    const settings = await getSettings();
    const autoTurnOffConfig = settings?.autoTurnOffDepleted;
    if (!autoTurnOffConfig?.enabled) {
      console.log("[quotaAutoDisable] Feature is disabled, skipping check");
      return;
    }

    console.log("[quotaAutoDisable] Starting depleted connections check");

    // Get all active connections
    const connections = await getProviderConnections();
    const activeConnections = connections.filter(
      (conn) => conn.isActive !== false && usageHandlers[conn.provider]
    );

    if (activeConnections.length === 0) {
      console.log("[quotaAutoDisable] No active connections to check");
      return;
    }

    console.log(`[quotaAutoDisable] Checking ${activeConnections.length} active connections`);

    let disabledCount = 0;
    let processedCount = 0;

    // Process connections in parallel with concurrency limit
    const checkConnection = async (connection) => {
      const quotas = await fetchQuotaForConnection(connection);
      if (!quotas) return null;

      const isDepleted = hasAnyDepletedQuota(quotas);

      return { connection, quotas, isDepleted };
    };

    const results = await processConnectionsBatched(
      activeConnections,
      checkConnection,
      {
        concurrency: CONCURRENCY_LIMIT,
        timeout: CONNECTION_TIMEOUT_MS
      }
    );

    // Process results and disable depleted connections
    for (const { connection, result, error } of results) {
      processedCount++;

      if (error) {
        if (error.message === 'Connection check timeout') {
          console.warn(
            `[quotaAutoDisable] Timeout checking ${connection.provider} (${connection.id})`
          );
        } else {
          console.error(
            `[quotaAutoDisable] Error processing ${connection.id}:`,
            error.message
          );
        }
        continue;
      }

      if (!result) continue;

      if (result.isDepleted) {
        console.log(
          `[quotaAutoDisable] Disabling depleted connection: ${connection.provider} (${connection.id})`
        );

        try {
          await updateProviderConnection(connection.id, { isActive: false });
          disabledCount++;
        } catch (updateError) {
          console.error(
            `[quotaAutoDisable] Failed to disable ${connection.id}:`,
            updateError.message
          );
        }
      }

      // Log progress every 10 connections
      if (processedCount % 10 === 0) {
        console.log(
          `[quotaAutoDisable] Progress: ${processedCount}/${activeConnections.length} checked, ${disabledCount} disabled`
        );
      }
    }

    if (disabledCount > 0) {
      console.log(`[quotaAutoDisable] Disabled ${disabledCount} depleted connection(s)`);
    } else {
      console.log("[quotaAutoDisable] No depleted connections found");
    }
  } catch (error) {
    console.error("[quotaAutoDisable] Error in check cycle:", error);
  } finally {
    g.running = false;
  }
}

export function startQuotaAutoDisable() {
  if (g.interval) {
    console.log("[quotaAutoDisable] Scheduler already running");
    return;
  }

  console.log(`[quotaAutoDisable] Starting scheduler (interval: ${CHECK_INTERVAL_MS / 1000}s)`);

  // Run immediately on start
  checkAndDisableDepletedConnections();

  // Then schedule periodic checks
  g.interval = setInterval(() => {
    checkAndDisableDepletedConnections();
  }, CHECK_INTERVAL_MS);
}

export function stopQuotaAutoDisable() {
  if (g.interval) {
    clearInterval(g.interval);
    g.interval = null;
    console.log("[quotaAutoDisable] Scheduler stopped");
  }
}

export function getQuotaAutoDisableStatus() {
  return {
    running: Boolean(g.interval),
    checking: g.running,
    lastCheckAt: g.lastCheckAt,
    intervalMs: CHECK_INTERVAL_MS,
  };
}
