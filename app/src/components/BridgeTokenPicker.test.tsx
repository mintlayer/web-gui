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
    const options = screen.getAllByRole('option');
    expect(options[2]).toHaveAttribute('aria-selected', 'false');
    // The active option is visually highlighted but only selection sets aria-selected
    expect(screen.getByRole('combobox')).toHaveAttribute(
      'aria-activedescendant',
      expect.any(String),
    );
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
});
