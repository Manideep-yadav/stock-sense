# StockSense — Inventory Management System

A full-stack IMS that replaces manual registers, spreadsheets, and scattered
tracking with one real-time app: products, multi-warehouse stock, receipts,
delivery orders, internal transfers, adjustments, and a full move-history
ledger — matching the brief end to end.

## Why this stack

Built with **zero external dependencies** — Python's standard library
(`http.server` + `sqlite3`) on the backend, and plain HTML/CSS/JS on the
frontend. No `npm install`, no pip packages, no internet connection needed.
That means it will run on any judge's laptop the moment Python is installed —
important for a hackathon demo where setup time is part of the score.

## Run it

```bash
cd backend
python3 server.py
```

Then open **http://localhost:8000**.

Demo logins (seeded so you can show both roles immediately):
- Inventory Manager: `demo@stocksense.io` / `demo1234`
- Warehouse Staff: `staff@stocksense.io` / `staff1234`

(2 warehouses, 3 categories and 5 products are seeded so the app isn't
empty on first launch.)

## What's implemented

**Auth** — sign up (choose your role), log in, OTP-based password reset
(the OTP is returned directly in the response/toast since this sandbox has
no email service — swap in a real mailer for production). Passwords are
hashed with salted PBKDF2-HMAC-SHA256 (260k iterations); session tokens
expire after 24 hours.

**Roles** — every account is either an **Inventory Manager** or
**Warehouse Staff**. Managers have full access: catalog (create/edit/
delete products), warehouse & category setup, plus everything staff can
do. Staff run day-to-day operations — receipts, deliveries, transfers,
adjustments, validating documents, viewing the dashboard, products and
move history — but can't touch the catalog or add warehouses. Enforced
on the backend (every write route checks the caller's role — a crafted
request can't bypass it), and mirrored in the UI so the controls a role
can't use aren't shown in the first place.

**Dashboard** — total products, low-stock / out-of-stock counts, pending
receipts/deliveries/transfers, a recent-documents feed, and a "Needs
reorder" panel listing the actual products that are low or out, not just
a count.

**Products** — create/update/delete (Managers), SKU, category, unit of
measure, reorder min/max, live stock per warehouse.

**Operations** (modeled as one `documents` table with a `type`, exactly
like the brief's shared status lifecycle — Draft → Waiting → Ready → Done
/ Canceled):
- **Receipts** — vendor + products + quantities → validating adds stock.
- **Delivery Orders** — pick/pack → validating subtracts stock (blocked if
  insufficient quantity is available).
- **Internal Transfers** — moves stock between two warehouses in one
  validated transaction (logs a "transfer out" + "transfer in" pair).
- **Inventory Adjustments** — enter a counted quantity; the system computes
  and applies the delta against what's on record.
- **Move History** — the full stock ledger (every change, filterable by
  product/warehouse), so every quantity change is traceable to a document.
  Export to CSV from the current filter.

**Settings** — warehouses (multi-warehouse support, Managers only to
create), categories.
**Profile** — name editing, logout. Role is set at signup and shown
read-only here — self-service role changes would defeat the access
control above.

Dynamic filters (status, warehouse, type) are on every operations list, and
products support SKU / name search, matching the brief's dashboard filters.

## Project structure

```
stocksense/
├── backend/
│   ├── server.py      REST API + static file server (stdlib only)
│   ├── schema.py       SQLite schema + seed data
│   └── stocksense.db   created on first run
├── frontend/
│   ├── index.html
│   ├── style.css       design system (tokens, layout, components)
│   └── app.js          SPA: router, API client, all pages
└── README.md
```

## Design notes

The UI borrows the operational shape of a real inventory system — sidebar
navigation grouped by *Overview / Catalog / Operations / Setup*, KPI cards,
filterable document lists, status badges through the same lifecycle named
in the brief. Palette is a charcoal-navy structure with a safety-amber
accent (nod to warehouse signage), IBM Plex Mono for SKUs/quantities so
numbers stay easy to scan in tables.

## Suggested demo flow (2–3 min)

1. Log in as **Demo Manager** → point out the dashboard KPIs and the
   "Needs reorder" panel.
2. Products → open "Steel Rods", show per-warehouse stock is 0.
3. Create a **Receipt** for 100 kg Steel Rods into Main Warehouse → Validate
   → stock jumps to 100 (dashboard KPI and reorder panel update too).
4. Create an **Internal Transfer** of 20 kg to Production Floor → Validate
   → stock splits across both locations.
5. Try a **Delivery** for more than what's available → show the guardrail
   that blocks over-delivery.
6. Do a **Stock Adjustment** (e.g. count 75 after "3kg damaged") → Validate.
7. Open **Move History** → show the ledger trail, then hit **Export CSV**.
8. Log out, log back in as **Demo Staff** (`staff@stocksense.io` /
   `staff1234`) → show Products is view-only and there's no "+ New
   Warehouse" button, while Receipts/Deliveries/Transfers/Adjustments are
   still fully usable.

## Possible extensions (good "what's next" talking points for judges)

- Barcode/SKU scanning on receipt & pick screens.
- Real email/SMS delivery for OTP and low-stock alerts.
- Per-warehouse role scoping (a Warehouse Staff account tied to one site).
- Swap SQLite for Postgres and add multi-user concurrency handling for a
  production deployment.
