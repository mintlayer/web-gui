/**
 * Tests for StakingControl - start/stop staking toggle component.
 * Uses MSW to intercept /api/rpc fetch calls.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/msw-handlers';
import StakingControl from './StakingControl';

// Helper to render with a specific initial status
function renderStaking(initialStatus: 'Staking' | 'NotStaking') {
  return render(<StakingControl initialStatus={initialStatus} />);
}

describe('StakingControl - initial rendering', () => {
  it('shows "Staking" label and "Stop" button when initialStatus is Staking', () => {
    renderStaking('Staking');
    expect(screen.getByText('Staking')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
  });

  it('shows "Not staking" label and "Start" button when initialStatus is NotStaking', () => {
    renderStaking('NotStaking');
    expect(screen.getByText('Not staking')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument();
  });

  it('does not show error message initially', () => {
    renderStaking('Staking');
    expect(screen.queryByRole('paragraph')).not.toBeInTheDocument();
  });
});

describe('StakingControl - start flow', () => {
  it('calls staking_start and transitions to Staking on success', async () => {
    server.use(
      http.post('/api/rpc', async ({ request }) => {
        const body = await request.json() as { method: string };
        if (body.method === 'staking_start') {
          return HttpResponse.json({ ok: true, result: null });
        }
        return HttpResponse.json({ ok: false, error: { message: 'unexpected method' } }, { status: 502 });
      }),
    );

    const user = userEvent.setup();
    renderStaking('NotStaking');

    await user.click(screen.getByRole('button', { name: 'Start' }));

    await waitFor(() => {
      expect(screen.getByText('Staking')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    });
  });

  it('shows loading indicator "…" while request is in flight', async () => {
    // Never-resolving promise to catch the loading state
    server.use(
      http.post('/api/rpc', () => new Promise(() => {})),
    );

    const user = userEvent.setup();
    renderStaking('NotStaking');
    user.click(screen.getByRole('button', { name: 'Start' }));

    await waitFor(() => {
      expect(screen.getByRole('button')).toHaveTextContent('…');
    });
  });

  it('button is disabled while request is in flight', async () => {
    server.use(
      http.post('/api/rpc', () => new Promise(() => {})),
    );

    const user = userEvent.setup();
    renderStaking('NotStaking');
    user.click(screen.getByRole('button', { name: 'Start' }));

    await waitFor(() => {
      expect(screen.getByRole('button')).toBeDisabled();
    });
  });
});

describe('StakingControl - stop flow', () => {
  it('calls staking_stop and transitions to Not staking on success', async () => {
    server.use(
      http.post('/api/rpc', async ({ request }) => {
        const body = await request.json() as { method: string };
        if (body.method === 'staking_stop') {
          return HttpResponse.json({ ok: true, result: null });
        }
        return HttpResponse.json({ ok: false, error: { message: 'unexpected' } }, { status: 502 });
      }),
    );

    const user = userEvent.setup();
    renderStaking('Staking');

    await user.click(screen.getByRole('button', { name: 'Stop' }));

    await waitFor(() => {
      expect(screen.getByText('Not staking')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument();
    });
  });
});

describe('StakingControl - error handling', () => {
  it('displays error message when RPC returns {ok: false}', async () => {
    server.use(
      http.post('/api/rpc', () =>
        HttpResponse.json({ ok: false, error: { message: 'wallet locked' } }, { status: 502 }),
      ),
    );

    const user = userEvent.setup();
    renderStaking('NotStaking');
    await user.click(screen.getByRole('button', { name: 'Start' }));

    await waitFor(() => {
      expect(screen.getByText('wallet locked')).toBeInTheDocument();
    });
  });

  it('clears error message on the next click attempt', async () => {
    let callCount = 0;
    server.use(
      http.post('/api/rpc', () => {
        callCount++;
        if (callCount === 1) {
          return HttpResponse.json({ ok: false, error: { message: 'fail' } }, { status: 502 });
        }
        return HttpResponse.json({ ok: true, result: null });
      }),
    );

    const user = userEvent.setup();
    renderStaking('NotStaking');

    // First click - fails
    await user.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(screen.getByText('fail')).toBeInTheDocument());

    // Second click - succeeds, error should clear
    await user.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(screen.queryByText('fail')).not.toBeInTheDocument());
  });

  it('status does not change when RPC fails', async () => {
    server.use(
      http.post('/api/rpc', () =>
        HttpResponse.json({ ok: false, error: { message: 'fail' } }, { status: 502 }),
      ),
    );

    const user = userEvent.setup();
    renderStaking('NotStaking');
    await user.click(screen.getByRole('button', { name: 'Start' }));

    await waitFor(() => expect(screen.getByText('fail')).toBeInTheDocument());
    // Status should remain "Not staking"
    expect(screen.getByText('Not staking')).toBeInTheDocument();
  });
});
