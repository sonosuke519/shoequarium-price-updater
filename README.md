# ShoeQuarium price updater

Calls an authenticated, bounded update endpoint twice daily at 03:00 and
15:00 Asia/Tokyo. GitHub schedules can start late. This repository contains
only the caller and its tests: no Site source, model dictionary, market data,
marketplace API credentials, or AI execution.

The public repository uses standard `ubuntu-latest` GitHub-hosted runners,
which do not consume the shared private-repository compute allowance.
No artifacts or dependency caches are uploaded.

## Operation

- Node 22; no third-party runtime dependencies.
- `RETAIL_AUTOMATION_KEY` is stored in GitHub Actions Secrets. The Site stores
  only its SHA-256 digest as `RETAIL_AUTOMATION_KEY_HASH`.
- The key permits only price-update batches and aggregate status readback.
  It cannot edit Site source, deploy, change settings, choose arbitrary
  stores, modify model dictionaries, or retrieve marketplace credentials.
- The Site owns collection, rate limits, validation, leases, cursors and
  storage. Both providers run concurrently; calls within one provider are serial.
- Connection failures and rate limits are retried. Partial collection failures
  get one further pass; successful snapshots are retained by the Site.
- A run succeeds only after both providers finish all registered keys with
  zero failures and persisted status confirms complete, unexpired data.
- Source payloads, credentials, item names and product URLs are never logged.
- Runs are serialized; a manual run resumes existing progress.
- GitHub Actions reports failures under the owner's notification settings.
  Routine success does not send a custom message.
- A separate job records a harmless monthly timestamp after success, avoiding
  automatic schedule disabling after 60 days without repository activity.
  Only this job has repository write permission; it has no Site credential.

Run manually from Actions → Update ShoeQuarium prices → Run workflow.
After a credential is revoked or changed, update the GitHub secret and the
Site's digest together. Routine scheduled runs require no user sign-in.

Tests: `node --test`.
