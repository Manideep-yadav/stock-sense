"""
StockSense — database schema & seed data.
Pure sqlite3 (Python stdlib) — no external dependencies required.
"""

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'Inventory Manager',
    otp TEXT,
    otp_expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS warehouses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    location TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    sku TEXT UNIQUE NOT NULL,
    category_id INTEGER,
    uom TEXT NOT NULL DEFAULT 'unit',
    reorder_min INTEGER NOT NULL DEFAULT 0,
    reorder_max INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (category_id) REFERENCES categories(id)
);

CREATE TABLE IF NOT EXISTS stock (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    warehouse_id INTEGER NOT NULL,
    quantity REAL NOT NULL DEFAULT 0,
    UNIQUE(product_id, warehouse_id),
    FOREIGN KEY (product_id) REFERENCES products(id),
    FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)
);

-- documents cover Receipts, Delivery Orders, Internal Transfers, Adjustments
CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reference TEXT UNIQUE NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('receipt','delivery','internal','adjustment')),
    status TEXT NOT NULL DEFAULT 'Draft' CHECK(status IN ('Draft','Waiting','Ready','Done','Canceled')),
    partner TEXT,
    source_warehouse_id INTEGER,
    dest_warehouse_id INTEGER,
    notes TEXT,
    created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    validated_at TEXT,
    FOREIGN KEY (source_warehouse_id) REFERENCES warehouses(id),
    FOREIGN KEY (dest_warehouse_id) REFERENCES warehouses(id),
    FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS document_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    quantity REAL NOT NULL,
    counted_quantity REAL,
    FOREIGN KEY (document_id) REFERENCES documents(id),
    FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE TABLE IF NOT EXISTS stock_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    warehouse_id INTEGER NOT NULL,
    change_qty REAL NOT NULL,
    balance_after REAL NOT NULL,
    doc_type TEXT,
    doc_reference TEXT,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (product_id) REFERENCES products(id),
    FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)
);
"""

SEED_WAREHOUSES = [
    ("Main Warehouse", "Building A, Ground Floor"),
    ("Production Floor", "Building B"),
]

SEED_CATEGORIES = ["Raw Materials", "Finished Goods", "Components"]

SEED_PRODUCTS = [
    # name, sku, category, uom, reorder_min, reorder_max
    ("Steel Rods", "RM-001", "Raw Materials", "kg", 50, 500),
    ("Steel Sheets", "RM-002", "Raw Materials", "kg", 30, 300),
    ("Office Chair", "FG-001", "Finished Goods", "unit", 10, 100),
    ("Wooden Frame", "FG-002", "Finished Goods", "unit", 5, 80),
    ("Caster Wheel", "CP-001", "Components", "unit", 20, 200),
]
