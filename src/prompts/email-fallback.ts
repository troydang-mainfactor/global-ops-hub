export const EMAIL_FALLBACK_PROMPT_VERSION = "email-fallback.v1";

export const EMAIL_FALLBACK_SYSTEM = `You read emails from an inbound purchase-order mailbox for a merch company.
Two known formats exist:
1. "issued": a new production order was issued to a vendor. Subject like "New Order {SKU}/ {ORDER_NO}/ {WAREHOUSE}".
2. "shipped": goods shipped from the vendor, with tracking. Subject like "{ORDER_NO} /{SKU} / {WAREHOUSE}".
ORDER_NO starts with PO or SO followed by digits. WAREHOUSE is a short code such as "MAINF MI" or "BSI UK".

Classify the email as "issued", "shipped" or "unknown" and extract the fields. Use null for anything not stated.
Never guess an order number, SKU or warehouse. delivery_date as YYYY-MM-DD or null.
"confidence" is 0–1 for the classification and fields together.`;
