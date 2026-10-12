// @vitest-environment jsdom
/** Tests for BridgeTokenPicker — search, keyboard navigation, selection. */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BridgeTokenPicker from './BridgeTokenPicker';

const assets = [
  { ticker: 'usdc', name: 'Bridged USD Coin', tags: ['stablecoin'] },
  { ticker: 'ml', name: 'Mintlayer', tags: ['native'] },
  { ticker: 'pepe', name: 'Pepe', tags: ['meme'] },
];

function renderPicker(onChange = () => {}) {
  return render(
    <BridgeTokenPicker assets={assets} value="usdc" onChange={onChange} metadata={{}} />,
  );
}

describe('BridgeTokenPicker', () => {
  it('renders the selected ticker on the trigger', () => {
    renderPicker();
    expect(screen.getByRole('button', { name: /usdc/i })).toBeInTheDocument();
  });

  it('opens the listbox, filters by query and selects with Enter', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderPicker(onChange);
    await user.click(screen.getByRole('button', { name: /usdc/i }));
    const listbox = screen.getByRole('listbox');
    expect(listbox).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /pepe/i })).toBeInTheDocument();

    // Filter to stablecoin via tag search
    await user.type(screen.getByRole('combobox'), 'stablecoin');
    expect(screen.getByRole('option', { name: /usdc/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /pepe/i })).not.toBeInTheDocument();

    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('usdc');
  });

  it('supports arrow-key navigation and shows the empty state', async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByRole('button', { name: /usdc/i }));
    await user.type(screen.getByRole('combobox'), 'zzz');
    expect(screen.getByText(/no tokens match/i)).toBeInTheDocument();
    await user.clear(screen.getByRole('combobox'));
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    // 3 items — active index clamps to the last option
    expect(screen.getByRole('combobox').getAttribute('aria-activedescendant')).toMatch(
      /-opt-2$/,
    );
    // Alphabetical order without balances: ml, pepe, usdc (selected)
    const options = screen.getAllByRole('option');
    expect(options[2]?.textContent).toMatch(/usdc/);
    expect(options[2]).toHaveAttribute('aria-selected', 'true');
  });

  it('marks the current value as selected in the list', async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByRole('button', { name: /usdc/i }));
    expect(screen.getByRole('option', { name: /usdc/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('sorts held tokens first by USD value and shows balances', async () => {
    const user = userEvent.setup();
    render(
      <BridgeTokenPicker
        assets={assets}
        value="usdc"
        onChange={() => {}}
        metadata={{}}
        balances={{ usdc: null, ml: '100', pepe: '0.5' }}
        usdPrices={{ usdc: 1, ml: 0.05, pepe: 2000 }}
      />,
    );
    await user.click(screen.getByRole('button', { name: /usdc/i }));
    const options = screen.getAllByRole('option');
    // pepe ($1000) before ml ($5); usdc has no balance → last
    expect(options[0]?.textContent).toMatch(/pepe/);
    expect(options[1]?.textContent).toMatch(/ml/);
    expect(options[2]?.textContent).toMatch(/usdc/);
    expect(screen.getByText('0.5')).toBeInTheDocument();
    expect(screen.getByText('≈$1.0k')).toBeInTheDocument();
  });
});
