// Samples built from reference/po-email-formats.md (Nov 2026). Replace or extend with
// real exported messages as they come in; keep them here as the parser's regression set.

const ASANA = "https://app.asana.com/1/1111111111/project/1210225902154346/task/1212345678901234";

export const issuedStok = {
  subject: "New Order STOKNR104581OT/ PO094330/ MAINF MI",
  body: `A new production order has been issued to a vendor for STOKNR104581OT. Please follow the Asana Link to the task to find the PO document.

SKU: STOKNR104581OT
Design Name: Stokes Tour Tee 2026
Order Type: New

Sent from Asana: ${ASANA}`,
  receivedAt: new Date("2026-11-10T15:04:00Z"),
};

export const issuedEvan = {
  subject: "New Order EVANRX103143BK/ PO094352/ MAINF MI",
  body: `A new production order has been issued to a vendor for EVANRX103143BK. Please follow the Asana Link to the task to find the PO document.

SKU: EVANRX103143BK
Design Name: Evan Black Hoodie
Order Type: New

Sent from Asana: ${ASANA}`,
  receivedAt: new Date("2026-11-12T10:00:00Z"),
};

export const issuedSoUk = {
  subject: "New Order STOKRX004233OT/ SO0058136/ BSI UK",
  body: `A new production order has been issued to a vendor for STOKRX004233OT. Please follow the Asana Link to the task to find the PO document.

SKU: STOKRX004233OT
Design Name: Stokes UK Vinyl LP
Order Type: New

Sent from Asana: ${ASANA}`,
  receivedAt: new Date("2026-11-13T09:00:00Z"),
};

export const shippedFalr = {
  subject: "PO094108 /FALRNR103455RD / MAINF MI",
  body: `FALRNR103455RD has shipped from the vendor. Please see tracking below and the Asana Task Link for the PO & packing list documents.

FALRNR103455RD
Falr Red Logo Tee
Tracking:
1Z999AA10123456784/1Z999AA10123456785
Delivery Date:
Dec 2, 2026
Warehouse:
MAINF MI

Sent from Asana: ${ASANA}`,
  receivedAt: new Date("2026-11-18T16:30:00Z"),
};

export const shippedMegaComponentNoDate = {
  subject: "PO093125 /MEGARX203613GR - Hand Cuffs (Component) / MAINF MI",
  body: `MEGARX203613GR has shipped from the vendor. Please see tracking below and the Asana Task Link for the PO & packing list documents.

MEGARX203613GR
Mega Green Hand Cuffs
Tracking:
1Z999AA10123456799
Delivery Date:
[no value]
Warehouse:
MAINF MI

Sent from Asana: ${ASANA}`,
  receivedAt: new Date("2026-11-19T12:00:00Z"),
};

/** Same message forwarded, with Windows line endings and a "Fwd:" prefix. */
export const shippedForwardedCrlf = {
  subject: "Fwd: PO094108 /FALRNR103455RD / MAINF MI",
  body: shippedFalr.body.replace(/\n/g, "\r\n"),
  receivedAt: shippedFalr.receivedAt,
};

/** Shipped email where the body warehouse differs from the subject. */
export const shippedWarehouseMismatch = {
  subject: "PO094200 /STOKNR104590BK / MAINF MI",
  body: `STOKNR104590BK has shipped from the vendor. Please see tracking below and the Asana Task Link for the PO & packing list documents.

STOKNR104590BK
Stokes Black Tee
Tracking:
1Z999AA10123456700
Delivery Date:
12/05/2026
Warehouse:
BSI UK

Sent from Asana: ${ASANA}`,
  receivedAt: new Date("2026-11-20T12:00:00Z"),
};

export const unknownFormat = {
  subject: "Packing list update for next week",
  body: "Hi team, the packing list for the December shipment is attached. Thanks, Jonathan",
  receivedAt: new Date("2026-11-20T12:00:00Z"),
};

export const ASANA_TASK_URL = ASANA;
