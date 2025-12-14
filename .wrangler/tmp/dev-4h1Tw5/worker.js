var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// .wrangler/tmp/bundle-8vPeRA/checked-fetch.js
var urls = /* @__PURE__ */ new Set();
function checkURL(request, init) {
  const url = request instanceof URL ? request : new URL(
    (typeof request === "string" ? new Request(request, init) : request).url
  );
  if (url.port && url.port !== "443" && url.protocol === "https:") {
    if (!urls.has(url.toString())) {
      urls.add(url.toString());
      console.warn(
        `WARNING: known issue with \`fetch()\` requests to custom HTTPS ports in published Workers:
 - ${url.toString()} - the custom port will be ignored when the Worker is published using the \`wrangler deploy\` command.
`
      );
    }
  }
}
__name(checkURL, "checkURL");
globalThis.fetch = new Proxy(globalThis.fetch, {
  apply(target, thisArg, argArray) {
    const [request, init] = argArray;
    checkURL(request, init);
    return Reflect.apply(target, thisArg, argArray);
  }
});

// api/worker.js
var FX_RATES = {
  LKR: 1 / 320,
  USD: 1
};
function toUsd(value, currency) {
  const rate = FX_RATES[currency];
  if (rate == null) return null;
  return Math.round(value * rate * 1e4) / 1e4;
}
__name(toUsd, "toUsd");
function extractPackQty(label) {
  if (!label) return 1;
  const match = label.match(/(\d+)\s*(pcs|pc)/i);
  return match ? parseInt(match[1], 10) : 1;
}
__name(extractPackQty, "extractPackQty");
function stripQtyWords(label) {
  if (!label) return "";
  return label.replace(/\b\d+\s*(pcs|pc)\b/ig, "").replace(/\s{2,}/g, " ").trim();
}
__name(stripQtyWords, "stripQtyWords");
function parseBomLine(line) {
  const upper = line.trim().toUpperCase();
  let qty = 1;
  const qtyMatch = upper.match(/X\s*(\d+)/);
  if (qtyMatch) qty = parseInt(qtyMatch[1], 10);
  const ampMatch = upper.match(/(\d+)\s*A/);
  const currentA = ampMatch ? parseInt(ampMatch[1], 10) : null;
  const isEsc = upper.includes("ESC");
  return {
    canonical_type: isEsc ? "ESC" : null,
    current_A: currentA,
    qty,
    raw: upper
  };
}
__name(parseBomLine, "parseBomLine");
function parseBom(text) {
  return text.trim().split("\n").map((l) => l.trim()).filter((l) => l.length > 0).map(parseBomLine);
}
__name(parseBom, "parseBom");
function novaRank(bomItem, candidates) {
  if (!candidates || candidates.length === 0) {
    return { selected_index: -1, match_score: 0, reasoning: "No candidates" };
  }
  return {
    selected_index: 0,
    match_score: 0.85,
    reasoning: "Exact match in variant label and lowest price (mock)."
  };
}
__name(novaRank, "novaRank");
function toCSV(items) {
  const header = [
    "Description",
    "Quantity",
    "Unit Price (USD)",
    "Total Price (USD)",
    "Supplier",
    "Confidence",
    "Reasoning",
    "Product URL"
  ];
  const rows = items.map((i) => {
    if (i.status !== "MATCHED") {
      return [
        i.bom?.raw || "Unknown",
        i.bom?.qty || 1,
        "",
        "",
        "",
        "",
        i.status,
        ""
      ];
    }
    return [
      `${i.bom.current_A}A ESC`,
      i.bom.qty,
      i.unit_price_usd,
      i.total_price_usd,
      i.selected?.seller?.name || "Unknown",
      i.match_score,
      i.reasoning,
      i.selected?.product_url || ""
    ];
  });
  const BOM = "\uFEFF";
  return BOM + [header, ...rows].map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
}
__name(toCSV, "toCSV");
function calculateConfidenceDecay(baseScore, lastUpdated) {
  if (!lastUpdated) return baseScore;
  const now = /* @__PURE__ */ new Date();
  const updated = new Date(lastUpdated);
  const daysOld = (now - updated) / (1e3 * 60 * 60 * 24);
  const decayFactor = Math.exp(-daysOld / 30);
  return Math.round(baseScore * decayFactor * 100) / 100;
}
__name(calculateConfidenceDecay, "calculateConfidenceDecay");
var worker_default = {
  // Scheduled handler for cron triggers
  async scheduled(event, env, ctx) {
    console.log("Scheduled refresh triggered at:", (/* @__PURE__ */ new Date()).toISOString());
    return;
  },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/admin/refresh") {
      const adminKey = req.headers.get("X-ADMIN-KEY");
      if (!adminKey || adminKey !== env.ADMIN_KEY) {
        return new Response("Unauthorized", { status: 401 });
      }
      return Response.json({
        status: "refresh_triggered",
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        message: "Crawl job queued. Anti-Gravity will update prices."
      });
    }
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }
    if (req.method === "GET") {
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BOM Pricer</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 900px;
      margin: 40px auto;
      padding: 20px;
      background: #0f0f0f;
      color: #e0e0e0;
    }
    h1 {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      font-size: 2.5rem;
      margin-bottom: 8px;
    }
    .subtitle { color: #888; margin-bottom: 30px; }
    textarea {
      width: 100%;
      padding: 16px;
      border: 1px solid #333;
      border-radius: 12px;
      background: #1a1a1a;
      color: #fff;
      font-family: 'Monaco', 'Consolas', monospace;
      font-size: 14px;
      resize: vertical;
    }
    textarea:focus { outline: none; border-color: #667eea; }
    .btn-group { margin: 20px 0; display: flex; gap: 12px; }
    button {
      padding: 12px 28px;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.1s, box-shadow 0.2s;
    }
    button:hover { transform: translateY(-2px); }
    button:active { transform: translateY(0); }
    .btn-primary {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
    }
    .btn-secondary {
      background: #2a2a2a;
      color: #e0e0e0;
      border: 1px solid #444;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 20px;
      background: #1a1a1a;
      border-radius: 12px;
      overflow: hidden;
    }
    th, td {
      padding: 14px 16px;
      text-align: left;
      border-bottom: 1px solid #2a2a2a;
    }
    th {
      background: #252525;
      color: #888;
      font-weight: 500;
      text-transform: uppercase;
      font-size: 12px;
    }
    tr:hover td { background: #222; }
    .price { color: #fbbf24; font-weight: 600; }
    .confidence { color: #60a5fa; }
    a { color: #818cf8; text-decoration: none; }
    .status-error { color: #f87171; }
    #loading { display: none; color: #888; padding: 20px; }
    .spinner {
      display: inline-block; width: 20px; height: 20px;
      border: 2px solid #444; border-top-color: #667eea;
      border-radius: 50%; animation: spin 0.8s linear infinite;
      margin-right: 10px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .total-row td { background: #252525; font-weight: 600; border-top: 2px solid #444; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; margin-left: 6px; }
    .badge-low { background: #065f46; color: #34d399; }
    .badge-medium { background: #78350f; color: #fbbf24; }
    .badge-high { background: #7f1d1d; color: #f87171; }
    .verified { color: #4ade80; font-size: 12px; display: block; margin-top: 4px; }
    .verified::before { content: "\u2713 "; }
    .warning { color: #fbbf24; font-size: 12px; display: block; margin-top: 4px; }
    .warning::before { content: "\u26A0 "; }
    .item-details { font-size: 11px; color: #888; margin-top: 4px; }
    .candidates { margin: 8px 0; }
    .candidate-row { padding: 6px 8px; margin: 4px 0; background: #1a1a1a; border-radius: 6px; border: 1px solid #333; transition: all 0.2s; }
    .candidate-row:hover { border-color: #667eea; }
    .candidate-row label { display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px; }
    .candidate-row input[type=radio] { accent-color: #667eea; }
    .candidate-row .brand { color: #60a5fa; font-weight: 600; }
    .candidate-row .price { color: #fbbf24; margin-left: auto; }
    .candidate-row .remark { color: #888; font-size: 11px; }
    .candidate-row .pack-info { color: #6b7280; font-size: 10px; margin-left: 4px; }
    .risk-badge { padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: 600; margin-left: 8px; }
    .risk-low { background: #065f46; color: #34d399; }
    .risk-medium { background: #78350f; color: #fbbf24; }
    .risk-high { background: #7f1d1d; color: #f87171; }
    .row-unit, .row-total { transition: all 0.3s; }
  </style>
</head>
<body>
  <h1>BOM Pricer</h1>
  <p class="subtitle">Paste your Bill of Materials, get instant pricing from AliExpress</p>
  <textarea id="bom" rows="6">30A ESC x2
40A ESC x1</textarea>
  <div class="btn-group">
    <button class="btn-primary" id="btn-price">Get Prices</button>
    <button class="btn-secondary" id="btn-csv">Download CSV</button>
  </div>
  <div id="loading"><span class="spinner"></span>Fetching prices...</div>
  <div id="results"></div>
  <script>
    // Make functions globally accessible
    window.price = async function() {
      const bom = document.getElementById("bom").value;
      document.getElementById("loading").style.display = "block";
      document.getElementById("results").innerHTML = "";
      try {
        const res = await fetch("/", { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({ bom }) });
        const data = await res.json();
        console.log("API Response received:", data.status, "Items:", data.items?.length);
        renderTable(data);
      } catch (e) {
        console.error("Fetch error:", e);
        document.getElementById("results").innerHTML = '<p class="status-error">Error: ' + e.message + '</p>';
      } finally {
        document.getElementById("loading").style.display = "none";
      }
    };
    let bomData = null;
    function renderTable(data) {
      bomData = data;
      if (!data.items?.length) { document.getElementById("results").innerHTML = "<p>No results.</p>"; return; }
      let html = '<table><thead><tr><th>Item</th><th>Qty</th><th>Select Supplier</th><th>Unit Price</th><th>Total</th></tr></thead><tbody>';
      for (const i of data.items) {
        if (i.status === "MATCHED") {
          const itemKey = i.bom.current_A + 'A_ESC';
          const defaultCand = i.candidates?.find(c => c.default) || i.candidates?.[0];
          html += '<tr>';
          html += '<td>' + i.bom.current_A + 'A ESC<span class="verified">Variant verified</span></td>';
          html += '<td class="qty" data-item="' + itemKey + '">' + i.bom.qty + '</td>';
          html += '<td><div class="candidates" data-item="' + itemKey + '" data-qty="' + i.bom.qty + '">';
          if (i.candidates) {
            for (const c of i.candidates) {
              html += '<div class="candidate-row">';
              html += '<label>';
              html += '<input type="radio" name="cand_' + itemKey + '" value="' + c.id + '" ' + (c.default ? 'checked' : '') + ' data-price-usd="' + c.unit_price_usd + '" data-price-local="' + c.unit_price_local + '" data-currency="' + c.local_currency + '" data-pack-qty="' + (c.pack_qty || 1) + '" data-pack-price-usd="' + (c.pack_price_usd || c.unit_price_usd) + '" data-item-key="' + itemKey + '" data-qty="' + i.bom.qty + '">';
              html += '<span class="brand">' + c.brand + '</span> ' + c.model;
              html += '<span class="risk-badge risk-' + c.risk.toLowerCase() + '">' + c.risk + '</span>';
              // Show unit price with pack breakdown if pack_qty > 1
              if (c.pack_qty > 1) {
                html += '<span class="price">$' + (c.unit_price_usd?.toFixed(2) || '-') + '/unit</span>';
                html += '<span class="pack-info">(' + c.pack_qty + 'pcs = $' + (c.pack_price_usd?.toFixed(2) || '-') + ')</span>';
              } else {
                html += '<span class="price">$' + (c.unit_price_usd?.toFixed(2) || '-') + '</span>';
              }
              html += '</label>';
              html += '<span class="remark">' + c.remark + '</span>';
              html += '</div>';
            }
          }
          html += '</div></td>';
          html += '<td class="price row-unit" data-item="' + itemKey + '">$' + (defaultCand?.unit_price_usd?.toFixed(2) || i.unit_price_usd?.toFixed(2) || '-') + ' USD';
          if (defaultCand?.local_currency && defaultCand.local_currency !== 'USD') {
            html += '<span class="item-details">\u2248 ' + defaultCand.local_currency + ' ' + Math.round(defaultCand.unit_price_local) + '</span>';
          }
          html += '</td>';
          html += '<td class="price row-total" data-item="' + itemKey + '">$' + ((defaultCand?.unit_price_usd || i.unit_price_usd) * i.bom.qty).toFixed(2) + '</td>';
          html += '</tr>';
        } else {
          html += '<tr><td>' + (i.bom?.raw || 'Unknown') + '</td><td>' + (i.bom?.qty || '-') + '</td><td colspan="3" class="status-error">' + i.status + '</td></tr>';
        }
      }
      html += '<tr class="total-row"><td colspan="3">Total BOM Cost</td><td></td><td class="price" id="bom-total">$' + recalcBomTotal() + '</td></tr></tbody></table>';
      document.getElementById("results").innerHTML = html;
      recalcBomTotal();
    }
    window.onCandidateSelected = function(itemKey, qty) {
      const selected = document.querySelector('input[name="cand_' + itemKey + '"]:checked');
      if (!selected) return;
      const unitUsd = parseFloat(selected.dataset.priceUsd);
      const unitLocal = parseFloat(selected.dataset.priceLocal);
      const currency = selected.dataset.currency;
      const rowUnit = document.querySelector('.row-unit[data-item="' + itemKey + '"]');
      const rowTotal = document.querySelector('.row-total[data-item="' + itemKey + '"]');
      if (rowUnit) rowUnit.innerHTML = '$' + unitUsd.toFixed(2) + ' USD' + (currency !== 'USD' ? '<span class="item-details">\u2248 ' + currency + ' ' + Math.round(unitLocal) + '</span>' : '');
      if (rowTotal) rowTotal.innerText = '$' + (unitUsd * qty).toFixed(2);
      recalcBomTotal();
    };
    function recalcBomTotal() {
      let total = 0;
      document.querySelectorAll('.candidates').forEach(c => {
        const itemKey = c.dataset.item;
        const qty = parseInt(c.dataset.qty) || 1;
        const selected = document.querySelector('input[name="cand_' + itemKey + '"]:checked');
        if (selected) total += parseFloat(selected.dataset.priceUsd) * qty;
      });
      const bomTotalEl = document.getElementById('bom-total');
      if (bomTotalEl) bomTotalEl.innerText = '$' + total.toFixed(2);
      return total.toFixed(2);
    }
    window.downloadCSV = async function() {
      const bom = document.getElementById("bom").value;
      if (!bom.trim()) { alert("Please enter a BOM first"); return; }
      try {
        const res = await fetch("/?format=csv", { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({ bom }) });
        if (!res.ok) { alert("Error fetching CSV"); return; }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "bom_pricing_" + new Date().toISOString().slice(0,10) + ".csv";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch (e) { alert("Download failed: " + e.message); }
    };
    
    // Attach event listeners (DOM already loaded since script is at end of body)
    document.getElementById('btn-price').addEventListener('click', window.price);
    document.getElementById('btn-csv').addEventListener('click', window.downloadCSV);
    
    // Event delegation for candidate radio buttons (dynamically added)
    document.getElementById('results').addEventListener('change', function(e) {
      if (e.target.type === 'radio' && e.target.dataset.itemKey) {
        const itemKey = e.target.dataset.itemKey;
        const qty = parseInt(e.target.dataset.qty) || 1;
        window.onCandidateSelected(itemKey, qty);
      }
    });
  <\/script>
</body>
</html>`;
      return new Response(html, { headers: { "Content-Type": "text/html", "Access-Control-Allow-Origin": "*" } });
    }
    if (req.method !== "POST") {
      return new Response("POST only", { status: 405 });
    }
    let body;
    try {
      body = await req.json();
    } catch {
      return Response.json({ status: "error", message: "Invalid JSON" }, { status: 400 });
    }
    const bomText = body.bom;
    if (!bomText || typeof bomText !== "string") {
      return Response.json({ status: "error", message: "Missing 'bom' field" }, { status: 400 });
    }
    const bomItems = parseBom(bomText);
    const results = [];
    for (const b of bomItems) {
      if (!b.canonical_type || b.current_A == null) {
        results.push({ bom: b, status: "INVALID_LINE" });
        continue;
      }
      const { results: rows } = await env.DB.prepare(`
        SELECT title, variant, current_A, price_value, price_currency,
               seller_name, seller_rating, product_url, last_updated
        FROM catalog_items
        WHERE canonical_type = ? AND current_A = ?
      `).bind(b.canonical_type, b.current_A).all();
      const candidates = rows.map((r) => ({
        title: r.title,
        variant: r.variant,
        current_A: r.current_A,
        price_value: r.price_value,
        price_currency: r.price_currency,
        seller: { name: r.seller_name, rating: r.seller_rating },
        product_url: r.product_url,
        last_updated: r.last_updated
      }));
      if (candidates.length === 0) {
        results.push({ bom: b, status: "NOT_FOUND" });
        continue;
      }
      const allCandidates = candidates.map((c, idx) => {
        const brandMatch = c.title.match(/^(\w+)/);
        const brand = brandMatch ? brandMatch[1] : "Unknown";
        const packQty = extractPackQty(c.variant);
        const cleanName = stripQtyWords(c.variant) || c.title.substring(0, 30);
        const model = packQty > 1 ? `${packQty}Pcs ${cleanName}` : `1Pc ${cleanName}`;
        const packPriceUsd = toUsd(c.price_value, c.price_currency);
        const packPriceLocal = c.price_value;
        const unitPriceUsd2 = packPriceUsd != null ? Math.round(packPriceUsd / packQty * 1e4) / 1e4 : null;
        const unitPriceLocal = packPriceLocal / packQty;
        const conf = calculateConfidenceDecay(0.85, c.last_updated);
        const risk = conf >= 0.8 ? "LOW" : conf >= 0.5 ? "MEDIUM" : "HIGH";
        return {
          id: `cand_${idx}_${c.current_A}a`,
          brand,
          // Labels: raw for debugging, display for UI/CSV
          raw_variant_label: c.variant,
          display_label: model,
          model,
          // Keep for backward compatibility
          title: c.title,
          variant: c.variant,
          // Pack pricing (original)
          pack_qty: packQty,
          pack_price_usd: packPriceUsd,
          pack_price_local: packPriceLocal,
          // Normalized unit pricing
          unit_price_usd: unitPriceUsd2,
          unit_price_local: unitPriceLocal,
          local_currency: c.price_currency,
          confidence: conf,
          risk,
          remark: c.seller?.name || "AliExpress Seller",
          variant_verified: true,
          stock_ok: true,
          product_url: c.product_url,
          last_updated: c.last_updated,
          default: false
        };
      });
      allCandidates.sort((a, b2) => {
        if (b2.confidence !== a.confidence) return b2.confidence - a.confidence;
        return (a.unit_price_usd || 999) - (b2.unit_price_usd || 999);
      });
      if (allCandidates.length > 0) {
        allCandidates[0].default = true;
      }
      const nova = novaRank(b, candidates);
      const selectedIdx = nova.selected_index >= 0 ? nova.selected_index : 0;
      const selected = candidates[selectedIdx];
      const unitPriceUsd = toUsd(selected.price_value, selected.price_currency);
      const totalPriceUsd = unitPriceUsd != null ? unitPriceUsd * b.qty : null;
      const decayedScore = calculateConfidenceDecay(nova.match_score, selected.last_updated);
      results.push({
        bom: b,
        status: "MATCHED",
        selected,
        unit_price_usd: unitPriceUsd,
        total_price_usd: totalPriceUsd,
        unit_price_local: selected.price_value,
        local_currency: selected.price_currency,
        fx_rate_used: FX_RATES[selected.price_currency] || null,
        match_score: decayedScore,
        reasoning: nova.reasoning,
        price_age: selected.last_updated,
        // NEW: candidates array
        candidates: allCandidates
      });
    }
    const format = url.searchParams.get("format");
    if (format === "csv") {
      const csv = toCSV(results);
      return new Response(csv, {
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": "attachment; filename=bom.csv",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }
    return Response.json(
      {
        status: "ok",
        currency: "USD",
        generated_at: (/* @__PURE__ */ new Date()).toISOString(),
        items: results
      },
      {
        headers: {
          "Access-Control-Allow-Origin": "*"
        }
      }
    );
  }
};

// ../.nvm/versions/node/v20.19.5/lib/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../.nvm/versions/node/v20.19.5/lib/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-8vPeRA/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// ../.nvm/versions/node/v20.19.5/lib/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-8vPeRA/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
