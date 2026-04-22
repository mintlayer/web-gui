/**
 * Tests for SyncStatus - real-time sync progress component.
 *
 * EventSource is mocked globally so we can control messages and connection events.
 * fetch is intercepted via MSW.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/msw-handlers';
import SyncStatus from './SyncStatus';

// ── EventSource mock ──────────────────────────────────────────────────────────

class MockEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: MockEventSource[] = [];

  url: string;
  readyState = MockEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  open() {
    this.readyState = MockEventSource.OPEN;
    this.onopen?.();
  }

  error() {
    this.readyState = MockEventSource.CONNECTING;
    this.onerror?.();
  }

  send(data: string) {
    this.onmessage?.({ data });
  }

  close() {
    this.readyState = MockEventSource.CLOSED;
  }
}

beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal('EventSource', MockEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Default props helper ──────────────────────────────────────────────────────

const defaultProps = {
  initialWalletHeight: 900,
  initialNodeHeight: 950,
  initialIsSyncing: true,
  indexerEnabled: false,
};

// ── Rendering ─────────────────────────────────────────────────────────────────

describe('SyncStatus - initial rendering (not yet synced)', () => {
  it('renders the expanded "System Status" view when not synced', () => {
    render(<SyncStatus {...defaultProps} />);
    expect(screen.getByText('System Status')).toBeInTheDocument();
  });

  it('shows Node and Wallet sync rows', () => {
    render(<SyncStatus {...defaultProps} />);
    expect(screen.getByText('Node')).toBeInTheDocument();
    expect(screen.getByText('Wallet')).toBeInTheDocument();
  });

  it('does not show Indexer row when indexerEnabled=false', () => {
    render(<SyncStatus {...defaultProps} indexerEnabled={false} />);
    expect(screen.queryByText('Indexer')).not.toBeInTheDocument();
  });

  it('shows Indexer row when indexerEnabled=true', () => {
    render(<SyncStatus {...defaultProps} indexerEnabled={true} />);
    expect(screen.getByText('Indexer')).toBeInTheDocument();
  });
});

describe('SyncStatus - "All systems in sync" collapsed view', () => {
  it('shows collapsed view when node and wallet are in sync (isSyncing=false, heights match)', () => {
    render(
      <SyncStatus
        initialWalletHeight={1000}
        initialNodeHeight={1000}
        initialIsSyncing={false}
        indexerEnabled={false}
      />,
    );
    expect(screen.getByText('All systems in sync')).toBeInTheDocument();
  });

  it('shows expanded view when wallet is behind node', () => {
    render(
      <SyncStatus
        initialWalletHeight={900}
        initialNodeHeight={1000}
        initialIsSyncing={false}
        indexerEnabled={false}
      />,
    );
    expect(screen.queryByText('All systems in sync')).not.toBeInTheDocument();
    expect(screen.getByText('System Status')).toBeInTheDocument();
  });

  it('shows expanded view when isSyncing=true even if heights match', () => {
    render(
      <SyncStatus
        initialWalletHeight={1000}
        initialNodeHeight={1000}
        initialIsSyncing={true}
        indexerEnabled={false}
      />,
    );
    expect(screen.queryByText('All systems in sync')).not.toBeInTheDocument();
  });
});

// ── LiveDot ───────────────────────────────────────────────────────────────────

describe('SyncStatus - LiveDot connection state', () => {
  it('shows "connecting…" before EventSource connects', () => {
    render(<SyncStatus {...defaultProps} />);
    expect(screen.getByText('connecting…')).toBeInTheDocument();
  });

  it('shows "live" after EventSource opens', async () => {
    render(<SyncStatus {...defaultProps} />);
    const es = MockEventSource.instances[0];

    act(() => {
      es.open();
    });

    await waitFor(() => {
      expect(screen.getByText('live')).toBeInTheDocument();
    });
  });

  it('reverts to "connecting…" when EventSource errors', async () => {
    render(<SyncStatus {...defaultProps} />);
    const es = MockEventSource.instances[0];

    act(() => {
      es.open();
    });

    await waitFor(() => expect(screen.getByText('live')).toBeInTheDocument());

    act(() => {
      es.error();
    });

    await waitFor(() => {
      expect(screen.getByText('connecting…')).toBeInTheDocument();
    });
  });
});

// ── Public chain tip fetch ────────────────────────────────────────────────────

describe('SyncStatus - chain tip fetch', () => {
  it('fetches /api/chain-tip on mount', async () => {
    const handler = vi.fn(() => HttpResponse.json({ height: 5000, id: 'tipid' }));
    server.use(http.get('/api/chain-tip', handler));

    render(<SyncStatus {...defaultProps} />);

    await waitFor(() => {
      expect(handler).toHaveBeenCalled();
    });
  });
});

// ── Indexer status fetch ──────────────────────────────────────────────────────

describe('SyncStatus - indexer status', () => {
  it('fetches /api/indexer-status when indexerEnabled=true', async () => {
    const handler = vi.fn(() => HttpResponse.json({ up: true, height: 940 }));
    server.use(http.get('/api/indexer-status', handler));

    render(<SyncStatus {...defaultProps} indexerEnabled={true} />);

    await waitFor(() => {
      expect(handler).toHaveBeenCalled();
    });
  });

  it('does not fetch /api/indexer-status when indexerEnabled=false', async () => {
    const handler = vi.fn(() => HttpResponse.json({ up: true, height: 940 }));
    server.use(http.get('/api/indexer-status', handler));

    render(<SyncStatus {...defaultProps} indexerEnabled={false} />);

    // Give time for any potential fetch to occur
    await new Promise(r => setTimeout(r, 50));
    expect(handler).not.toHaveBeenCalled();
  });

  it('shows "offline" when indexer returns {up: false}', async () => {
    server.use(
      http.get('/api/indexer-status', () =>
        HttpResponse.json({ up: false, height: null }),
      ),
    );

    render(<SyncStatus {...defaultProps} indexerEnabled={true} />);

    await waitFor(() => {
      expect(screen.getByText('offline')).toBeInTheDocument();
    });
  });
});

// ── Block stream messages ─────────────────────────────────────────────────────

describe('SyncStatus - block stream events', () => {
  it('opens an EventSource for /api/block-stream', () => {
    render(<SyncStatus {...defaultProps} />);
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toBe('/api/block-stream');
  });

  it('fetches updated heights when a NewBlock message is received', async () => {
    const rpcHandler = vi.fn(async ({ request }: { request: Request }) => {
      const body = await request.json() as { method: string };
      if (body.method === 'wallet_best_block') {
        return HttpResponse.json({ ok: true, result: { height: 960, id: 'newblock' } });
      }
      if (body.method === 'node_chainstate_info') {
        return HttpResponse.json({
          ok: true,
          result: { best_block_height: 960, best_block_id: 'x', is_initial_block_download: false, best_block_timestamp: { timestamp: 0 }, median_time: { timestamp: 0 } },
        });
      }
      return HttpResponse.json({ ok: false, error: { message: 'unexpected' } }, { status: 502 });
    });
    server.use(http.post('/api/rpc', rpcHandler));

    render(<SyncStatus {...defaultProps} />);
    const es = MockEventSource.instances[0];

    act(() => {
      es.send(JSON.stringify({ type: 'NewBlock' }));
    });

    await waitFor(() => {
      expect(rpcHandler).toHaveBeenCalled();
    });
  });

  it('ignores malformed JSON in block stream messages', () => {
    render(<SyncStatus {...defaultProps} />);
    const es = MockEventSource.instances[0];

    // Should not throw
    expect(() => {
      act(() => {
        es.send('not-valid-json');
      });
    }).not.toThrow();
  });
});
