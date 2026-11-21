/** Carrier tracking page: UPS 1Z…, FedEx (12 or 15 digits), USPS (20–22 digits), else a web search. */
export function trackingUrl(t: string): string {
  if (/^1Z[0-9A-Z]{16}$/i.test(t)) return `https://www.ups.com/track?tracknum=${t}`;
  if (/^\d{12}$|^\d{15}$/.test(t)) return `https://www.fedex.com/fedextrack/?trknbr=${t}`;
  if (/^\d{20,22}$/.test(t)) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${t}`;
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`;
}
