/**
 * Local history of the user's own bridge requests, persisted in
 * localStorage (one slot per browser, most recent first, capped).
 * Every field is re-validated on read - localStorage is user-writable,
 * so a type-confused record fails closed instead of crashing the UI.
 */

export const HISTORY_KEY = 'bridge_history';
export const HISTORY_LIMIT = 20;

export interface BridgeHistoryEntry {
  uuid: string;
  direction: 'e2m' | 'm2e';
  asset: string;
  amount: string;
  receiver: string;
  startedAt: string;
  /** Cached last-known status; refreshed from the API when shown. */
  status?: string;
}

function isDirection(value: unknown): value is 'e2m' | 'm2e' {
  return value === 'e2m' || value === 'm2e';
}

/** Validates one raw entry; null when anything is off. */
function asEntry(raw: unknown): BridgeHistoryEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.uuid !== 'string' || e.uuid.length === 0) return null;
  if (!isDirection(e.direction)) return null;
  if (typeof e.asset !== 'string' || e.asset.length === 0) return null;
  if (typeof e.amount !== 'string') return null;
  if (typeof e.receiver !== 'string') return null;
  // startedAt renders via toLocaleDateString - reject junk up front.
  if (
    typeof e.startedAt !== 'string' ||
    Number.isNaN(Date.parse(e.startedAt))
  ) {
    return null;
  }
  const entry: BridgeHistoryEntry = {
    uuid: e.uuid,
    direction: e.direction,
    asset: e.asset,
    amount: e.amount,
    receiver: e.receiver,
    startedAt: e.startedAt,
  };
  if (typeof e.status === 'string') entry.status = e.status;
  return entry;
}

export function listHistory(): BridgeHistoryEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .map(asEntry)
      .filter((e): e is BridgeHistoryEntry => e !== null);
  } catch {
    return [];
  }
}

/** Prepends an entry, deduplicates by uuid and caps the list. */
export function appendHistory(entry: BridgeHistoryEntry): void {
  const rest = listHistory().filter((e) => e.uuid !== entry.uuid);
  try {
    localStorage.setItem(
      HISTORY_KEY,
      JSON.stringify([entry, ...rest].slice(0, HISTORY_LIMIT)),
    );
  } catch {
    /* storage unavailable - history is best-effort */
  }
}

/** Updates the cached status of one entry, if present. */
/** Cached last-known status, capped so a hostile API can't bloat rows. */
const MAX_STATUS_LENGTH = 40;

export function updateHistoryStatus(uuid: string, status: string): void {
  const all = listHistory();
  const hit = all.find((e) => e.uuid === uuid);
  if (!hit) return;
  hit.status = status.slice(0, MAX_STATUS_LENGTH);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(all));
  } catch {
    /* best-effort */
  }
}

export function clearHistory(): void {
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch {
    /* unavailable */
  }
}
