/** The price of an order in cents, as text: 1250 → "12.50". */
export function formatPrice(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** The states of an order. */
export type OrderStatus = 'open' | 'saved' | 'cancelled';

/** The sum of some prices in cents. */
export function totalCents(prices: number[]): number {
  return prices.reduce((sum, p) => sum + p, 0);
}

/** The tax on a price in cents, with the rate in percent. */
export function taxCents(cents: number, rate: number): number {
  return Math.round((cents * rate) / 100);
}
