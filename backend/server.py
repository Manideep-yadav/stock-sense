#!/usr/bin/env python3
"""
StockSense — Inventory Management System backend.

Zero external dependencies: uses only the Python standard library
(http.server + sqlite3), so it runs anywhere `python3` is installed.

Run:
    python3 server.py
Then open:
    http://localhost:8000
"""

import json
import re
import secrets
import sqlite3
import hashlib
import random
import string
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from schema import SCHEMA, SEED_WAREHOUSES, SEED_CATEGORIES, SEED_PRODUCTS

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "stocksense.db"
FRONTEND_DIR = BASE_DIR.parent / "frontend"
PORT = 8000

# ------------------------------------------------------------------- roles

MANAGER_ROLE = "Inventory Manager"
STAFF_ROLE = "Warehouse Staff"
VALID_ROLES = {MANAGER_ROLE, STAFF_ROLE}

SESSION_LIFETIME_HOURS = 24
PBKDF2_ITERATIONS = 260_000

# ---------------------------------------------------------------- database

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    fresh = not DB_PATH.exists()
    conn = get_db()
    conn.executescript(SCHEMA)
    conn.commit()
    migrate(conn)
    if fresh:
        seed(conn)
    conn.close()


def migrate(conn):
    """Bring a database created by an older version of schema.py up to date,
    so upgrading the code doesn't require deleting stocksense.db."""
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(sessions)")]
    if "expires_at" not in cols:
        conn.execute("ALTER TABLE sessions ADD COLUMN expires_at TEXT")
    conn.commit()


def seed(conn):
    cur = conn.cursor()
    for name, location in SEED_WAREHOUSES:
        cur.execute("INSERT INTO warehouses (name, location) VALUES (?,?)", (name, location))
    for name in SEED_CATEGORIES:
        cur.execute("INSERT INTO categories (name) VALUES (?)", (name,))
    cat_ids = {r["name"]: r["id"] for r in cur.execute("SELECT id, name FROM categories")}
    wh_ids = [r["id"] for r in cur.execute("SELECT id FROM warehouses ORDER BY id")]
    for name, sku, cat, uom, rmin, rmax in SEED_PRODUCTS:
        cur.execute(
            "INSERT INTO products (name, sku, category_id, uom, reorder_min, reorder_max) VALUES (?,?,?,?,?,?)",
            (name, sku, cat_ids[cat], uom, rmin, rmax),
        )
        pid = cur.lastrowid
        cur.execute("INSERT INTO stock (product_id, warehouse_id, quantity) VALUES (?,?,?)", (pid, wh_ids[0], 0))
        cur.execute("INSERT INTO stock (product_id, warehouse_id, quantity) VALUES (?,?,?)", (pid, wh_ids[1], 0))
    # demo users — one per role, so the role split is demoable immediately
    cur.execute(
        "INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)",
        ("Demo Manager", "demo@stocksense.io", hash_pw("demo1234"), MANAGER_ROLE),
    )
    cur.execute(
        "INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)",
        ("Demo Staff", "staff@stocksense.io", hash_pw("staff1234"), STAFF_ROLE),
    )
    conn.commit()


def hash_pw(pw: str) -> str:
    """Salted PBKDF2-HMAC-SHA256. Stored as algo$iterations$salt$hash so the
    iteration count and salt travel with the hash and can change over time."""
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), PBKDF2_ITERATIONS).hex()
    return f"pbkdf2${PBKDF2_ITERATIONS}${salt}${digest}"


def verify_pw(pw: str, stored: str) -> tuple[bool, bool]:
    """Check a password against a stored hash.
    Returns (is_valid, needs_upgrade). Supports the legacy unsalted-SHA256
    hashes from earlier builds so existing accounts keep working; a
    successful legacy login is transparently upgraded to PBKDF2 by the
    caller instead of forcing a password reset."""
    if stored.startswith("pbkdf2$"):
        try:
            _, iterations, salt, digest = stored.split("$")
            check = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), int(iterations)).hex()
        except ValueError:
            return False, False
        return secrets.compare_digest(check, digest), False
    legacy = hashlib.sha256(pw.encode()).hexdigest()
    return secrets.compare_digest(legacy, stored), True


def next_reference(conn, prefix):
    row = conn.execute(
        "SELECT reference FROM documents WHERE reference LIKE ? ORDER BY id DESC LIMIT 1", (f"{prefix}%",)
    ).fetchone()
    n = int(row["reference"].split("-")[-1]) + 1 if row else 1
    return f"{prefix}-{n:04d}"


DOC_PREFIX = {"receipt": "REC", "delivery": "DEL", "internal": "INT", "adjustment": "ADJ"}

# ------------------------------------------------------------------ errors

class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def require(condition, status, message):
    if not condition:
        raise ApiError(status, message)


# ------------------------------------------------------------------- auth

def current_user(conn, headers):
    auth = headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise ApiError(401, "Missing or invalid Authorization header")
    token = auth[7:]
    row = conn.execute(
        "SELECT u.*, s.expires_at session_expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?",
        (token,),
    ).fetchone()
    require(row, 401, "Session expired — please log in again")
    expires_at = row["session_expires_at"]
    if expires_at and expires_at < datetime.now(timezone.utc).isoformat():
        conn.execute("DELETE FROM sessions WHERE token=?", (token,))
        conn.commit()
        raise ApiError(401, "Session expired — please log in again")
    return row


def require_role(user, *allowed_roles):
    require(user["role"] in allowed_roles, 403, f"This action requires the {allowed_roles[0]} role")


EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

# --------------------------------------------------------------- handlers
# Each handler: (method, path_regex) -> function(conn, user_or_None, match, body, qs)

def h_signup(conn, _user, _m, body, _qs):
    name, email, pw = body.get("name", "").strip(), body.get("email", "").strip().lower(), body.get("password", "")
    # Default to the lower-privilege role: a missing/blank role must never
    # silently grant Inventory Manager access.
    role = (body.get("role") or STAFF_ROLE).strip()
    require(name and email and pw, 400, "Name, email and password are required")
    require(EMAIL_RE.match(email), 400, "Enter a valid email address")
    require(len(pw) >= 6, 400, "Password must be at least 6 characters")
    require(role in VALID_ROLES, 400, "Choose a valid role")
    existing = conn.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone()
    require(not existing, 409, "An account with this email already exists")
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)",
        (name, email, hash_pw(pw), role),
    )
    conn.commit()
    return {"message": "Account created — you can now log in"}


def h_login(conn, _user, _m, body, _qs):
    email, pw = body.get("email", "").strip().lower(), body.get("password", "")
    row = conn.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
    # Same generic error whether the email is unknown or the password is
    # wrong, so login can't be used to enumerate registered accounts.
    require(row, 401, "Incorrect email or password")
    valid, needs_upgrade = verify_pw(pw, row["password_hash"])
    require(valid, 401, "Incorrect email or password")
    if needs_upgrade:
        conn.execute("UPDATE users SET password_hash=? WHERE id=?", (hash_pw(pw), row["id"]))
    token = secrets.token_hex(24)
    expires_at = (datetime.now(timezone.utc) + timedelta(hours=SESSION_LIFETIME_HOURS)).isoformat()
    conn.execute("INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)", (token, row["id"], expires_at))
    conn.commit()
    return {"token": token, "user": {"id": row["id"], "name": row["name"], "email": row["email"], "role": row["role"]}}


def h_forgot_password(conn, _user, _m, body, _qs):
    email = body.get("email", "").strip().lower()
    row = conn.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone()
    require(row, 404, "No account found with that email")
    otp = "".join(random.choices(string.digits, k=6))
    expires = (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()
    conn.execute("UPDATE users SET otp=?, otp_expires_at=? WHERE id=?", (otp, expires, row["id"]))
    conn.commit()
    # No email service in this environment — OTP is returned directly so the
    # flow can be demoed end-to-end. In production this would be emailed/SMS'd.
    return {"message": "OTP generated", "demo_otp": otp}


def h_reset_password(conn, _user, _m, body, _qs):
    email = body.get("email", "").strip().lower()
    otp, new_pw = body.get("otp", ""), body.get("new_password", "")
    require(new_pw and len(new_pw) >= 6, 400, "New password must be at least 6 characters")
    row = conn.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
    require(row, 404, "No account found with that email")
    require(row["otp"] == otp and row["otp"], 400, "Incorrect OTP")
    require(datetime.now(timezone.utc).isoformat() < (row["otp_expires_at"] or ""), 400, "OTP has expired")
    conn.execute("UPDATE users SET password_hash=?, otp=NULL, otp_expires_at=NULL WHERE id=?", (hash_pw(new_pw), row["id"]))
    conn.commit()
    return {"message": "Password reset — you can now log in"}


def h_profile_get(conn, user, _m, _b, _qs):
    return {"id": user["id"], "name": user["name"], "email": user["email"], "role": user["role"]}


def h_profile_put(conn, user, _m, body, _qs):
    # Role is deliberately not editable here — letting a user grant
    # themselves Inventory Manager access via their own profile form would
    # defeat the role check on every other endpoint.
    name = body.get("name", user["name"]).strip()
    require(name, 400, "Name is required")
    conn.execute("UPDATE users SET name=? WHERE id=?", (name, user["id"]))
    conn.commit()
    return {"message": "Profile updated"}


def h_dashboard(conn, _user, _m, _b, _qs):
    total_products = conn.execute("SELECT COUNT(*) c FROM products").fetchone()["c"]
    low_stock = conn.execute("""
        SELECT p.id, p.name, p.sku, p.reorder_min, s.qty FROM products p JOIN
        (SELECT product_id, SUM(quantity) qty FROM stock GROUP BY product_id) s ON s.product_id = p.id
        WHERE s.qty <= p.reorder_min
        ORDER BY (s.qty - p.reorder_min) ASC
    """).fetchall()
    out_of_stock = conn.execute("""
        SELECT p.id FROM products p JOIN
        (SELECT product_id, SUM(quantity) qty FROM stock GROUP BY product_id) s ON s.product_id = p.id
        WHERE s.qty <= 0
    """).fetchall()
    def pending(doc_type):
        return conn.execute(
            "SELECT COUNT(*) c FROM documents WHERE type=? AND status NOT IN ('Done','Canceled')", (doc_type,)
        ).fetchone()["c"]
    recent = conn.execute("SELECT * FROM documents ORDER BY created_at DESC LIMIT 6").fetchall()
    return {
        "total_products": total_products,
        "low_stock_count": len(low_stock),
        # Capped for the dashboard panel — the count above stays exact,
        # the full list is still one click away on the Products page.
        "low_stock_items": [
            {"id": r["id"], "name": r["name"], "sku": r["sku"], "quantity": r["qty"], "reorder_min": r["reorder_min"]}
            for r in low_stock[:8]
        ],
        "out_of_stock_count": len(out_of_stock),
        "pending_receipts": pending("receipt"),
        "pending_deliveries": pending("delivery"),
        "pending_transfers": pending("internal"),
        "recent_documents": [dict(r) for r in recent],
    }


# --- warehouses ---

def h_warehouses_list(conn, _u, _m, _b, _qs):
    return [dict(r) for r in conn.execute("SELECT * FROM warehouses ORDER BY id")]


def h_warehouses_create(conn, user, _m, body, _qs):
    require_role(user, MANAGER_ROLE)
    name = body.get("name", "").strip()
    require(name, 400, "Warehouse name is required")
    cur = conn.cursor()
    cur.execute("INSERT INTO warehouses (name, location) VALUES (?,?)", (name, body.get("location", "").strip()))
    conn.commit()
    return {"id": cur.lastrowid}


# --- categories ---

def h_categories_list(conn, _u, _m, _b, _qs):
    return [dict(r) for r in conn.execute("SELECT * FROM categories ORDER BY name")]


def h_categories_create(conn, user, _m, body, _qs):
    require_role(user, MANAGER_ROLE)
    name = body.get("name", "").strip()
    require(name, 400, "Category name is required")
    cur = conn.cursor()
    try:
        cur.execute("INSERT INTO categories (name) VALUES (?)", (name,))
    except sqlite3.IntegrityError:
        raise ApiError(409, "Category already exists")
    conn.commit()
    return {"id": cur.lastrowid}


# --- products ---

def product_dict(conn, row):
    d = dict(row)
    stocks = conn.execute(
        "SELECT w.name warehouse, s.warehouse_id, s.quantity FROM stock s JOIN warehouses w ON w.id=s.warehouse_id WHERE product_id=?",
        (row["id"],),
    ).fetchall()
    d["stock_by_warehouse"] = [dict(s) for s in stocks]
    d["total_stock"] = sum(s["quantity"] for s in stocks)
    cat = conn.execute("SELECT name FROM categories WHERE id=?", (row["category_id"],)).fetchone()
    d["category_name"] = cat["name"] if cat else None
    return d


def h_products_list(conn, _u, _m, _b, qs):
    search = (qs.get("q", [""])[0] or "").strip().lower()
    rows = conn.execute("SELECT * FROM products ORDER BY name").fetchall()
    products = [product_dict(conn, r) for r in rows]
    if search:
        products = [p for p in products if search in p["name"].lower() or search in p["sku"].lower()]
    return products


def clean_category_id(value):
    """Empty string / missing -> NULL, otherwise cast to int."""
    if value in (None, "", "null"):
        return None
    return int(value)


def h_products_create(conn, user, _m, body, _qs):
    require_role(user, MANAGER_ROLE)
    name, sku = body.get("name", "").strip(), body.get("sku", "").strip()
    require(name and sku, 400, "Product name and SKU are required")
    category_id = clean_category_id(body.get("category_id"))
    cur = conn.cursor()
    existing = conn.execute("SELECT id FROM products WHERE sku=?", (sku,)).fetchone()
    require(not existing, 409, "A product with this SKU already exists")
    try:
        cur.execute(
            "INSERT INTO products (name, sku, category_id, uom, reorder_min, reorder_max) VALUES (?,?,?,?,?,?)",
            (name, sku, category_id, body.get("uom", "unit"), body.get("reorder_min", 0), body.get("reorder_max", 0)),
        )
    except sqlite3.IntegrityError as e:
        raise ApiError(400, f"Could not create product: {e}")
    pid = cur.lastrowid
    initial_stock = float(body.get("initial_stock", 0) or 0)
    for w in conn.execute("SELECT id FROM warehouses"):
        qty = initial_stock if w["id"] == (body.get("warehouse_id") or w["id"]) and initial_stock else 0
        cur.execute("INSERT INTO stock (product_id, warehouse_id, quantity) VALUES (?,?,?)", (pid, w["id"], qty))
    conn.commit()
    return {"id": pid}


def h_products_update(conn, user, m, body, _qs):
    require_role(user, MANAGER_ROLE)
    pid = int(m.group(1))
    row = conn.execute("SELECT * FROM products WHERE id=?", (pid,)).fetchone()
    require(row, 404, "Product not found")
    fields = ["name", "sku", "category_id", "uom", "reorder_min", "reorder_max"]
    updated = {f: body.get(f, row[f]) for f in fields}
    updated["category_id"] = clean_category_id(updated["category_id"])
    new_sku = (updated["sku"] or "").strip()
    require(updated["name"] and new_sku, 400, "Product name and SKU are required")
    dupe = conn.execute("SELECT id FROM products WHERE sku=? AND id!=?", (new_sku, pid)).fetchone()
    require(not dupe, 409, "Another product already uses this SKU")
    conn.execute(
        "UPDATE products SET name=?, sku=?, category_id=?, uom=?, reorder_min=?, reorder_max=? WHERE id=?",
        (updated["name"], new_sku, updated["category_id"], updated["uom"], updated["reorder_min"], updated["reorder_max"], pid),
    )
    conn.commit()
    return {"message": "Product updated"}


def h_products_delete(conn, user, m, _b, _qs):
    require_role(user, MANAGER_ROLE)
    pid = int(m.group(1))
    in_use = conn.execute("SELECT COUNT(*) c FROM document_lines WHERE product_id=?", (pid,)).fetchone()["c"]
    require(not in_use, 409, "Cannot delete a product referenced in existing documents")
    conn.execute("DELETE FROM stock WHERE product_id=?", (pid,))
    conn.execute("DELETE FROM products WHERE id=?", (pid,))
    conn.commit()
    return {"message": "Product deleted"}


# --- documents (receipts / deliveries / internal transfers / adjustments) ---

def doc_dict(conn, row):
    d = dict(row)
    lines = conn.execute(
        """SELECT dl.*, p.name product_name, p.sku, p.uom FROM document_lines dl
           JOIN products p ON p.id = dl.product_id WHERE document_id=?""",
        (row["id"],),
    ).fetchall()
    d["lines"] = [dict(l) for l in lines]
    if row["source_warehouse_id"]:
        d["source_warehouse"] = conn.execute("SELECT name FROM warehouses WHERE id=?", (row["source_warehouse_id"],)).fetchone()["name"]
    if row["dest_warehouse_id"]:
        d["dest_warehouse"] = conn.execute("SELECT name FROM warehouses WHERE id=?", (row["dest_warehouse_id"],)).fetchone()["name"]
    return d


def h_documents_list(conn, _u, _m, _b, qs):
    doc_type = qs.get("type", [None])[0]
    status = qs.get("status", [None])[0]
    warehouse_id = qs.get("warehouse_id", [None])[0]
    sql = "SELECT * FROM documents WHERE 1=1"
    params = []
    if doc_type:
        sql += " AND type=?"; params.append(doc_type)
    if status:
        sql += " AND status=?"; params.append(status)
    if warehouse_id:
        sql += " AND (source_warehouse_id=? OR dest_warehouse_id=?)"; params += [warehouse_id, warehouse_id]
    sql += " ORDER BY id DESC"
    rows = conn.execute(sql, params).fetchall()
    return [doc_dict(conn, r) for r in rows]


def h_documents_get(conn, _u, m, _b, _qs):
    row = conn.execute("SELECT * FROM documents WHERE id=?", (int(m.group(1)),)).fetchone()
    require(row, 404, "Document not found")
    return doc_dict(conn, row)


def h_documents_create(conn, user, m, body, _qs):
    doc_type = m.group(1)
    require(doc_type in DOC_PREFIX, 400, "Unknown document type")
    lines = body.get("lines", [])
    require(lines, 400, "Add at least one product line")
    src, dest = body.get("source_warehouse_id"), body.get("dest_warehouse_id")
    if doc_type == "receipt":
        require(dest, 400, "Destination warehouse is required")
    elif doc_type == "delivery":
        require(src, 400, "Source warehouse is required")
    elif doc_type == "internal":
        require(src and dest and src != dest, 400, "Choose two different warehouses")
    elif doc_type == "adjustment":
        require(src, 400, "Warehouse is required")
    cur = conn.cursor()
    ref = next_reference(conn, DOC_PREFIX[doc_type])
    cur.execute(
        """INSERT INTO documents (reference, type, status, partner, source_warehouse_id, dest_warehouse_id, notes, created_by)
           VALUES (?,?,?,?,?,?,?,?)""",
        (ref, doc_type, "Draft", body.get("partner", ""), src, dest, body.get("notes", ""), user["id"]),
    )
    doc_id = cur.lastrowid
    for line in lines:
        require(line.get("product_id") and float(line.get("quantity", 0)) != 0 or doc_type == "adjustment",
                400, "Each line needs a product and quantity")
        cur.execute(
            "INSERT INTO document_lines (document_id, product_id, quantity, counted_quantity) VALUES (?,?,?,?)",
            (doc_id, line["product_id"], line.get("quantity", 0), line.get("counted_quantity")),
        )
    conn.commit()
    return {"id": doc_id, "reference": ref}


def h_documents_set_status(conn, _u, m, body, _qs):
    doc_id = int(m.group(1))
    row = conn.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone()
    require(row, 404, "Document not found")
    require(row["status"] not in ("Done", "Canceled"), 409, "This document is already finalized")
    new_status = body.get("status")
    require(new_status in ("Draft", "Waiting", "Ready", "Canceled"), 400, "Invalid status")
    conn.execute("UPDATE documents SET status=? WHERE id=?", (new_status, doc_id))
    conn.commit()
    return {"message": f"Marked {new_status}"}


def adjust_stock(conn, product_id, warehouse_id, delta, doc_type, reference, note=""):
    row = conn.execute("SELECT quantity FROM stock WHERE product_id=? AND warehouse_id=?", (product_id, warehouse_id)).fetchone()
    if row is None:
        conn.execute("INSERT INTO stock (product_id, warehouse_id, quantity) VALUES (?,?,0)", (product_id, warehouse_id))
        current = 0
    else:
        current = row["quantity"]
    new_qty = current + delta
    conn.execute("UPDATE stock SET quantity=? WHERE product_id=? AND warehouse_id=?", (new_qty, product_id, warehouse_id))
    conn.execute(
        """INSERT INTO stock_ledger (product_id, warehouse_id, change_qty, balance_after, doc_type, doc_reference, note)
           VALUES (?,?,?,?,?,?,?)""",
        (product_id, warehouse_id, delta, new_qty, doc_type, reference, note),
    )


def h_documents_validate(conn, _u, m, _b, _qs):
    doc_id = int(m.group(1))
    row = conn.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone()
    require(row, 404, "Document not found")
    require(row["status"] != "Done", 409, "Already validated")
    require(row["status"] != "Canceled", 409, "This document was canceled")
    lines = conn.execute("SELECT * FROM document_lines WHERE document_id=?", (doc_id,)).fetchall()
    doc_type, ref = row["type"], row["reference"]
    if doc_type == "receipt":
        for l in lines:
            adjust_stock(conn, l["product_id"], row["dest_warehouse_id"], l["quantity"], doc_type, ref)
    elif doc_type == "delivery":
        for l in lines:
            available = conn.execute(
                "SELECT quantity FROM stock WHERE product_id=? AND warehouse_id=?", (l["product_id"], row["source_warehouse_id"])
            ).fetchone()
            available_qty = available["quantity"] if available else 0
            require(available_qty >= l["quantity"], 409, "Not enough stock to deliver — insufficient quantity at source")
            adjust_stock(conn, l["product_id"], row["source_warehouse_id"], -l["quantity"], doc_type, ref)
    elif doc_type == "internal":
        for l in lines:
            available = conn.execute(
                "SELECT quantity FROM stock WHERE product_id=? AND warehouse_id=?", (l["product_id"], row["source_warehouse_id"])
            ).fetchone()
            available_qty = available["quantity"] if available else 0
            require(available_qty >= l["quantity"], 409, "Not enough stock at source warehouse for this transfer")
            adjust_stock(conn, l["product_id"], row["source_warehouse_id"], -l["quantity"], doc_type, ref, "Transfer out")
            adjust_stock(conn, l["product_id"], row["dest_warehouse_id"], l["quantity"], doc_type, ref, "Transfer in")
    elif doc_type == "adjustment":
        for l in lines:
            current = conn.execute(
                "SELECT quantity FROM stock WHERE product_id=? AND warehouse_id=?", (l["product_id"], row["source_warehouse_id"])
            ).fetchone()
            current_qty = current["quantity"] if current else 0
            counted = l["counted_quantity"] if l["counted_quantity"] is not None else l["quantity"]
            delta = counted - current_qty
            if delta:
                adjust_stock(conn, l["product_id"], row["source_warehouse_id"], delta, doc_type, ref, "Physical count adjustment")
    conn.execute("UPDATE documents SET status='Done', validated_at=datetime('now') WHERE id=?", (doc_id,))
    conn.commit()
    return {"message": "Validated — stock updated"}


# --- ledger / move history ---

def h_ledger_list(conn, _u, _m, _b, qs):
    product_id = qs.get("product_id", [None])[0]
    warehouse_id = qs.get("warehouse_id", [None])[0]
    sql = """SELECT l.*, p.name product_name, p.sku, w.name warehouse_name FROM stock_ledger l
             JOIN products p ON p.id=l.product_id JOIN warehouses w ON w.id=l.warehouse_id WHERE 1=1"""
    params = []
    if product_id:
        sql += " AND l.product_id=?"; params.append(product_id)
    if warehouse_id:
        sql += " AND l.warehouse_id=?"; params.append(warehouse_id)
    sql += " ORDER BY l.id DESC LIMIT 300"
    return [dict(r) for r in conn.execute(sql, params)]


# ------------------------------------------------------------------ routes

ROUTES = [
    ("POST", r"^/api/auth/signup$", h_signup, False),
    ("POST", r"^/api/auth/login$", h_login, False),
    ("POST", r"^/api/auth/forgot-password$", h_forgot_password, False),
    ("POST", r"^/api/auth/reset-password$", h_reset_password, False),
    ("GET", r"^/api/profile$", h_profile_get, True),
    ("PUT", r"^/api/profile$", h_profile_put, True),
    ("GET", r"^/api/dashboard$", h_dashboard, True),
    ("GET", r"^/api/warehouses$", h_warehouses_list, True),
    ("POST", r"^/api/warehouses$", h_warehouses_create, True),
    ("GET", r"^/api/categories$", h_categories_list, True),
    ("POST", r"^/api/categories$", h_categories_create, True),
    ("GET", r"^/api/products$", h_products_list, True),
    ("POST", r"^/api/products$", h_products_create, True),
    ("PUT", r"^/api/products/(\d+)$", h_products_update, True),
    ("DELETE", r"^/api/products/(\d+)$", h_products_delete, True),
    ("GET", r"^/api/documents$", h_documents_list, True),
    ("GET", r"^/api/documents/(\d+)$", h_documents_get, True),
    ("POST", r"^/api/documents/(receipt|delivery|internal|adjustment)$", h_documents_create, True),
    ("POST", r"^/api/documents/(\d+)/status$", h_documents_set_status, True),
    ("POST", r"^/api/documents/(\d+)/validate$", h_documents_validate, True),
    ("GET", r"^/api/ledger$", h_ledger_list, True),
]

MIME = {".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".json": "application/json"}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # keep console clean

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def _serve_static(self, path):
        if path == "/":
            path = "/index.html"
        file_path = (FRONTEND_DIR / path.lstrip("/")).resolve()
        if FRONTEND_DIR not in file_path.parents and file_path != FRONTEND_DIR:
            self.send_response(403); self.end_headers(); return
        if not file_path.exists():
            file_path = FRONTEND_DIR / "index.html"  # SPA fallback
        data = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(file_path.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _dispatch(self, method):
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/api/"):
            return self._serve_static(parsed.path)
        qs = parse_qs(parsed.query)
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            return self._send_json(400, {"error": "Malformed JSON body"})

        for m_method, pattern, fn, needs_auth in ROUTES:
            if m_method != method:
                continue
            match = re.match(pattern, parsed.path)
            if not match:
                continue
            conn = get_db()
            try:
                user = current_user(conn, self.headers) if needs_auth else None
                result = fn(conn, user, match, body, qs)
                return self._send_json(200, result)
            except ApiError as e:
                return self._send_json(e.status, {"error": e.message})
            except Exception as e:  # pragma: no cover
                return self._send_json(500, {"error": f"Server error: {e}"})
            finally:
                conn.close()
        self._send_json(404, {"error": "Not found"})

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.end_headers()


if __name__ == "__main__":
    init_db()
    print(f"StockSense running at http://localhost:{PORT}")
    print("Demo login -> email: demo@stocksense.io   password: demo1234")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
