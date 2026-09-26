/* ==================================================================
   StockSense — single-page app (vanilla JS, no build step).
   Talks to the Python backend over the same-origin /api/* REST API.
================================================================== */

const S = {
  token: localStorage.getItem("ss_token") || null,
  user: JSON.parse(localStorage.getItem("ss_user") || "null"),
  warehouses: [],
  categories: [],
  resetEmail: null,
};

const $app = document.getElementById("app");

// ---------------------------------------------------------------- API

async function api(method, path, body) {
  const headers = { "Content-Type": "application/json" };
  if (S.token) headers.Authorization = "Bearer " + S.token;
  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* empty body */ }
  if (!res.ok) {
    if (res.status === 401 && path !== "/api/auth/login") logout(false);
    throw new Error(data.error || "Something went wrong");
  }
  return data;
}

function login(token, user) {
  S.token = token; S.user = user;
  localStorage.setItem("ss_token", token);
  localStorage.setItem("ss_user", JSON.stringify(user));
}
function logout(redirect = true) {
  S.token = null; S.user = null;
  localStorage.removeItem("ss_token"); localStorage.removeItem("ss_user");
  if (redirect) location.hash = "#/login";
  render();
}

// ---------------------------------------------------------------- toast

function toast(msg, kind = "") {
  const box = document.getElementById("toast") || (() => {
    const d = document.createElement("div"); d.id = "toast"; document.body.appendChild(d); return d;
  })();
  const item = document.createElement("div");
  item.className = "toast-item " + (kind === "error" ? "err" : kind === "ok" ? "ok" : "");
  item.textContent = msg;
  box.appendChild(item);
  setTimeout(() => item.remove(), 3200);
}

function fmtDate(s) {
  if (!s) return "—";
  const d = new Date(s.replace(" ", "T") + "Z");
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short" }) + " " +
         d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
function initials(name) {
  return (name || "?").split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase();
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function isManager() {
  return !!(S.user && S.user.role === "Inventory Manager");
}

// ---------------------------------------------------------------- router

const ROUTES = {
  "/login": pageLogin,
  "/signup": pageSignup,
  "/forgot": pageForgot,
  "/reset": pageReset,
  "/dashboard": pageDashboard,
  "/products": pageProducts,
  "/receipts": (slot) => pageDocuments("receipt", slot),
  "/deliveries": (slot) => pageDocuments("delivery", slot),
  "/transfers": (slot) => pageDocuments("internal", slot),
  "/adjustments": (slot) => pageDocuments("adjustment", slot),
  "/history": pageHistory,
  "/warehouses": pageWarehouses,
  "/profile": pageProfile,
};

const PUBLIC_ROUTES = ["/login", "/signup", "/forgot", "/reset"];

async function render() {
  let path = (location.hash || "#/dashboard").slice(1);
  if (!ROUTES[path]) path = S.token ? "/dashboard" : "/login";

  if (!S.token && !PUBLIC_ROUTES.includes(path)) {
    location.hash = "#/login"; return;
  }
  if (S.token && PUBLIC_ROUTES.includes(path)) {
    location.hash = "#/dashboard"; return;
  }

  if (PUBLIC_ROUTES.includes(path)) {
    $app.innerHTML = `<div class="auth-wrap"><div class="auth-card" id="auth-slot"></div></div>`;
    await ROUTES[path]();
    return;
  }

  if (!S.warehouses.length) {
    try { S.warehouses = await api("GET", "/api/warehouses"); } catch (e) {}
  }
  if (!S.categories.length) {
    try { S.categories = await api("GET", "/api/categories"); } catch (e) {}
  }

  $app.innerHTML = shell(path);
  const slot = document.getElementById("page-slot");
  slot.innerHTML = `<div class="empty-state">Loading…</div>`;
  try {
    await ROUTES[path](slot);
  } catch (e) {
    slot.innerHTML = `<div class="alert alert-danger">${esc(e.message)}</div>`;
  }
  bindNav();
}

window.addEventListener("hashchange", render);
window.addEventListener("DOMContentLoaded", render);

// ---------------------------------------------------------------- shell

const NAV = [
  { group: "Overview", items: [["/dashboard", "📊", "Dashboard"]] },
  { group: "Catalog", items: [["/products", "📦", "Products"]] },
  { group: "Operations", items: [
      ["/receipts", "⬇️", "Receipts"],
      ["/deliveries", "⬆️", "Delivery Orders"],
      ["/transfers", "↔️", "Internal Transfers"],
      ["/adjustments", "🛠️", "Inventory Adjustment"],
      ["/history", "📜", "Move History"],
  ]},
  { group: "Setup", items: [["/warehouses", "🏬", "Warehouses"]] },
];

function shell(activePath) {
  return `
  <div class="shell">
    <div class="sidebar-scrim" id="sidebar-scrim"></div>
    <aside class="sidebar" id="sidebar">
      <div class="brand"><span class="brand-mark">📦</span> StockSense</div>
      <nav>
        ${NAV.map(g => `
          <div class="nav-group-label">${g.group.toUpperCase()}</div>
          ${g.items.map(([href, ic, label]) => `
            <a class="nav-link ${activePath === href ? "active" : ""}" href="#${href}">
              <span class="ic">${ic}</span>${label}
            </a>`).join("")}
        `).join("")}
      </nav>
      <div class="sidebar-foot">
        <div class="user-chip" onclick="location.hash='#/profile'">
          <div class="avatar">${esc(initials(S.user?.name))}</div>
          <div class="who">${esc(S.user?.name || "")}<small>${esc(S.user?.role || "")}</small></div>
        </div>
        <div style="margin-top:10px;">
          <button class="btn btn-ghost btn-sm" style="color:#C7CDD6;width:100%;" onclick="logout()">⎋ Log out</button>
        </div>
      </div>
    </aside>
    <div class="main">
      <div class="topbar">
        <button class="btn btn-ghost btn-sm" id="menu-toggle" aria-label="Toggle menu">☰</button>
        <h1>${pageTitle(activePath)}</h1>
        <div class="spacer"></div>
      </div>
      <div class="content" id="page-slot"></div>
    </div>
  </div>`;
}

function pageTitle(path) {
  for (const g of NAV) for (const [href, , label] of g.items) if (href === path) return label;
  if (path === "/profile") return "My Profile";
  return "StockSense";
}

function bindNav() {
  const toggle = document.getElementById("menu-toggle");
  const sidebar = document.getElementById("sidebar");
  const scrim = document.getElementById("sidebar-scrim");
  const closeSidebar = () => { sidebar.classList.remove("open"); scrim.classList.remove("open"); };
  if (toggle) toggle.onclick = () => { sidebar.classList.toggle("open"); scrim.classList.toggle("open"); };
  if (scrim) scrim.onclick = closeSidebar;
  sidebar.querySelectorAll(".nav-link").forEach(a => a.addEventListener("click", closeSidebar));
}

// ================================================================== AUTH PAGES

function authShell(title, sub, bodyHtml) {
  document.getElementById("auth-slot").innerHTML = `
    <div class="auth-brand"><span class="brand-mark" style="background:var(--accent);border-radius:8px;width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;">📦</span> StockSense</div>
    <h2>${title}</h2>
    <p class="auth-sub">${sub}</p>
    ${bodyHtml}
  `;
}

async function pageLogin() {
  authShell("Welcome back", "Log in to manage your inventory.", `
    <form id="f-login">
      <div class="field"><label>Email</label><input type="email" name="email" required placeholder="you@company.com" value="demo@stocksense.io"></div>
      <div class="field"><label>Password</label><input type="password" name="password" required placeholder="••••••••" value="demo1234"></div>
      <div id="login-alert"></div>
      <button class="btn btn-accent" type="submit" style="width:100%;justify-content:center;">Log in</button>
    </form>
    <div class="auth-switch"><a href="#/forgot">Forgot password?</a></div>
    <div class="auth-switch">New here? <a href="#/signup">Create an account</a></div>
    <p class="text-muted" style="font-size:.75rem;margin-top:18px;text-align:center;">
      Demo Manager is pre-filled — just hit Log in.<br>
      Or try <b class="mono">staff@stocksense.io</b> / <b class="mono">staff1234</b> to see the Warehouse Staff view.
    </p>
  `);
  document.getElementById("f-login").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const data = await api("POST", "/api/auth/login", { email: f.get("email"), password: f.get("password") });
      login(data.token, data.user);
      location.hash = "#/dashboard";
    } catch (err) {
      document.getElementById("login-alert").innerHTML = `<div class="alert alert-danger">${esc(err.message)}</div>`;
    }
  };
}

async function pageSignup() {
  authShell("Create your account", "Set up StockSense for your warehouse team.", `
    <form id="f-signup">
      <div class="field"><label>Full name</label><input type="text" name="name" required placeholder="Jordan Lee"></div>
      <div class="field"><label>Email</label><input type="email" name="email" required placeholder="you@company.com"></div>
      <div class="field"><label>Password</label><input type="password" name="password" required minlength="6" placeholder="At least 6 characters"></div>
      <div class="field"><label>Role</label>
        <select name="role">
          <option value="Warehouse Staff">Warehouse Staff — receipts, deliveries, transfers, counts</option>
          <option value="Inventory Manager">Inventory Manager — full catalog &amp; warehouse setup</option>
        </select>
      </div>
      <div id="signup-alert"></div>
      <button class="btn btn-accent" type="submit" style="width:100%;justify-content:center;">Create account</button>
    </form>
    <div class="auth-switch">Already have an account? <a href="#/login">Log in</a></div>
  `);
  document.getElementById("f-signup").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api("POST", "/api/auth/signup", { name: f.get("name"), email: f.get("email"), password: f.get("password"), role: f.get("role") });
      toast("Account created — log in to continue", "ok");
      location.hash = "#/login";
    } catch (err) {
      document.getElementById("signup-alert").innerHTML = `<div class="alert alert-danger">${esc(err.message)}</div>`;
    }
  };
}

async function pageForgot() {
  authShell("Reset your password", "Enter your email — we'll generate a one-time code.", `
    <form id="f-forgot">
      <div class="field"><label>Email</label><input type="email" name="email" required placeholder="you@company.com"></div>
      <div id="forgot-alert"></div>
      <button class="btn btn-accent" type="submit" style="width:100%;justify-content:center;">Send OTP</button>
    </form>
    <div class="auth-switch"><a href="#/login">Back to log in</a></div>
  `);
  document.getElementById("f-forgot").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const data = await api("POST", "/api/auth/forgot-password", { email: f.get("email") });
      S.resetEmail = f.get("email");
      toast(`Demo OTP: ${data.demo_otp} (no email service in this sandbox)`, "ok");
      location.hash = "#/reset";
    } catch (err) {
      document.getElementById("forgot-alert").innerHTML = `<div class="alert alert-danger">${esc(err.message)}</div>`;
    }
  };
}

async function pageReset() {
  if (!S.resetEmail) { location.hash = "#/forgot"; return; }
  authShell("Enter new password", `Code sent for ${esc(S.resetEmail)}.`, `
    <form id="f-reset">
      <div class="field"><label>6-digit OTP</label><input type="text" name="otp" maxlength="6" required placeholder="123456"></div>
      <div class="field"><label>New password</label><input type="password" name="new_password" required minlength="6" placeholder="At least 6 characters"></div>
      <div id="reset-alert"></div>
      <button class="btn btn-accent" type="submit" style="width:100%;justify-content:center;">Reset password</button>
    </form>
    <div class="auth-switch"><a href="#/login">Back to log in</a></div>
  `);
  document.getElementById("f-reset").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api("POST", "/api/auth/reset-password", { email: S.resetEmail, otp: f.get("otp"), new_password: f.get("new_password") });
      toast("Password reset — log in with your new password", "ok");
      S.resetEmail = null;
      location.hash = "#/login";
    } catch (err) {
      document.getElementById("reset-alert").innerHTML = `<div class="alert alert-danger">${esc(err.message)}</div>`;
    }
  };
}

// ================================================================== DASHBOARD

async function pageDashboard(slot) {
  const d = await api("GET", "/api/dashboard");
  slot.innerHTML = `
    <div class="grid kpi-grid">
      ${kpi("Total Products", d.total_products, "")}
      ${kpi("Low Stock Items", d.low_stock_count, d.low_stock_count ? "warn" : "")}
      ${kpi("Out of Stock", d.out_of_stock_count, d.out_of_stock_count ? "danger" : "")}
      ${kpi("Pending Receipts", d.pending_receipts, "")}
      ${kpi("Pending Deliveries", d.pending_deliveries, "")}
      ${kpi("Transfers Scheduled", d.pending_transfers, "")}
    </div>
    ${d.low_stock_items.length ? `
    <div class="table-wrap" style="margin-bottom:20px;">
      <div style="padding:16px 18px 4px;"><h2 style="font-size:1rem;">Needs reorder</h2></div>
      <table>
        <thead><tr><th>Product</th><th>SKU</th><th>In stock</th><th>Reorder min</th><th></th></tr></thead>
        <tbody>
          ${d.low_stock_items.map(p => `
            <tr style="cursor:pointer" onclick="location.hash='#/products'">
              <td>${esc(p.name)}</td>
              <td class="mono">${esc(p.sku)}</td>
              <td class="mono" style="color:${p.quantity <= 0 ? "var(--danger)" : "var(--accent-ink)"}">${p.quantity}</td>
              <td class="text-muted">${p.reorder_min}</td>
              <td><span class="badge ${p.quantity <= 0 ? "badge-Canceled" : "badge-Waiting"}">${p.quantity <= 0 ? "Out of stock" : "Low"}</span></td>
            </tr>`).join("")}
        </tbody>
      </table>
      ${d.low_stock_count > d.low_stock_items.length ? `<div class="text-muted" style="padding:10px 18px;font-size:.8rem;">+ ${d.low_stock_count - d.low_stock_items.length} more — see Products.</div>` : ""}
    </div>` : ""}
    <div class="table-wrap">
      <div style="padding:16px 18px 4px;"><h2 style="font-size:1rem;">Recent documents</h2></div>
      <table>
        <thead><tr><th>Reference</th><th>Type</th><th>Partner</th><th>Status</th><th>Created</th></tr></thead>
        <tbody>
          ${d.recent_documents.length ? d.recent_documents.map(doc => `
            <tr style="cursor:pointer" onclick="location.hash='#${docRoute(doc.type)}'">
              <td class="mono">${esc(doc.reference)}</td>
              <td>${docTypeLabel(doc.type)}</td>
              <td>${esc(doc.partner || "—")}</td>
              <td><span class="badge badge-${doc.status}">${doc.status}</span></td>
              <td class="text-muted">${fmtDate(doc.created_at)}</td>
            </tr>`).join("") : `<tr class="empty-row"><td colspan="5">No documents yet — create a receipt to get started.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
}

function kpi(label, value, tone) {
  return `<div class="card kpi"><div class="label">${label}</div><div class="value ${tone}">${value}</div></div>`;
}
function docRoute(type) {
  return { receipt: "/receipts", delivery: "/deliveries", internal: "/transfers", adjustment: "/adjustments" }[type];
}
function docTypeLabel(type) {
  return { receipt: "Receipt", delivery: "Delivery", internal: "Internal Transfer", adjustment: "Adjustment" }[type];
}

// ================================================================== PRODUCTS

async function pageProducts(slot, query = "") {
  const products = await api("GET", "/api/products" + (query ? `?q=${encodeURIComponent(query)}` : ""));
  slot.innerHTML = `
    <div class="flex gap-12" style="margin-bottom:16px;">
      <div class="search" style="width:320px;">🔎 <input id="prod-search" placeholder="Search by name or SKU" value="${esc(query)}"></div>
      <div class="spacer"></div>
      ${isManager() ? `<button class="btn btn-accent" onclick="openProductModal()">+ New Product</button>` : ""}
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Product</th><th>SKU</th><th>Category</th><th>UoM</th><th>Stock by location</th><th>Total</th><th>Reorder rule</th><th></th></tr></thead>
        <tbody>
          ${products.length ? products.map(p => `
            <tr>
              <td>${esc(p.name)}</td>
              <td class="mono">${esc(p.sku)}</td>
              <td>${esc(p.category_name || "—")}</td>
              <td>${esc(p.uom)}</td>
              <td>${p.stock_by_warehouse.map(s => `<div class="text-muted" style="font-size:.8rem;">${esc(s.warehouse)}: <b style="color:var(--ink)">${s.quantity}</b></div>`).join("")}</td>
              <td class="mono ${p.total_stock <= p.reorder_min ? "" : ""}"><b style="${p.total_stock <= 0 ? 'color:var(--danger)' : p.total_stock <= p.reorder_min ? 'color:var(--accent-ink)' : ''}">${p.total_stock}</b></td>
              <td class="text-muted">${p.reorder_min} – ${p.reorder_max}</td>
              <td class="flex gap-8">
                ${isManager() ? `
                  <button class="btn btn-sm btn-ghost" onclick='openProductModal(${JSON.stringify(p).replace(/'/g, "&apos;")})'>Edit</button>
                  <button class="btn btn-sm btn-ghost" style="color:var(--danger)" onclick="deleteProduct(${p.id}, '${esc(p.name)}')">Delete</button>
                ` : `<span class="text-muted" style="font-size:.8rem;">View only</span>`}
              </td>
            </tr>`).join("") : `<tr class="empty-row"><td colspan="8">No products match — try a different search or add a new product.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
  const search = document.getElementById("prod-search");
  let t;
  search.oninput = () => { clearTimeout(t); t = setTimeout(() => pageProducts(slot, search.value), 250); };
}

function openProductModal(p) {
  const isEdit = !!p;
  const catOptions = S.categories.map(c => `<option value="${c.id}" ${p && p.category_id === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("");
  openModal(`
    <div class="modal-head"><h3>${isEdit ? "Edit product" : "New product"}</h3><button class="icon-btn" onclick="closeModal()">✕</button></div>
    <div class="modal-body">
      <form id="f-product">
        <div class="field"><label>Product name</label><input name="name" required value="${p ? esc(p.name) : ""}"></div>
        <div class="form-row">
          <div class="field"><label>SKU / Code</label><input name="sku" required value="${p ? esc(p.sku) : ""}" class="mono"></div>
          <div class="field"><label>Unit of measure</label><input name="uom" required value="${p ? esc(p.uom) : "unit"}"></div>
        </div>
        <div class="field"><label>Category</label>
          <select name="category_id"><option value="">— none —</option>${catOptions}</select>
        </div>
        <div class="form-row">
          <div class="field"><label>Reorder minimum</label><input type="number" name="reorder_min" value="${p ? p.reorder_min : 0}"></div>
          <div class="field"><label>Reorder maximum</label><input type="number" name="reorder_max" value="${p ? p.reorder_max : 0}"></div>
        </div>
        ${!isEdit ? `
        <div class="form-row">
          <div class="field"><label>Initial stock (optional)</label><input type="number" name="initial_stock" value="0"></div>
          <div class="field"><label>Warehouse</label>
            <select name="warehouse_id">${S.warehouses.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join("")}</select>
          </div>
        </div>` : ""}
        <div id="product-alert"></div>
      </form>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-accent" onclick="submitProduct(${p ? p.id : "null"})">${isEdit ? "Save changes" : "Create product"}</button>
    </div>
  `);
}

async function submitProduct(id) {
  const f = new FormData(document.getElementById("f-product"));
  const payload = Object.fromEntries(f.entries());
  try {
    if (id) await api("PUT", `/api/products/${id}`, payload);
    else await api("POST", "/api/products", payload);
    closeModal();
    toast(id ? "Product updated" : "Product created", "ok");
    render();
  } catch (err) {
    document.getElementById("product-alert").innerHTML = `<div class="alert alert-danger">${esc(err.message)}</div>`;
  }
}

async function deleteProduct(id, name) {
  if (!confirm(`Delete "${name}"? This can't be undone.`)) return;
  try {
    await api("DELETE", `/api/products/${id}`);
    toast("Product deleted", "ok");
    render();
  } catch (err) { toast(err.message, "error"); }
}

// ================================================================== DOCUMENTS (Receipts / Deliveries / Transfers / Adjustments)

const DOC_CONFIG = {
  receipt:    { title: "Receipts",             icon: "⬇️", partnerLabel: "Supplier", needsSource: false, needsDest: true,  qtyLabel: "Qty received" },
  delivery:   { title: "Delivery Orders",      icon: "⬆️", partnerLabel: "Customer", needsSource: true,  needsDest: false, qtyLabel: "Qty to deliver" },
  internal:   { title: "Internal Transfers",   icon: "↔️", partnerLabel: null,       needsSource: true,  needsDest: true,  qtyLabel: "Qty" },
  adjustment: { title: "Inventory Adjustments",icon: "🛠️", partnerLabel: null,       needsSource: true,  needsDest: false, qtyLabel: "Counted qty", isAdjustment: true },
};
const STATUS_FILTERS = ["All", "Draft", "Waiting", "Ready", "Done", "Canceled"];
const docFilterState = {};
let docFormLines = [];
let docFormType = null;

async function pageDocuments(type, slot) {
  const cfg = DOC_CONFIG[type];
  const filter = docFilterState[type] || (docFilterState[type] = { status: "All", warehouse_id: "" });
  let qs = [];
  if (filter.status !== "All") qs.push(`status=${filter.status}`);
  if (filter.warehouse_id) qs.push(`warehouse_id=${filter.warehouse_id}`);
  const docs = await api("GET", `/api/documents?type=${type}` + (qs.length ? "&" + qs.join("&") : ""));

  slot.innerHTML = `
    <div class="flex gap-12" style="margin-bottom:16px;">
      <select id="wh-filter" style="width:220px;">
        <option value="">All warehouses</option>
        ${S.warehouses.map(w => `<option value="${w.id}" ${filter.warehouse_id == w.id ? "selected" : ""}>${esc(w.name)}</option>`).join("")}
      </select>
      <div class="spacer"></div>
      <button class="btn btn-accent" onclick="openDocumentModal('${type}')">+ New ${cfg.title.replace(/s$/, "")}</button>
    </div>
    <div class="filters">
      ${STATUS_FILTERS.map(s => `<div class="chip ${filter.status === s ? "active" : ""}" data-status="${s}">${s}</div>`).join("")}
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Reference</th>
          ${cfg.partnerLabel ? `<th>${cfg.partnerLabel}</th>` : "<th>Notes</th>"}
          <th>${cfg.needsSource ? "Source" : ""}</th><th>${cfg.needsDest ? "Destination" : ""}</th>
          <th>Lines</th><th>Status</th><th>Created</th><th></th>
        </tr></thead>
        <tbody>
          ${docs.length ? docs.map(d => `
            <tr>
              <td class="mono">${esc(d.reference)}</td>
              <td>${esc(d.partner || d.notes || "—")}</td>
              <td>${esc(d.source_warehouse || "")}</td>
              <td>${esc(d.dest_warehouse || "")}</td>
              <td>${d.lines.length}</td>
              <td><span class="badge badge-${d.status}">${d.status}</span></td>
              <td class="text-muted">${fmtDate(d.created_at)}</td>
              <td><button class="btn btn-sm btn-ghost" onclick="openDocumentView(${d.id})">View</button></td>
            </tr>`).join("") : `<tr class="empty-row"><td colspan="8">Nothing here yet — create a new ${cfg.title.toLowerCase().replace(/s$/, "")} to get started.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
  slot.querySelectorAll(".chip").forEach(c => c.onclick = () => {
    filter.status = c.dataset.status; pageDocuments(type, slot);
  });
  document.getElementById("wh-filter").onchange = (e) => { filter.warehouse_id = e.target.value; pageDocuments(type, slot); };
}

function productOptions(selectedId) {
  return `<option value="">Select product…</option>` + S._products.map(p =>
    `<option value="${p.id}" ${selectedId == p.id ? "selected" : ""}>${esc(p.name)} (${esc(p.sku)})</option>`).join("");
}

async function openDocumentModal(type) {
  if (!S._products) S._products = await api("GET", "/api/products");
  docFormType = type;
  docFormLines = [{ product_id: "", quantity: "" }];
  const cfg = DOC_CONFIG[type];
  openModal(`
    <div class="modal-head"><h3>New ${cfg.title.replace(/s$/, "")}</h3><button class="icon-btn" onclick="closeModal()">✕</button></div>
    <div class="modal-body">
      <form id="f-doc">
        ${cfg.partnerLabel ? `<div class="field"><label>${cfg.partnerLabel}</label><input name="partner" placeholder="${cfg.partnerLabel} name"></div>` : `<div class="field"><label>Notes</label><input name="notes" placeholder="Optional note"></div>`}
        <div class="form-row">
          ${cfg.needsSource ? `<div class="field"><label>${type === "adjustment" ? "Warehouse / location" : "Source warehouse"}</label>
            <select name="source_warehouse_id">${S.warehouses.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join("")}</select></div>` : ""}
          ${cfg.needsDest ? `<div class="field"><label>Destination warehouse</label>
            <select name="dest_warehouse_id">${S.warehouses.map((w, i) => `<option value="${w.id}" ${type === "internal" && i === 1 ? "selected" : ""}>${esc(w.name)}</option>`).join("")}</select></div>` : ""}
        </div>
        <label>Product lines</label>
        <div id="doc-lines"></div>
        <button type="button" class="btn btn-sm btn-ghost" onclick="addDocLine()">+ Add line</button>
        <div id="doc-alert" style="margin-top:12px;"></div>
      </form>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-accent" onclick="submitDocument()">Create as Draft</button>
    </div>
  `);
  renderDocLines();
}

function renderDocLines() {
  const cfg = DOC_CONFIG[docFormType];
  document.getElementById("doc-lines").innerHTML = docFormLines.map((l, i) => `
    <div class="line-row">
      <select onchange="docFormLines[${i}].product_id=this.value">${productOptions(l.product_id)}</select>
      <input type="number" step="any" placeholder="${cfg.qtyLabel}" value="${l.quantity}" onchange="docFormLines[${i}].quantity=this.value">
      <button type="button" class="icon-btn" onclick="removeDocLine(${i})">✕</button>
    </div>
  `).join("");
}
function addDocLine() { docFormLines.push({ product_id: "", quantity: "" }); renderDocLines(); }
function removeDocLine(i) { docFormLines.splice(i, 1); if (!docFormLines.length) docFormLines.push({ product_id: "", quantity: "" }); renderDocLines(); }

async function submitDocument() {
  const cfg = DOC_CONFIG[docFormType];
  const f = new FormData(document.getElementById("f-doc"));
  const payload = Object.fromEntries(f.entries());
  const lines = docFormLines.filter(l => l.product_id).map(l => {
    if (cfg.isAdjustment) return { product_id: Number(l.product_id), quantity: 0, counted_quantity: Number(l.quantity || 0) };
    return { product_id: Number(l.product_id), quantity: Number(l.quantity || 0) };
  });
  payload.lines = lines;
  try {
    const res = await api("POST", `/api/documents/${docFormType}`, payload);
    closeModal();
    toast(`${res.reference} created as Draft`, "ok");
    render();
  } catch (err) {
    document.getElementById("doc-alert").innerHTML = `<div class="alert alert-danger">${esc(err.message)}</div>`;
  }
}

async function openDocumentView(id) {
  const d = await api("GET", `/api/documents/${id}`);
  const cfg = DOC_CONFIG[d.type];
  const canAdvance = !["Done", "Canceled"].includes(d.status);
  const nextStatus = { Draft: "Waiting", Waiting: "Ready", Ready: "Ready" }[d.status];
  openModal(`
    <div class="modal-head">
      <h3>${esc(d.reference)} <span class="badge badge-${d.status}" style="margin-left:8px;">${d.status}</span></h3>
      <button class="icon-btn" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">
      <div class="grid" style="grid-template-columns:1fr 1fr;margin-bottom:16px;font-size:.87rem;">
        <div><div class="text-muted" style="font-size:.75rem;">${cfg.partnerLabel || "Notes"}</div>${esc(d.partner || d.notes || "—")}</div>
        <div><div class="text-muted" style="font-size:.75rem;">Created</div>${fmtDate(d.created_at)}</div>
        ${d.source_warehouse ? `<div><div class="text-muted" style="font-size:.75rem;">Source</div>${esc(d.source_warehouse)}</div>` : ""}
        ${d.dest_warehouse ? `<div><div class="text-muted" style="font-size:.75rem;">Destination</div>${esc(d.dest_warehouse)}</div>` : ""}
      </div>
      <table style="border:1px solid var(--border);border-radius:8px;overflow:hidden;width:100%;">
        <thead><tr><th style="padding:8px 10px;background:#F6F8FA;text-align:left;font-size:.75rem;">Product</th><th style="padding:8px 10px;background:#F6F8FA;text-align:right;font-size:.75rem;">${cfg.isAdjustment ? "Counted qty" : "Qty"}</th></tr></thead>
        <tbody>
          ${d.lines.map(l => `<tr><td style="padding:8px 10px;border-top:1px solid var(--border);">${esc(l.product_name)} <span class="text-muted mono">(${esc(l.sku)})</span></td><td class="mono" style="padding:8px 10px;border-top:1px solid var(--border);text-align:right;">${cfg.isAdjustment ? l.counted_quantity : l.quantity} ${esc(l.uom)}</td></tr>`).join("")}
        </tbody>
      </table>
      <div id="view-alert" style="margin-top:12px;"></div>
    </div>
    <div class="modal-foot">
      ${d.status === "Draft" ? `<button class="btn btn-danger" onclick="setDocStatus(${d.id},'Canceled')">Cancel doc</button>` : ""}
      ${canAdvance && d.status !== "Ready" ? `<button class="btn btn-ghost" onclick="setDocStatus(${d.id},'${nextStatus}')">Mark ${nextStatus}</button>` : ""}
      ${canAdvance ? `<button class="btn btn-accent" onclick="validateDoc(${d.id})">✓ Validate</button>` : ""}
    </div>
  `);
}

async function setDocStatus(id, status) {
  try { await api("POST", `/api/documents/${id}/status`, { status }); toast("Status updated", "ok"); closeModal(); render(); }
  catch (err) { document.getElementById("view-alert").innerHTML = `<div class="alert alert-danger">${esc(err.message)}</div>`; }
}
async function validateDoc(id) {
  try {
    await api("POST", `/api/documents/${id}/validate`, {});
    toast("Validated — stock updated", "ok");
    closeModal(); render();
  } catch (err) {
    document.getElementById("view-alert").innerHTML = `<div class="alert alert-danger">${esc(err.message)}</div>`;
  }
}

// ================================================================== MOVE HISTORY (stock ledger)

async function pageHistory(slot) {
  if (!S._products) S._products = await api("GET", "/api/products");
  const state = pageHistory._f || (pageHistory._f = { product_id: "", warehouse_id: "" });
  let qs = [];
  if (state.product_id) qs.push(`product_id=${state.product_id}`);
  if (state.warehouse_id) qs.push(`warehouse_id=${state.warehouse_id}`);
  const rows = await api("GET", "/api/ledger" + (qs.length ? "?" + qs.join("&") : ""));
  pageHistory._rows = rows;
  slot.innerHTML = `
    <div class="flex gap-12" style="margin-bottom:16px;">
      <select id="hist-product" style="width:240px;"><option value="">All products</option>
        ${S._products.map(p => `<option value="${p.id}" ${state.product_id == p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select>
      <select id="hist-wh" style="width:200px;"><option value="">All warehouses</option>
        ${S.warehouses.map(w => `<option value="${w.id}" ${state.warehouse_id == w.id ? "selected" : ""}>${esc(w.name)}</option>`).join("")}</select>
      <div class="spacer"></div>
      <button class="btn btn-ghost" onclick="exportLedgerCSV()" ${rows.length ? "" : "disabled"}>⬇ Export CSV</button>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Date</th><th>Product</th><th>Warehouse</th><th>Document</th><th>Change</th><th>Balance after</th></tr></thead>
        <tbody>
          ${rows.length ? rows.map(r => `
            <tr>
              <td class="text-muted">${fmtDate(r.created_at)}</td>
              <td>${esc(r.product_name)} <span class="mono text-muted">(${esc(r.sku)})</span></td>
              <td>${esc(r.warehouse_name)}</td>
              <td class="mono">${esc(r.doc_reference || "—")}</td>
              <td class="mono" style="color:${r.change_qty >= 0 ? "var(--success)" : "var(--danger)"}">${r.change_qty >= 0 ? "+" : ""}${r.change_qty}</td>
              <td class="mono">${r.balance_after}</td>
            </tr>`).join("") : `<tr class="empty-row"><td colspan="6">No stock movements recorded yet.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
  document.getElementById("hist-product").onchange = (e) => { state.product_id = e.target.value; pageHistory(slot); };
  document.getElementById("hist-wh").onchange = (e) => { state.warehouse_id = e.target.value; pageHistory(slot); };
}

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportLedgerCSV() {
  const rows = pageHistory._rows || [];
  if (!rows.length) { toast("Nothing to export", "error"); return; }
  const header = ["Date", "Product", "SKU", "Warehouse", "Document", "Change", "Balance after"];
  const body = rows.map(r => [
    fmtDate(r.created_at), r.product_name, r.sku, r.warehouse_name, r.doc_reference || "", r.change_qty, r.balance_after,
  ]);
  const csv = [header, ...body].map(row => row.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `stocksense-move-history-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast(`Exported ${rows.length} rows`, "ok");
}

// ================================================================== WAREHOUSES (Settings)

async function pageWarehouses(slot) {
  const warehouses = await api("GET", "/api/warehouses");
  slot.innerHTML = `
    <div class="flex" style="margin-bottom:16px;"><div class="spacer"></div>
      ${isManager() ? `<button class="btn btn-accent" onclick="openWarehouseModal()">+ New Warehouse</button>` : ""}
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Name</th><th>Location</th></tr></thead>
        <tbody>
          ${warehouses.map(w => `<tr><td>${esc(w.name)}</td><td class="text-muted">${esc(w.location || "—")}</td></tr>`).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function openWarehouseModal() {
  openModal(`
    <div class="modal-head"><h3>New warehouse</h3><button class="icon-btn" onclick="closeModal()">✕</button></div>
    <div class="modal-body">
      <form id="f-wh">
        <div class="field"><label>Name</label><input name="name" required placeholder="e.g. East Coast DC"></div>
        <div class="field"><label>Location</label><input name="location" placeholder="Optional address / building"></div>
        <div id="wh-alert"></div>
      </form>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-accent" onclick="submitWarehouse()">Create</button>
    </div>
  `);
}
async function submitWarehouse() {
  const f = new FormData(document.getElementById("f-wh"));
  try {
    await api("POST", "/api/warehouses", Object.fromEntries(f.entries()));
    S.warehouses = [];
    closeModal(); toast("Warehouse created", "ok"); render();
  } catch (err) { document.getElementById("wh-alert").innerHTML = `<div class="alert alert-danger">${esc(err.message)}</div>`; }
}

// ================================================================== PROFILE

async function pageProfile(slot) {
  const p = await api("GET", "/api/profile");
  slot.innerHTML = `
    <div class="card" style="max-width:460px;">
      <form id="f-profile">
        <div class="field"><label>Full name</label><input name="name" value="${esc(p.name)}"></div>
        <div class="field"><label>Email</label><input value="${esc(p.email)}" disabled></div>
        <div class="field"><label>Role</label><input value="${esc(p.role)}" disabled></div>
        <div id="profile-alert"></div>
        <button class="btn btn-accent" type="submit">Save changes</button>
      </form>
    </div>
  `;
  document.getElementById("f-profile").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api("PUT", "/api/profile", { name: f.get("name") });
      const updated = { ...S.user, name: f.get("name") };
      login(S.token, updated);
      toast("Profile updated", "ok");
      render();
    } catch (err) { document.getElementById("profile-alert").innerHTML = `<div class="alert alert-danger">${esc(err.message)}</div>`; }
  };
}

// ================================================================== MODAL

function openModal(innerHtml) {
  closeModal();
  const back = document.createElement("div");
  back.className = "modal-backdrop"; back.id = "modal-backdrop";
  back.innerHTML = `<div class="modal">${innerHtml}</div>`;
  back.addEventListener("click", (e) => { if (e.target === back) closeModal(); });
  document.body.appendChild(back);
}
function closeModal() {
  const el = document.getElementById("modal-backdrop");
  if (el) el.remove();
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
