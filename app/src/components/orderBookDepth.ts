/**
 * Price-level aggregation for the trading pair book.
 *
 * The pair data comes from the wallet RPC (order_list_all_active) as
 * individual orders; deep pairs read much better as aggregated levels
 * (what the 1.4.1 indexer /order/pair/{pair}/book returns server-side).
 * Grouping client-side keeps the per-order Fill action working and works
 * on any indexer version.
 */

import type { OrderInfo } from '@/lib/wallet-rpc';

export interface PriceLevel {
  /** ML per token. */
  price: number;
  /** Sum of token amounts across the orders at this price. */
  tokenTotal: number;
  /** Sum of ML amounts across the orders at this price. */
  mlTotal: number;
  /** How many individual orders sit at this price. */
  count: number;
}

/** ML-per-token price of an order (mirrors the pair book sort key). */
export function orderPrice(o: OrderInfo, side: 'ask' | 'bid'): number {
  const d = o.existing_order_data;
  if (!d) return 0;
  const tok = parseFloat(side === 'ask' ? d.give_balance.decimal : d.ask_balance.decimal);
  const ml  = parseFloat(side === 'ask' ? d.ask_balance.decimal  : d.give_balance.decimal);
  return tok > 0 ? ml / tok : 0;
}

/**
 * Group individual orders into aggregated price levels.
 * Asks come back ascending (cheapest first), bids descending (highest first),
 * matching the 1.4.1 book endpoint's ordering.
 */
export function aggregateLevels(orders: OrderInfo[], side: 'ask' | 'bid'): PriceLevel[] {
  const byPrice = new Map<number, PriceLevel>();
  for (const o of orders) {
    const d = o.existing_order_data;
    if (!d) continue;
    const price = orderPrice(o, side);
    if (price <= 0) continue;
    const tokenAmt = parseFloat(side === 'ask' ? d.give_balance.decimal : d.ask_balance.decimal);
    const mlAmt    = parseFloat(side === 'ask' ? d.ask_balance.decimal  : d.give_balance.decimal);
    const lvl = byPrice.get(price) ?? { price, tokenTotal: 0, mlTotal: 0, count: 0 };
    lvl.tokenTotal += tokenAmt;
    lvl.mlTotal += mlAmt;
    lvl.count += 1;
    byPrice.set(price, lvl);
  }
  return [...byPrice.values()].sort((a, b) =>
    side === 'ask' ? a.price - b.price : b.price - a.price
  );
}

/** Format an amount without trailing zero noise (8 decimals max, grouped). */
export function fmtQty(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 8 });
}
