// One Intl.NumberFormat instance per currency code, reused rather than constructed on every
// render — constructing one is measurably more expensive than a plain number format and every
// fare on this screen uses the same currency, so there's no reason to pay that cost repeatedly.
const currencyFormatters = new Map<string, Intl.NumberFormat>();

/** Formats a whole-cents integer (core's fareEstimate fields, docs/API.md) as a locale-aware
 * currency string — e.g. 4150 -> "$41.50". The division by 100 is the only "computation" this
 * does; every actual fare number displayed comes straight from the backend's response, never
 * recomputed here. */
export function formatCents(cents: number, currency: string): string {
  let formatter = currencyFormatters.get(currency);
  if (!formatter) {
    formatter = new Intl.NumberFormat(undefined, { style: "currency", currency });
    currencyFormatters.set(currency, formatter);
  }
  return formatter.format(cents / 100);
}
