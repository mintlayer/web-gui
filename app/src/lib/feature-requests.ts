import { mkdir, readFile, stat, unlink, writeFile, link } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

/**
 * Transport for the optional-services enabler sidecar.
 *
 * The web container has no Docker socket. To start/stop the bitcoin or
 * indexer profiles from the Settings page, validated request files are
 * written into a shared volume (feature-requests) that the feature-enabler
 * sidecar watches; it applies a fixed set of compose actions and writes
 * <service>.result status files back.
 *
 * The directory only exists when the deployment ships the enabler volume —
 * its absence means "manage from the host CLI instead".
 */

export const FEATURE_SERVICES = ['bitcoin', 'indexer', 'web-gui'] as const;
export type FeatureService = (typeof FEATURE_SERVICES)[number];

export const BITCOIN_NETWORKS = ['mainnet', 'testnet', 'regtest'] as const;
export type BitcoinNetwork = (typeof BITCOIN_NETWORKS)[number];

/** Actions are per service: profiles enable/disable, the app upgrades/rolls back. */
export const SERVICE_ACTIONS = {
  bitcoin: ['enable', 'disable'],
  indexer: ['enable', 'disable'],
  'web-gui': ['upgrade', 'rollback'],
} as const satisfies Record<FeatureService, readonly string[]>;

export type FeatureAction = 'enable' | 'disable' | 'upgrade' | 'rollback';

/** Release tag as accepted by the enabler: v-prefixed, shell-safe charset. */
export const RELEASE_TAG_RE = /^v[0-9][A-Za-z0-9.\-]*$/;
/** Bitcoin Core version declared by a release (`bitcoind: X` marker). */
export const BITCOIND_VERSION_RE = /^[0-9][A-Za-z0-9._-]{0,31}$/;

export interface FeatureRequest {
  action: FeatureAction;
  service: FeatureService;
  /** bitcoin only */
  network?: BitcoinNetwork;
  /** bitcoin only — pruned mode (default true, matches setup) */
  pruned?: boolean;
  /** web-gui upgrade only — the release tag to move every image to */
  tag?: string;
  /** web-gui upgrade only — Bitcoin Core version declared by that release */
  bitcoind?: string;
}

export interface FeatureResult {
  ok: boolean;
  at: number | null;
  error?: string;
}

function requestsDir(): string {
  return process.env.FEATURE_REQUESTS_DIR ?? '/config/feature-requests';
}

const MAX_ERROR_LENGTH = 400;

export function isFeatureService(value: unknown): value is FeatureService {
  return typeof value === 'string' && (FEATURE_SERVICES as readonly string[]).includes(value);
}

export function isBitcoinNetwork(value: unknown): value is BitcoinNetwork {
  return typeof value === 'string' && (BITCOIN_NETWORKS as readonly string[]).includes(value);
}

/** True when the deployment mounts the enabler volume (dir exists). */
export async function isFeatureEnablerAvailable(): Promise<boolean> {
  try {
    const s = await stat(requestsDir());
    return s.isDirectory();
  } catch {
    return false;
  }
}

function requestPath(service: FeatureService): string {
  return join(requestsDir(), `${service}.req`);
}

/** A request is pending while the sidecar has not picked it up yet. */
export async function isRequestPending(service: FeatureService): Promise<boolean> {
  try {
    await stat(requestPath(service));
    return true;
  } catch {
    return false;
  }
}

/**
 * Atomically queue an enable/disable request. Returns false when a request for
 * the same service is still unprocessed (double-clicks cannot pile up work).
 *
 * The claim is the atomic link(tmp, final): a file is only created if none
 * exists, closing the check-then-write race between concurrent requests.
 */
export async function queueFeatureRequest(req: FeatureRequest): Promise<boolean> {
  if (!isFeatureService(req.service)) throw new Error('invalid service');
  const allowed = SERVICE_ACTIONS[req.service];
  if (!(allowed as readonly string[]).includes(req.action)) {
    throw new Error('invalid action for service');
  }
  // Defense-in-depth: the sidecar re-validates, but malformed values must
  // never reach the request file at all.
  if (req.service === 'web-gui' && req.action === 'upgrade') {
    // Length caps match the enabler's own limits (tag ≤40, version ≤32) so an
    // over-long value from a bad release fails HERE — degrading to "skip this
    // release / this core bump" — instead of being written and rejected by the
    // sidecar, which would brick auto-install with a permanent failure.
    if (typeof req.tag !== 'string' || !RELEASE_TAG_RE.test(req.tag) || req.tag.length > 40) {
      throw new Error('invalid release tag');
    }
    if (
      req.bitcoind !== undefined &&
      (typeof req.bitcoind !== 'string' || !BITCOIND_VERSION_RE.test(req.bitcoind) || req.bitcoind.length > 32)
    ) {
      throw new Error('invalid bitcoind version');
    }
  }
  const dir = requestsDir();
  await mkdir(dir, { recursive: true });
  // Compact JSON, fixed field order, enum-validated values only — the sidecar
  // parses with exact-match greps and rejects anything else.
  const body = JSON.stringify({
    action: req.action,
    service: req.service,
    ...(req.service === 'bitcoin' && req.action === 'enable'
      ? { network: req.network ?? 'mainnet', pruned: req.pruned !== false }
      : {}),
    ...(req.service === 'web-gui' && req.action === 'upgrade'
      ? { tag: req.tag, ...(req.bitcoind ? { bitcoind: req.bitcoind } : {}) }
      : {}),
  });
  // Unique tmp name: a fixed name would let a concurrent second request
  // overwrite the payload between this request's write and its claim.
  const tmp = join(dir, `.${req.service}.req.${randomUUID()}.tmp`);
  const final = requestPath(req.service);
  await writeFile(tmp, body + '\n', { encoding: 'utf8', mode: 0o600 });
  try {
    await link(tmp, final);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  } finally {
    await unlink(tmp).catch(() => {});
  }
  return true;
}

/** Read the sidecar's last result for a service; null when there is none. */
export async function readFeatureResult(service: FeatureService): Promise<FeatureResult | null> {
  let raw: string;
  try {
    raw = await readFile(join(requestsDir(), `${service}.result`), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { ok?: unknown; at?: unknown; error?: unknown };
    if (typeof parsed.ok !== 'boolean') return null;
    const result: FeatureResult = {
      ok: parsed.ok,
      at: typeof parsed.at === 'number' ? parsed.at : null,
    };
    if (typeof parsed.error === 'string' && parsed.error.length > 0) {
      result.error = parsed.error.slice(0, MAX_ERROR_LENGTH);
    }
    return result;
  } catch {
    return null;
  }
}
