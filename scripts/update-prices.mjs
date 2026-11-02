import { pathToFileURL } from 'node:url';

const PROVIDERS = ['rakuten', 'yahoo'];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export function latestScheduledSlot(time) {
  const date = new Date(time), hour = date.getUTCHours();
  date.setUTCHours(hour >= 18 ? 18 : hour >= 6 ? 6 : 18, 0, 0, 0);
  if (hour < 6) date.setUTCDate(date.getUTCDate() - 1);
  return date.getTime();
}

function alreadyComplete(status, currentTime, since) {
  return Number.isInteger(status.models) && status.models > 0 && PROVIDERS.every(provider => {
    const value = status.providers?.[provider], job = value?.job;
    const age = currentTime - Date.parse(value?.oldestCheckedAt);
    return job?.status === 'completed' && job.failed === 0 && job.completed === status.models && job.modelCount === status.models && value.current === status.models && Number.isFinite(age) && age >= 0 && age < 24 * 3600_000 && Date.parse(job.finishedAt) >= since;
  });
}

export async function updatePrices({
  key = process.env.RETAIL_AUTOMATION_KEY,
  site = process.env.SITE_URL || 'https://oysteryakiniku.com',
  fetcher = fetch, delay = pause, now = Date.now,
  log = value => console.log(JSON.stringify(value)),
  maxDurationMs = 210 * 60_000,
  completedSince, verifyOnly = false,
} = {}) {
  if (!/^[a-f0-9]{64}$/.test(key || '')) throw Error('missing_or_invalid_update_credential');
  const origin = new URL(site);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw Error('invalid_site_origin');
  const endpoint = new URL('/api/retail/automation', origin);
  const deadline = now() + maxDurationMs;

  async function request(body) {
    for (let attempt = 0; attempt < 6; attempt++) {
      if (now() >= deadline) throw Error('update_deadline_exceeded');
      let response;
      try {
        response = await fetcher(endpoint, {
          method: body ? 'POST' : 'GET', redirect: 'error',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(Math.min(110_000, deadline - now())),
        });
      } catch {
        if (attempt === 5) throw Error('site_connection_failed');
        await delay(Math.min(60_000, 5000 * 2 ** attempt));
        continue;
      }
      if ([401, 403].includes(response.status)) throw Error('site_authentication_failed');
      if (response.status === 429 || response.status >= 500) {
        if (attempt === 5) throw Error(`site_http_${response.status}`);
        await delay(Math.min(60_000, 5000 * 2 ** attempt));
        continue;
      }
      if (![200, 409].includes(response.status)) throw Error(`site_http_${response.status}`);
      try { return await response.json(); } catch { throw Error('invalid_site_response'); }
    }
  }

  if (verifyOnly || completedSince !== undefined) {
    const previous = await request();
    if (alreadyComplete(previous, now(), verifyOnly ? 0 : completedSince)) {
      log({ verified: true, reused: true, models: previous.models, displayableModels: previous.catalog?.displayableModels, pricedModels: previous.catalog?.pricedModels });
      return previous;
    }
    if (verifyOnly) throw Error('persisted_update_verification_failed');
  }

  async function updateProvider(provider) {
    let lastLogged = -1, partialRetries = 0, batches = 0, scopeWaits = 0;
    while (now() < deadline && batches++ < 5000) {
      const result = await request({ provider, maxModels: 10 });
      if (result?.busy || ['session_changed_or_expired','update_already_running'].includes(result?.error)) { await delay(10_000); continue; }
      if (result.error === 'scoped_update_running' && scopeWaits++ < 60) { await delay(10_000); continue; }
      if (result.error) throw Error(`${provider}_batch_failed`);
      if (result.provider !== provider || !['running','completed','completed_with_errors','failed'].includes(result.status) || !Number.isInteger(result.total) || result.total < 1 || !Number.isInteger(result.completed) || result.completed < 0 || result.completed > result.total || !Number.isInteger(result.failed) || result.failed < 0 || result.failed > result.completed || typeof result.done !== 'boolean') throw Error(`${provider}_invalid_progress`);
      if (result.done || result.completed - lastLogged >= 50) {
        // Log only these fields. Source responses, headers and credentials stay private.
        log({ provider, completed: result.completed, total: result.total, failed: result.failed, status: result.status });
        lastLogged = result.completed;
      }
      if (!result.done) {
        if (result.status !== 'running') throw Error(`${provider}_invalid_running_status`);
        continue;
      }
      if (result.status === 'completed' && result.failed === 0 && result.completed === result.total) return result;
      // Retry missing results once. The server retains successful snapshots.
      if (partialRetries++ === 0 && ['completed_with_errors', 'failed'].includes(result.status)) { await delay(30_000); lastLogged = -1; continue; }
      throw Error(`${provider}_incomplete_update`);
    }
    throw Error(`${provider}_update_deadline_exceeded`);
  }

  // These sequential loops share server-side leases, while the two providers run concurrently.
  const settled = await Promise.allSettled(PROVIDERS.map(updateProvider));
  const status = await request();
  for (const [index, provider] of PROVIDERS.entries()) {
    if (settled[index].status === 'rejected') throw settled[index].reason;
    const actual = status.providers?.[provider], job = actual?.job;
    const age = now() - Date.parse(actual?.oldestCheckedAt);
    if (!Number.isInteger(status.models) || status.models < 1 || job?.id !== settled[index].value.jobId || job?.status !== 'completed' || job.failed !== 0 || job.completed !== status.models || job.modelCount !== status.models || actual.current !== status.models || !Number.isFinite(age) || age < 0 || age >= 24 * 3600_000) throw Error(`${provider}_verification_failed`);
  }
  log({ verified: true, models: status.models, displayableModels: status.catalog?.displayableModels, pricedModels: status.catalog?.pricedModels });
  return status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await updatePrices({ verifyOnly: process.env.VERIFY_ONLY === 'true', ...(process.env.GITHUB_EVENT_NAME === 'schedule' ? { completedSince: latestScheduledSlot(Date.now()) } : {}) }); } catch (error) {
    // Only our controlled error codes may reach this public log.
    console.error(/^[a-z0-9_]+$/.test(error?.message || '') ? error.message : 'price_update_failed');
    process.exitCode = 1;
  }
}
