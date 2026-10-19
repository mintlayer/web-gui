/**
 * Release checking against the project's GitHub releases. Read-only HTTP to
 * api.github.com (no telemetry: the request carries no wallet or usage data),
 * cached in-module so page loads don't hammer the API.
 *
 * The daemon images are published with the same v<version> tag as the app
 * release (mintlayer-daemons.yml builds them from ML_CORE_REF on every v* tag),
 * so upgrading means moving all images to one tag — this module only reports;
 * the feature-enabler sidecar applies.
 */
import pkg from '../../package.json';

export const CURRENT_VERSION: string = pkg.version;

/** Overridable for tests and self-hosted mirrors. */
const RELEASES_URL = process.env.UPDATE_CHECK_URL ?? 'https://api.github.com/repos/mintlayer/web-gui/releases';

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const ttlMs = () => {
  const raw = Number(process.env.UPDATE_CHECK_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_TTL_MS;
};

const MAX_RELEASES = 20;
const MAX_NOTES_CHARS = 8000;
const MAX_NAME_CHARS = 200;
/** Tags we could ever pass to the enabler: v-prefixed, shell-safe charset. */
const TAG_RE = /^v[0-9][A-Za-z0-9.\-]*$/;
/**
 * Stricter than TAG_RE: numeric dotted core + optional pre-release suffix.
 * Anything else (a stray "v1x" from a corrupted feed or odd mirror) must not
 * enter the version comparison at all — it would otherwise rank above every
 * real version and, with auto-install on, queue a doomed pull.
 */
const VERSION_TAG_RE = /^v[0-9]+(\.[0-9]+){0,3}(-[0-9A-Za-z.]+)?$/;
/**
 * Bitcoin Core versions we accept from release notes: digits first, short,
 * shell-safe. Mirrors the enabler's own check — the volume is a second
 * boundary, but rejecting early keeps a bad marker from blocking upgrades.
 */
const BITCOIND_VERSION_RE = /^[0-9][A-Za-z0-9._-]{0,31}$/;

export interface ReleaseInfo {
  tag: string;
  version: string;
  name: string | null;
  notes: string;
  prerelease: boolean;
  url: string;
  publishedAt: string | null;
  /** Bitcoin Core version declared in the release notes (`bitcoind: X`), if any. */
  bitcoind: string | null;
}

export interface UpdateStatus {
  current: string;
  available: boolean;
  latest: ReleaseInfo | null;
  checkedAt: number | null;
}

interface CacheEntry {
  at: number;
  releases: ReleaseInfo[];
}

let cache: CacheEntry | null = null;

/** Test seam. */
export function clearUpdateCache(): void {
  cache = null;
}

/** "v1.0.0-rc2" / "1.0.0" → comparable string form. */
function normalize(tag: string): string {
  return tag.startsWith('v') ? tag.slice(1) : tag;
}

/**
 * Semver-ish compare: core fields numerically; a final release outranks any
 * pre-release of the same core; rcN ranks numerically within pre-releases.
 * Returns negative when a < b, positive when a > b, 0 when equal.
 */
export function compareVersions(a: string, b: string): number {
  const [aCore, aPre = ''] = normalize(a).split('-', 2);
  const [bCore, bPre = ''] = normalize(b).split('-', 2);
  const aParts = aCore.split('.');
  const bParts = bCore.split('.');
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const x = Number(aParts[i] ?? 0);
    const y = Number(bParts[i] ?? 0);
    // A non-numeric field (should not happen for validated tags) compares as
    // equal so it can never outrank a real version.
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (aPre !== bPre) {
    if (aPre === '') return 1; // final beats pre-release
    if (bPre === '') return -1;
    const aRc = /^rc(\d+)$/.exec(aPre);
    const bRc = /^rc(\d+)$/.exec(bPre);
    if (aRc && bRc) return Math.sign(Number(aRc[1]) - Number(bRc[1]));
    return aPre < bPre ? -1 : aPre > bPre ? 1 : 0;
  }
  return 0;
}

/**
 * Release notes carry one machine-readable line when a release ships a tested
 * Bitcoin Core bump: `bitcoind: 26.0` (optionally wrapped in an HTML comment).
 * Absent → this release leaves Bitcoin Core alone.
 */
export function parseBitcoindMarker(notes: string): string | null {
  // Anchored to a line start (optionally inside an HTML comment): prose like
  // "we fixed the frobbitcoind: 26.0 bug" or "compatible with bitcoind: 25.x"
  // must not declare a core bump. The capture is length-bounded and checked
  // against the same shape the enabler enforces.
  const m = /(?:^|\n)[ \t]*(?:<!--[ \t]*)?bitcoind:[ \t]*([0-9][A-Za-z0-9._-]{0,31})(?![A-Za-z0-9._-])/m.exec(notes);
  return m && BITCOIND_VERSION_RE.test(m[1]) ? m[1] : null;
}

function asRelease(raw: unknown): ReleaseInfo | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.tag_name !== 'string' || !TAG_RE.test(r.tag_name) || !VERSION_TAG_RE.test(r.tag_name)) return null;
  if (typeof r.body !== 'string') return null;
  const notes = r.body.length > MAX_NOTES_CHARS ? r.body.slice(0, MAX_NOTES_CHARS) : r.body;
  const htmlUrl = typeof r.html_url === 'string' && r.html_url.startsWith('https://') ? r.html_url : '';
  return {
    tag: r.tag_name,
    version: normalize(r.tag_name),
    name: typeof r.name === 'string' && r.name.length > 0 ? r.name.slice(0, MAX_NAME_CHARS) : null,
    notes,
    prerelease: r.prerelease === true,
    url: htmlUrl,
    publishedAt: typeof r.published_at === 'string' ? r.published_at : null,
    bitcoind: parseBitcoindMarker(notes),
  };
}

async function fetchReleases(): Promise<ReleaseInfo[]> {
  const res = await fetch(RELEASES_URL, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'mintlayer-nexus' },
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  if (!res.ok) throw new Error(`release check failed: HTTP ${res.status}`);
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) throw new Error('release check failed: unexpected content type');
  const body: unknown = await res.json();
  if (!Array.isArray(body)) throw new Error('release check failed: unexpected body');
  return body
    .map(asRelease)
    .filter((r): r is ReleaseInfo => r !== null)
    // Cap AFTER filtering: a burst of published pre-releases must not hide a
    // newer final release that sits beyond the window.
    .slice(0, MAX_RELEASES);
}

/**
 * Newest applicable release (pre-releases filtered unless requested) and
 * whether it is newer than the running version. Throws on fetch/parse
 * failure — callers decide how to degrade.
 */
export async function checkForUpdate(includePrereleases: boolean): Promise<UpdateStatus> {
  const base: UpdateStatus = { current: CURRENT_VERSION, available: false, latest: null, checkedAt: null };
  if (!cache || Date.now() - cache.at > ttlMs()) {
    const releases = await fetchReleases();
    cache = { at: Date.now(), releases };
  }
  const applicable = cache.releases.filter((r) => includePrereleases || !r.prerelease);
  const newest = applicable.reduce<ReleaseInfo | null>((best, r) => {
    if (best === null || compareVersions(r.version, best.version) > 0) return r;
    return best;
  }, null);
  if (newest === null) return base;
  return {
    current: CURRENT_VERSION,
    available: compareVersions(newest.version, CURRENT_VERSION) > 0,
    latest: newest,
    checkedAt: cache.at,
  };
}
