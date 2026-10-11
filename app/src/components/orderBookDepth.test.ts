import { describe, it, expect } from 'vitest';
import { aggregateLevels, orderPrice, fmtQty } from './orderBookDepth';
import type { OrderInfo } from '@/lib/wallet-rpc';

function makeOrder(
  orderId: string,
  giveDecimal: string,
  askDecimal: string,
  givesToken: boolean,
): OrderInfo {
  return {
    order_id: orderId,
    is_marked_as_concluded_in_wallet: false,
    is_marked_as_frozen_in_wallet: false,
    initially_given: givesToken
      ? { type: 'Token', content: 'tml_1' }
      : { type: 'Coin', content: { atoms: '0', decimal: giveDecimal } },
    initially_asked: givesToken
      ? { type: 'Coin', content: { atoms: '0', decimal: askDecimal } }
      : { type: 'Token', content: 'tml_1' },
    existing_order_data: {
      give_balance: { atoms: '0', decimal: giveDecimal },
      ask_balance: { atoms: '0', decimal: askDecimal },
      initially_given: { atoms: '0', decimal: giveDecimal },
      initially_asked: { atoms: '0', decimal: askDecimal },
      is_frozen: false,
      conclude_destination: 'tmt1abc',
    },
  } as unknown as OrderInfo;
}

// An "ask" gives Token, asks ML; a "bid" gives ML, asks Token.
const ask = (id: string, tok: string, ml: string) => makeOrder(id, tok, ml, true);
const bid = (id: string, ml: string, tok: string) => makeOrder(id, ml, tok, false);

describe('orderPrice', () => {
  it('computes ML per token for asks and bids', () => {
    expect(orderPrice(ask('a1', '10', '25'), 'ask')).toBe(2.5);
    expect(orderPrice(bid('b1', '25', '10'), 'bid')).toBe(2.5);
  });

  it('returns 0 for concluded orders without chain data', () => {
    const o = { order_id: 'x', existing_order_data: null } as unknown as OrderInfo;
    expect(orderPrice(o, 'ask')).toBe(0);
  });

  it('returns 0 when the token leg is zero (avoids Infinity prices)', () => {
    expect(orderPrice(ask('a2', '0', '25'), 'ask')).toBe(0);
  });
});

describe('aggregateLevels', () => {
  it('groups orders sharing a price and sums both legs', () => {
    const asks = [ask('a1', '10', '20'), ask('a2', '5', '10'), ask('a3', '8', '40')];
    const levels = aggregateLevels(asks, 'ask');
    expect(levels).toEqual([
      { price: 2, tokenTotal: 15, mlTotal: 30, count: 2 },
      { price: 5, tokenTotal: 8, mlTotal: 40, count: 1 },
    ]);
  });

  it('sorts asks ascending and bids descending', () => {
    const asks = [ask('a1', '1', '50'), ask('a2', '1', '10'), ask('a3', '1', '25')];
    const bids = [bid('b1', '10', '1'), bid('b2', '50', '1'), bid('b3', '25', '1')];
    expect(aggregateLevels(asks, 'ask').map(l => l.price)).toEqual([10, 25, 50]);
    expect(aggregateLevels(bids, 'bid').map(l => l.price)).toEqual([50, 25, 10]);
  });

  it('skips orders without balances instead of emitting a zero-price level', () => {
    const o = { order_id: 'x', existing_order_data: null } as unknown as OrderInfo;
    expect(aggregateLevels([o], 'bid')).toEqual([]);
  });
});

describe('fmtQty', () => {
  it('trims trailing zero noise and groups thousands', () => {
    expect(fmtQty(1234.5)).toBe('1,234.5');
    expect(fmtQty(0.00000012)).toBe('0.00000012');
  });
});
