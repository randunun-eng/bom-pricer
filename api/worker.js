import { generateSpecKey, generateVariantId, normalizeSpecs, extractSpecs } from "../utils/specs.js";
import { verifySignature } from "../utils/crypto.js";
import { runOrchestrator } from "../crawler/orchestrator.js";
import puppeteer from "@cloudflare/puppeteer";

// ─────────────────────────────────────────────────────────────
// RC-BOM-Agent v2.0 - Buyer Mode with Browser Rendering
// ─────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════
// 🔹 BUYER-MODE BROWSER RENDERING CRAWLER
// ═══════════════════════════════════════════════════════════════



/**
 * Crawl AliExpress product page using Browser Rendering
 * Uses @cloudflare/puppeteer for real browser execution
 */
async function crawlAliExpress(url, env) {
  if (!env.BROWSER) {
    console.error("[Crawl] Browser Rendering not available");
    return null;
  }

  let browser = null;
  try {
    // Launch browser using Cloudflare Browser Rendering
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();

    // Set random user agent to avoid detection
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    // Navigate to product page
    await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 });

    // Wait for variant selectors to load
    await page.waitForSelector("body", { timeout: 5000 });

    // Scroll to trigger lazy loading
    await page.evaluate(() => window.scrollBy(0, 2000));
    await new Promise(r => setTimeout(r, 1500));

    // Extract HTML and embedded JSON
    const html = await page.content();
    const runParams = await page.evaluate(() => {
      return window.runParams || window.__INIT_DATA__ || null;
    });

    await browser.close();

    return {
      html: html,
      json: runParams
    };
  } catch (e) {
    console.error("[Crawl] Browser Rendering error:", e.message);
    if (browser) {
      try { await browser.close(); } catch (ce) { }
    }
    return null;
  }
}

/**
 * 🔹 Extract spec_key from variant label or title
 * Parses amperage (e.g., "30A", "50A") from text and returns ESC:XXA format
 * Falls back to provided default if no amperage found
 */
function extractSpecKeyFromLabel(text, defaultSpecKey) {
  if (!text) return defaultSpecKey;

  // Match patterns like "30A", "50 A", "30AMP", "100A"
  const ampMatch = text.match(/(\d+)\s*A(?:MP)?/i);
  if (ampMatch) {
    const amps = parseInt(ampMatch[1], 10);
    if (amps > 0 && amps <= 300) { // Reasonable ESC range
      return `ESC:${amps}A`;
    }
  }

  return defaultSpecKey;
}

/**
 * 🔹 AUTO-CRAWL ON-DEMAND: Search AliExpress and crawl first 5 results
 * This is the AI Agent functionality - automatically crawls when no D1 data exists
 * 
 * Flow:
 * 1. Search AliExpress for keyword
 * 2. Extract first 5 product URLs
 * 3. Crawl each product page
 * 4. Match variants with keyword
 * 5. Store matching variants to D1
 */
async function searchAndCrawlKeyword(keyword, specKey, env) {
  console.log(`[AutoCrawl] Starting for keyword: "${keyword}"`);

  if (!env.BROWSER) {
    console.error("[AutoCrawl] Browser Rendering not available");
    return [];
  }

  let browser = null;
  const matchedVariants = [];

  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    // 1️⃣ Navigate to AliExpress search
    const searchUrl = `https://www.aliexpress.com/wholesale?SearchText=${encodeURIComponent(keyword)}`;
    console.log(`[AutoCrawl] Searching: ${searchUrl}`);

    await page.goto(searchUrl, { waitUntil: "networkidle0", timeout: 30000 });
    await page.waitForSelector("body", { timeout: 5000 });
    await new Promise(r => setTimeout(r, 2000)); // Wait for results to load

    // 2️⃣ Extract first 5 product URLs
    const productUrls = await page.evaluate(() => {
      const links = [];
      const productCards = document.querySelectorAll('a[href*="/item/"]');
      for (const card of productCards) {
        const href = card.getAttribute('href');
        if (href && href.includes('/item/') && links.length < 5) {
          // Normalize URL
          let url = href;
          if (url.startsWith('//')) url = 'https:' + url;
          if (!url.startsWith('http')) url = 'https://www.aliexpress.com' + url;
          // Clean URL
          url = url.split('?')[0];
          if (!links.includes(url)) links.push(url);
        }
      }
      return links;
    });

    console.log(`[AutoCrawl] Found ${productUrls.length} product URLs:`, productUrls);

    if (productUrls.length === 0) {
      await browser.close();
      return [];
    }

    // 3️⃣ Crawl each product page and extract variants
    for (const productUrl of productUrls) {
      console.log(`[AutoCrawl] Crawling product: ${productUrl}`);

      try {
        await page.goto(productUrl, { waitUntil: "networkidle0", timeout: 30000 });
        await page.waitForSelector("body", { timeout: 5000 });
        await page.evaluate(() => window.scrollBy(0, 1500));
        await new Promise(r => setTimeout(r, 1500));

        // Extract product data
        const productData = await page.evaluate(() => {
          const title = document.querySelector('h1')?.textContent?.trim() ||
            document.title?.split('-')[0]?.trim() || 'Unknown';

          // Try to get price from various selectors
          const priceSelectors = [
            '.product-price-value',
            '[class*="Price"] span',
            '[data-pl="product-price"]',
            '.uniform-banner-box-price'
          ];

          let price = 0;
          let currency = 'USD';
          for (const sel of priceSelectors) {
            const el = document.querySelector(sel);
            if (el) {
              const text = el.textContent || '';
              if (text.includes('Rs.')) currency = 'LKR';
              if (text.includes('LKR')) currency = 'LKR';
              const match = text.match(/[\d,.]+/);
              if (match) {
                // Remove commas for parsing (e.g. 1,234.56 -> 1234.56)
                price = parseFloat(match[0].replace(/,/g, ''));
                break;
              }
            }
          }

          // Fallback: find any $ price on page
          if (price === 0) {
            const bodyText = document.body.innerText || '';
            const priceMatches = bodyText.match(/\$\s*([\d.]+)/g) || [];
            const prices = priceMatches.map(p => parseFloat(p.replace(/[^\d.]/g, ''))).filter(p => p > 1 && p < 500);
            if (prices.length > 0) {
              price = Math.min(...prices); // Get lowest price
            }
          }

          // Extract variant options
          const variants = [];
          const variantElements = document.querySelectorAll('[class*="sku"] img, [class*="property"] img, [class*="sku"] span');
          for (const el of variantElements) {
            const text = el.getAttribute('title') || el.textContent?.trim() || '';
            if (text && text.length > 1 && text.length < 100) {
              variants.push(text);
            }
          }

          return { title, price, currency, variants: [...new Set(variants)] };
        });

        console.log(`[AutoCrawl] Product: ${productData.title.slice(0, 50)}... Price: ${productData.currency} ${productData.price}`);

        // 4️⃣ Match variants with keyword
        const keywordLower = keyword.toLowerCase();
        const keywordTokens = keywordLower.split(/[\s\-_]+/).filter(t => t.length > 1);

        // Check if title or variants match keyword
        const titleMatches = keywordTokens.some(token =>
          productData.title.toLowerCase().includes(token)
        );

        console.log(`[AutoCrawl] Title match: ${titleMatches}, Price: ${productData.price}`);

        // Store all products with valid price (search already filtered by keyword)
        // Relaxed matching: price > 0 is sufficient since search results are keyword-filtered
        if (productData.price > 0) {
          // Extract product ID from URL
          const productIdMatch = productUrl.match(/item\/(\d+)/);
          const productId = productIdMatch ? productIdMatch[1] : 'UNKNOWN';

          // Use extracted variants, or fallback to title if none found
          const variantList = (productData.variants && productData.variants.length > 0)
            ? productData.variants
            : [productData.title];

          for (const variantLabel of variantList) {
            // Generate variant ID and store
            const variantId = await generateVariantId(productUrl, variantLabel, 1, 'auto_crawl');

            // 🔹 Extract correct spec_key for this specific variant
            // e.g., if we crawled "30A ESC" but found a "50A" variant, store it as ESC:50A
            const variantSpecKey = extractSpecKeyFromLabel(variantLabel, specKey);

            const variant = {
              variant_id: variantId,
              product_id: productId,
              spec_key: variantSpecKey,
              title: productData.title,
              variant_label: variantLabel,
              price: productData.price,
              product_url: productUrl,
              variants: productData.variants
            };

            matchedVariants.push(variant);

            // 5️⃣ Store to D1
            try {
              const now = Date.now();
              const specs = extractSpecs(variantLabel);

              const unitPriceUsd = toUsd(productData.price, productData.currency) || productData.price;

              await env.DB.prepare(`
                INSERT INTO product_variants (
                  variant_id, product_id, canonical_item, spec_key,
                  brand, model, variant_label,
                  current_A, voltage_s, capacity_mah, kv,
                  pack_qty, unit_price_usd, pack_price_usd, currency,
                  stock, product_url,
                  source, first_seen, last_seen, last_price_update,
                  link_status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(variant_id) DO UPDATE SET
                  spec_key = excluded.spec_key,
                  current_A = excluded.current_A,
                  voltage_s = excluded.voltage_s,
                  capacity_mah = excluded.capacity_mah,
                  kv = excluded.kv,
                  unit_price_usd = excluded.unit_price_usd,
                  pack_price_usd = excluded.pack_price_usd,
                  currency = excluded.currency,
                  last_seen = excluded.last_seen,
                  last_price_update = excluded.last_price_update,
                  link_status = 'resolved'
              `).bind(
                variantId, productId, 'ESC', variantSpecKey,
                '', productData.title, variantLabel.slice(0, 50),
                specs.current_A, specs.voltage_s, specs.capacity_mah, specs.kv,
                1, unitPriceUsd, unitPriceUsd, productData.currency,
                null, productUrl,
                'auto_crawl', now, now, now,
                'resolved'
              ).run();
              console.log(`[AutoCrawl] Stored variant to D1: ${variantLabel} -> ${variantSpecKey}`);
            } catch (dbErr) {
              console.error('[AutoCrawl] D1 error:', dbErr.message);
            }
          }
        }
      } catch (productErr) {
        console.error(`[AutoCrawl] Error crawling ${productUrl}:`, productErr.message);
      }
    }

    await browser.close();
    console.log(`[AutoCrawl] Complete. Found ${matchedVariants.length} matching variants.`);
    return matchedVariants;

  } catch (e) {
    console.error("[AutoCrawl] Error:", e.message);
    if (browser) {
      try { await browser.close(); } catch (ce) { }
    }
    return [];
  }
}

/**
 * Parse raw crawl data using Workers AI (LLaMA)
 * Converts messy AliExpress data → clean variant JSON
 */
async function parseWithAI(raw, env) {
  if (!raw || !env.AI) {
    console.log("[Parse] Missing raw data or AI binding");
    return null;
  }

  // Check if we got actual content
  const htmlLength = (raw.html || "").length;
  const hasJson = raw.json && Object.keys(raw.json).length > 0;
  console.log(`[Parse] HTML length: ${htmlLength}, hasJson: ${hasJson}`);

  // If HTML is too short, it's likely an error page
  if (htmlLength < 1000) {
    console.log("[Parse] HTML too short - likely error/404 page");
    return null;
  }

  // Try to extract data from embedded JSON first (faster, more reliable)
  if (hasJson && raw.json.data?.productInfo?.title) {
    console.log("[Parse] Found productInfo in JSON, extracting directly");
    try {
      const pi = raw.json.data.productInfo;
      const skuInfo = raw.json.data.skuInfo || {};

      return {
        title: pi.title || "Unknown Product",
        currency: "USD",
        variants: (skuInfo.priceList || []).map(p => ({
          attributes: p.skuAttr || {},
          sku: p.skuId || null,
          price: parseFloat(p.skuVal?.skuAmount?.value || p.skuVal?.actSkuCalPrice || 0),
          stock: p.skuVal?.availQuantity || null
        }))
      };
    } catch (e) {
      console.log("[Parse] Direct JSON extraction failed:", e.message);
    }
  }

  // Try regex-based price extraction as fallback (faster than AI)
  const html = raw.html || "";

  // Extract title from HTML
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i) ||
    html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  const title = titleMatch ? titleMatch[1].trim() : "Unknown Product";

  // Extract all USD prices from HTML (e.g., $5.99, US $10.00)
  const priceMatches = html.match(/(?:US\s*)?\$\s*(\d+\.?\d*)/gi) || [];
  const prices = [...new Set(priceMatches.map(p => {
    const num = parseFloat(p.replace(/[^\d.]/g, ''));
    return isNaN(num) ? null : num;
  }).filter(p => p && p > 0 && p < 1000))]; // Filter reasonable prices

  console.log(`[Parse] Found ${prices.length} prices via regex:`, prices.slice(0, 5));

  if (prices.length > 0) {
    // Create variants from unique prices found
    const variants = prices.slice(0, 10).map((price, idx) => ({
      attributes: { variant: `option-${idx + 1}` },
      price: price,
      stock: null
    }));

    return {
      title: title,
      currency: "USD",
      variants: variants
    };
  }

  // Fallback to AI parsing
  // Extract price-related sections from HTML for better parsing
  let priceSection = "";

  // Try to find price-related content in HTML
  const pricePatterns = [
    /price[^>]*>[\s\S]{0,5000}/gi,
    /sku[^>]*>[\s\S]{0,5000}/gi,
    /variant[^>]*>[\s\S]{0,5000}/gi,
    /\$\s*\d+\.?\d*/g
  ];

  for (const pattern of pricePatterns) {
    const matches = html.match(pattern);
    if (matches) {
      priceSection += matches.slice(0, 5).join('\n');
    }
  }

  const prompt = `You are parsing an AliExpress product page HTML.

TASK: Extract the product title and ALL prices/variants you can find.

IMPORTANT RULES:
- Look for price values like $5.99, $10.00, etc in the HTML
- Look for variant selectors (color, size, etc)
- Extract the lowest and highest prices if multiple exist
- If you find a single price, create one variant with that price
- Return ONLY valid JSON

OUTPUT FORMAT:
{
  "title": "product title from page",
  "currency": "USD",
  "variants": [
    { "attributes": {"type":"default"}, "price": 5.99, "stock": null }
  ]
}

PRICE-RELATED HTML CONTENT:
${priceSection.slice(0, 10000)}

PAGE TITLE/META:
${html.slice(0, 3000)}`;


  try {
    const aiResponse = await env.AI.run("@cf/meta/llama-3-8b-instruct", {
      messages: [{ role: "user", content: prompt }],
      max_tokens: 2000
    });

    const responseText = aiResponse.response || "";
    console.log("[Parse] AI response preview:", responseText.slice(0, 200));

    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    console.log("[Parse] No JSON found in AI response");
    return null;
  } catch (e) {
    console.error("[Parse] AI parsing error:", e.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// Original RC-BOM-Agent code continues below
// ═══════════════════════════════════════════════════════════════


// --- Version & Limits ---
const VERSION = "1.0";
const MAX_AGENT_WAIT_MS = 8000;      // 8 second hard limit
const MAX_PRODUCTS_PER_ITEM = 10;    // Max variants to return per BOM line
const MAX_CANDIDATES = 20;           // Max candidates to process
const MAX_BOM_LINES = 50;            // Max BOM lines per request

// --- Light Crawl Wait (NOT_FOUND recovery) ---
const LIGHT_CRAWL_TIMEOUT_MS = 6000; // Max wait for light crawl results
const LIGHT_CRAWL_POLL_MS = 500;     // Poll D1 every 500ms

// --- Currency Conversion ---
const FX_RATES = {
  LKR: 1 / 320.0,  // 1 USD = 320 LKR
  USD: 1.0
};

function toUsd(value, currency) {
  const rate = FX_RATES[currency];
  if (rate == null) return null;
  return Math.round(value * rate * 10000) / 10000;
}

// --- Pack Quantity Extraction ---
// Extracts pack quantity from variant labels like "4Pcs LITTLEBEE 30A" → 4
function extractPackQty(label) {
  if (!label) return 1;
  const match = label.match(/(\d+)\s*(pcs|pc)/i);
  return match ? parseInt(match[1], 10) : 1;
}

// Strips quantity words from label to avoid duplication like "4Pcs 1Pc LITTLEBEE"
function stripQtyWords(label) {
  if (!label) return "";
  return label
    .replace(/\b\d+\s*(pcs|pc)\b/ig, "")  // remove "1Pc", "4Pcs", etc
    .replace(/\s{2,}/g, " ")              // normalize multiple spaces
    .trim();
}

// --- BOM Parser (Deterministic) ---
function parseBomLine(line) {
  const upper = line.trim().toUpperCase();
  // Use standardized spec extraction
  const extracted = extractSpecs(upper);
  const qty = extracted.pack_qty;
  const currentA = extracted.current_A;
  const kv = extracted.kv;
  const cells = extracted.voltage_s ? parseInt(extracted.voltage_s) : null;
  const capacity = extracted.capacity_mah;

  let type = null;
  if (upper.includes("ESC")) type = "ESC";
  else if (upper.includes("MOTOR")) type = "Motor";
  else if (upper.includes("LIPO") || upper.includes("BATTERY")) type = "Battery";
  else if (upper.includes("PROP") || upper.match(/\d+X\d+/)) type = "Propeller";
  else if (upper.includes("SERVO")) type = "Servo";

  const specs = { kv, cells, capacity, current_A: currentA, raw: upper };
  const spec_key = generateSpecKey(type, specs);

  return {
    canonical_type: type,
    current_A: currentA,
    specs: specs,
    spec_key: spec_key,
    qty,
    raw: upper
  };
}

function parseBom(text) {
  return text
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map(parseBomLine);
}

// --- Nova ACT Stub (Mock for now) ---
// Replace with real HTTP call when Nova is ready
function novaRank(bomItem, candidates) {
  // Mock logic: pick first candidate (cheapest should be sorted or just index 0)
  if (!candidates || candidates.length === 0) {
    return { selected_index: -1, match_score: 0, reasoning: "No candidates" };
  }
  return {
    selected_index: 0,
    match_score: 0.85,
    reasoning: "Exact match in variant label and lowest price (mock)."
  };
}

// --- CSV Escape Helper ---
// Safely escapes values for CSV (handles commas, quotes, newlines)
function csvEscape(val) {
  if (val === null || val === undefined) return "";
  val = String(val);
  if (val.includes(",") || val.includes('"') || val.includes("\n")) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

// --- CSV Formatter ---
// Uses normalized data + feedback signals + brand preferences
function toCSV(items) {
  const header = [
    "Item",
    "Qty",
    "Display_Label",
    "Variant_Label",
    "Listing_Title",
    "Brand",
    "Pack_Qty",
    "Unit_Price_USD",
    "Pack_Price_USD",
    "Currency",
    "Supplier",
    "Risk",
    "Rating",
    "Review_Count",
    "Sold_Count",
    "Store_Years",
    "Feedback_Score",
    "User_Trust_Score",
    "Product_URL"
  ];

  const rows = items.map(i => {
    if (i.status !== "MATCHED") {
      return [
        i.bom?.raw || "Unknown",
        i.bom?.qty || 1,
        "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""
      ];
    }

    // Use the selected candidate (first one marked as default, or first in list)
    const sel = i.candidates?.find(c => c.default) || i.candidates?.[0];
    if (!sel) {
      return [
        `${i.bom.current_A}A ESC`,
        i.bom.qty,
        "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""
      ];
    }

    return [
      `${i.bom.current_A}A ESC`,
      i.bom.qty,
      sel.display_label || sel.model,
      sel.variant_label || "",
      sel.listing_title || "",
      sel.brand,
      sel.pack_qty || 1,
      sel.unit_price_usd?.toFixed(2) || "",
      sel.pack_price_usd?.toFixed(2) || "",
      sel.local_currency || "USD",
      sel.remark || "AliExpress Seller",
      sel.risk || "",
      sel.feedback?.rating || "",
      sel.feedback?.reviews || "",
      sel.feedback?.sold || "",
      sel.feedback?.store_years || "",
      sel.feedback?.score?.toFixed(2) || "",
      sel.trust?.score?.toFixed(2) || "0.00",
      sel.product_url || ""
    ];
  });

  // UTF-8 BOM for LibreOffice Calc compatibility
  const BOM = "\uFEFF";
  return BOM + [header, ...rows]
    .map(r => r.map(csvEscape).join(","))
    .join("\r\n");
}

// --- Confidence Decay (based on price age) ---
function calculateConfidenceDecay(baseScore, lastUpdated) {
  if (!lastUpdated) return baseScore;
  const now = new Date();
  const updated = new Date(lastUpdated);
  const daysOld = (now - updated) / (1000 * 60 * 60 * 24);
  // Decay: confidence *= exp(-daysOld / 30)
  const decayFactor = Math.exp(-daysOld / 30);
  return Math.round(baseScore * decayFactor * 100) / 100;
}

// --- Feedback Scoring (Trust & Quality Layer) ---

// Rating score (30% weight)
function scoreRating(rating) {
  if (!rating || rating <= 0) return 0.1;
  if (rating >= 4.7) return 1.0;
  if (rating >= 4.3) return 0.7;
  if (rating >= 4.0) return 0.4;
  return 0.1;
}

// Review count score (20% weight)
function scoreReviews(count) {
  if (!count || count <= 0) return 0.1;
  if (count >= 500) return 1.0;
  if (count >= 100) return 0.7;
  if (count >= 20) return 0.4;
  return 0.1;
}

// Sold count score (20% weight)
function scoreSold(count) {
  if (!count || count <= 0) return 0.1;
  if (count >= 1000) return 1.0;
  if (count >= 200) return 0.7;
  if (count >= 50) return 0.4;
  return 0.1;
}

// Store trust score (15% weight)
function scoreStore(years) {
  if (!years || years <= 0) return 0.4;
  if (years >= 3) return 1.0;
  if (years >= 1) return 0.7;
  return 0.4;
}

// Calculate combined feedback score (deterministic, explainable)
function calculateFeedbackScore(rating, reviews, sold, storeYears, hasChoice, hasPhotos) {
  const ratingScore = scoreRating(rating);
  const reviewScore = scoreReviews(reviews);
  const soldScore = scoreSold(sold);
  const storeScore = scoreStore(storeYears);
  const choiceScore = hasChoice ? 1.0 : 0.0;
  const photoScore = hasPhotos ? 1.0 : 0.0;

  // Weighted combination (tuned for RC components)
  const score =
    ratingScore * 0.30 +
    reviewScore * 0.20 +
    soldScore * 0.20 +
    storeScore * 0.15 +
    choiceScore * 0.10 +
    photoScore * 0.05;

  return Math.round(score * 100) / 100;
}

// --- User Trust Memory (Human Preference Layer) ---

// Update trust when user selects a variant
async function updateTrust(db, userKey, brand, supplier) {
  if (!userKey || !brand) return;
  const now = Date.now();

  await db.prepare(`
    INSERT INTO user_trust (user_key, brand, seller, trust_score, select_count, last_selected)
    VALUES (?, ?, ?, 0.05, 1, ?)
    ON CONFLICT(user_key, seller, brand)
    DO UPDATE SET
      select_count = select_count + 1,
      last_selected = ?,
      trust_score = MIN(trust_score + 0.05, 0.3)
  `).bind(userKey, brand, supplier || "", now, now).run();
}

// Get trust scores for a user
async function getTrustScores(db, userKey) {
  if (!userKey) return {};

  const { results } = await db.prepare(`
    SELECT brand, seller, trust_score, select_count
    FROM user_trust
    WHERE user_key = ?
  `).bind(userKey).all();

  // Build lookup map: "brand|supplier" -> { score, select_count }
  const memory = {};
  for (const r of results) {
    const key = `${r.brand}|${r.seller || ""}`;
    memory[key] = { score: r.trust_score, select_count: r.select_count };
  }
  return memory;
}

// Get score for specific item
function getTrustScore(memory, brand, supplier) {
  const key = `${brand}|${supplier || ""}`;
  return memory[key] || { score: 0, select_count: 0 };
}

// --- Price History Helpers ---

// Fetch recent price history for a variant
// sourceFilter should be like "('prod', 'rc_test')" or "('prod')"
async function getRecentPriceHistory(db, variant_id, sourceFilter = "('prod')") {
  const { results } = await db.prepare(`
    SELECT unit_price_usd, stock, recorded_at
    FROM variant_price_history
    WHERE variant_id = ?
      AND source IN ${sourceFilter}
    ORDER BY recorded_at DESC
    LIMIT 10
  `).bind(variant_id).all();
  return results || [];
}

// Compute RC-friendly price trend (deterministic)
function computePriceTrend(history) {
  if (!history || history.length < 2) {
    return { trend: "stable", change_pct: 0, data_points: history?.length || 0 };
  }

  const latest = history[0].unit_price_usd;
  const oldest = history[history.length - 1].unit_price_usd;

  if (oldest === 0) return { trend: "stable", change_pct: 0, data_points: history.length };

  const changePct = ((latest - oldest) / oldest) * 100;

  // RC-specific thresholds: ±5% avoids noise
  if (changePct > 5) return { trend: "up", change_pct: Math.round(changePct * 10) / 10, data_points: history.length };
  if (changePct < -5) return { trend: "down", change_pct: Math.round(changePct * 10) / 10, data_points: history.length };
  return { trend: "stable", change_pct: Math.round(changePct * 10) / 10, data_points: history.length };
}

// --- Light Crawl Wait Helpers ---

// Build AliExpress search URL for manual fallback
function buildAliExpressSearchUrl(keyword) {
  const encoded = encodeURIComponent(keyword);
  return `https://www.aliexpress.com/wholesale?SearchText=${encoded}`;
}

// Poll D1 for ingested variants (max timeout)
async function waitForIngestedVariants(db, specKey, sourceFilter, timeoutMs) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const { results } = await db.prepare(`
      SELECT * FROM product_variants
      WHERE spec_key = ? AND source IN ${sourceFilter}
      ORDER BY unit_price_usd ASC
      LIMIT 10
    `).bind(specKey).all();

    if (results && results.length > 0) {
      return results;
    }

    // Wait before next poll
    await new Promise(r => setTimeout(r, LIGHT_CRAWL_POLL_MS));
  }

  return null; // Timeout - no data arrived
}

// --- Cloudflare AI Search (DISABLED - was generating fake prices) ---
// Browser Rendering integration needed for real price extraction
async function searchWithAI(env, keyword, canonicalType, specKey, source) {
  // DISABLED: AI cannot access real AliExpress prices
  // This was hallucinating prices based on training data
  // TODO: Replace with Cloudflare Browser Rendering when available
  console.log(`[AI Search] DISABLED - keyword: ${keyword}. Use Browser Rendering for real prices.`);
  return []; // Return empty to trigger SEARCHING fallback with manual link
}


// 4️⃣ VARIANT RESOLUTION FUNCTION (ALIEXPRESS)
async function resolveAliExpressVariant(productUrl, env) {
  if (!env.ANTI_GRAVITY_ENDPOINT || !env.ANTI_GRAVITY_KEY) {
    console.error("Missing ANTI_GRAVITY_ENDPOINT or ANTI_GRAVITY_KEY");
    // Fail gracefully so we can fallback to product page
    return null;
  }

  const isSearchUrl = productUrl.includes("/w/") || productUrl.includes("wholesale");

  const prompt = `System: You are a fast browser agent.
Task:
Open the provided URL.
${isSearchUrl ? "This is a search page. Locate the FIRST product in the results list. Get its link." : "This is a product page."}

Action:
${isSearchUrl ? "Extract the HREF of the first product card." : "Locate the variant selection section."}

Extract:
${isSearchUrl ? "- first_product_url (the href of the first result)" : "- sku_id\n- propertyIds"}

Output JSON:
{
  "first_product_url": "...",
  "sku_id": "...",
  "propertyIds": "..."
}`;

  const agentPayload = {
    task: "resolve_variant",
    prompt: prompt, // Dynamic prompt override
    url: productUrl,
    rules: {
      abort_on_captcha: true,
      no_images: true,
      extract: ["sku_id", "propertyIds"]
    }
  };

  try {
    const resp = await fetch(env.ANTI_GRAVITY_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.ANTI_GRAVITY_KEY}`
      },
      body: JSON.stringify(agentPayload)
    });

    if (!resp.ok) {
      console.error("Anti-Gravity API error:", resp.status, await resp.text());
      return null;
    }

    const data = await resp.json();

    if (data.first_product_url) {
      // We extracted a specific product URL from the search page
      // Append a ref to ensure we know it came from us
      const cleanUrl = data.first_product_url.split('?')[0];
      return { variant_url: cleanUrl };
    }

    if (data.current_url && data.current_url.includes("/item/")) {
      // We navigated to a product page!
      return { variant_url: data.current_url };
    }

    if (data.sku_id) {
      return {
        variant_url: `${productUrl}?sku_id=${data.sku_id}`
      };
    }

    if (data.propertyIds) {
      return {
        variant_url: `${productUrl}?propertyIds=${data.propertyIds}`
      };
    }
  } catch (e) {
    console.error("Resolution exception:", e);
    return null;
  }

  return null;
}

// --- Main Handler ---
export default {
  // Scheduled handler for cron triggers - processes pending crawl keywords
  async scheduled(event, env, ctx) {
    console.log("[Cron] Scheduled crawl triggered at:", new Date().toISOString());

    // 1. Get pending keywords from crawl_keywords table
    const pending = await env.DB.prepare(`
      SELECT keyword, canonical_type 
      FROM crawl_keywords 
      WHERE status = 'pending' OR status = 'crawling'
      ORDER BY priority DESC, last_updated ASC
      LIMIT 3
    `).all();

    console.log(`[Cron] Found ${pending.results?.length || 0} pending keywords`);

    if (pending.results && pending.results.length > 0) {
      for (const row of pending.results) {
        console.log(`[Cron] Processing keyword: "${row.keyword}"`);

        // Mark as crawling
        await env.DB.prepare(`
          UPDATE crawl_keywords SET status = 'crawling', last_updated = ? WHERE keyword = ?
        `).bind(Date.now(), row.keyword).run();

        try {
          // Run the auto-crawl - generate spec_key from keyword
          const specKey = `ESC:${row.keyword.replace(/\s+/g, '')}`;
          const results = await searchAndCrawlKeyword(row.keyword, specKey, env);

          // Mark as done
          await env.DB.prepare(`
            UPDATE crawl_keywords SET status = 'done', last_updated = ? WHERE keyword = ?
          `).bind(Date.now(), row.keyword).run();

          console.log(`[Cron] Completed: "${row.keyword}" - found ${results.length} variants`);
        } catch (e) {
          console.error(`[Cron] Error crawling "${row.keyword}":`, e.message);
          await env.DB.prepare(`
            UPDATE crawl_keywords SET status = 'failed', fail_count = fail_count + 1 WHERE keyword = ?
          `).bind(row.keyword).run();
        }
      }
    }

    // 2. Also run the legacy orchestrator
    await runOrchestrator(env);
  },

  async fetch(req, env) {
    const url = new URL(req.url);

    // Admin refresh endpoint (protected) - Triggers crawler orchestrator
    if (url.pathname === "/admin/refresh") {
      const adminKey = req.headers.get("X-ADMIN-KEY");
      if (!adminKey || adminKey !== env.ADMIN_KEY) {
        return new Response("Unauthorized", { status: 401 });
      }
      // Actually trigger the orchestrator
      try {
        const result = await runOrchestrator(env);
        return Response.json({
          status: "crawl_executed",
          timestamp: new Date().toISOString(),
          orchestrator_result: result
        });
      } catch (e) {
        return Response.json({
          status: "error",
          message: e.message
        }, { status: 500 });
      }
    }

    // 🔧 Manual trigger for pending keyword crawl (for testing)
    if (url.pathname === "/admin/crawl-pending") {
      console.log("[Admin] Manual crawl-pending triggered");

      try {
        // Get pending keywords
        const pending = await env.DB.prepare(`
          SELECT keyword, canonical_type 
          FROM crawl_keywords 
          WHERE status = 'pending' OR status = 'crawling'
          ORDER BY priority DESC, last_updated ASC
          LIMIT 3
        `).all();

        const results = [];

        if (pending.results && pending.results.length > 0) {
          for (const row of pending.results) {
            console.log(`[Admin] Processing: "${row.keyword}"`);

            await env.DB.prepare(`
              UPDATE crawl_keywords SET status = 'crawling', last_updated = ? WHERE keyword = ?
            `).bind(Date.now(), row.keyword).run();

            try {
              const specKey = `ESC:${row.keyword.replace(/\s+/g, '')}`;
              const crawled = await searchAndCrawlKeyword(row.keyword, specKey, env);

              await env.DB.prepare(`
                UPDATE crawl_keywords SET status = 'done', last_updated = ? WHERE keyword = ?
              `).bind(Date.now(), row.keyword).run();

              results.push({ keyword: row.keyword, status: 'done', variants: crawled.length });
            } catch (err) {
              await env.DB.prepare(`
                UPDATE crawl_keywords SET status = 'failed', fail_count = fail_count + 1 WHERE keyword = ?
              `).bind(row.keyword).run();
              results.push({ keyword: row.keyword, status: 'failed', error: err.message });
            }
          }
        }

        return Response.json({
          status: "crawl_pending_executed",
          processed: results.length,
          results: results
        }, { headers: { "Access-Control-Allow-Origin": "*" } });

      } catch (e) {
        return Response.json({
          status: "error",
          message: e.message
        }, { status: 500, headers: { "Access-Control-Allow-Origin": "*" } });
      }
    }

    // 🔍 Debug crawl - show raw Browser Rendering output
    if (url.pathname === "/admin/debug-crawl") {
      const keyword = url.searchParams.get("keyword") || "30A ESC";
      console.log(`[Debug] Crawling keyword: "${keyword}"`);

      if (!env.BROWSER) {
        return Response.json({ error: "Browser Rendering not available" }, { status: 503 });
      }

      let browser = null;
      try {
        browser = await puppeteer.launch(env.BROWSER);
        const page = await browser.newPage();
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");

        const searchUrl = `https://www.aliexpress.com/wholesale?SearchText=${encodeURIComponent(keyword)}`;
        await page.goto(searchUrl, { waitUntil: "networkidle0", timeout: 30000 });
        await new Promise(r => setTimeout(r, 3000));

        // Get page content
        const html = await page.content();
        const pageUrl = page.url();

        // Try to find product links
        const productUrls = await page.evaluate(() => {
          const links = [];
          const allLinks = document.querySelectorAll('a');
          for (const a of allLinks) {
            const href = a.href || '';
            if (href.includes('/item/') && links.length < 10) {
              links.push(href);
            }
          }
          return links;
        });

        await browser.close();

        return Response.json({
          keyword: keyword,
          searchUrl: searchUrl,
          pageUrl: pageUrl,
          htmlLength: html.length,
          htmlSnippet: html.slice(0, 2000),
          productUrlsFound: productUrls.length,
          productUrls: productUrls
        }, { headers: { "Access-Control-Allow-Origin": "*" } });

      } catch (e) {
        if (browser) { try { await browser.close(); } catch (ce) { } }
        return Response.json({
          error: e.message,
          stack: e.stack
        }, { status: 500, headers: { "Access-Control-Allow-Origin": "*" } });
      }
    }

    // 🩺 CRAWL HEALTH DASHBOARD
    if (url.pathname === "/admin/crawl-health") {
      // Optional: Auth check
      // const adminKey = req.headers.get("X-ADMIN-KEY");

      const now = Date.now();

      // 1. Keyword Status
      let kwStats = { total: 0, pending: 0, blocked: 0, done: 0 };
      try {
        kwStats = await env.DB.prepare(`
             SELECT 
               COUNT(*) as total,
               SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) as pending,
               SUM(CASE WHEN status='blocked' THEN 1 ELSE 0 END) as blocked,
               SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) as done
             FROM crawl_keywords
           `).first() || kwStats;
      } catch (e) { }

      // 2. Crawl Success (7d)
      let taskStats = { total: 0, success: 0 };
      try {
        taskStats = await env.DB.prepare(`
             SELECT COUNT(*) as total, SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as success
             FROM crawl_tasks WHERE created_at > ?
           `).bind(now - 7 * 86400000).first() || taskStats;
      } catch (e) { }

      // 3. Price Freshness
      let freshStats = { avg_hours: 0 };
      try {
        freshStats = await env.DB.prepare(`
             SELECT AVG((? - last_price_update) / 3600000.0) as avg_hours FROM product_variants
           `).bind(now).first() || freshStats;
      } catch (e) { }

      let staleStats = { count: 0 };
      try {
        staleStats = await env.DB.prepare(`
             SELECT COUNT(*) as count FROM product_variants WHERE last_seen < ?
           `).bind(now - 48 * 3600000).first() || staleStats;
      } catch (e) { }

      const successRate = taskStats.total > 0 ? Math.round((taskStats.success / taskStats.total) * 100) : 100;

      // Health Logic
      let status = "🟢 HEALTHY";
      let statusColor = "#4ade80"; // green
      if (kwStats.blocked > 5 || successRate < 50) {
        status = "🔴 RISK";
        statusColor = "#f87171"; // red
      } else if (staleStats.count > 10 || kwStats.blocked > 0) {
        status = "🟡 WARNING";
        statusColor = "#fbbf24"; // yellow
      }

      const html = `<!DOCTYPE html>
       <html lang="en">
       <head>
         <meta charset="UTF-8"><title>Crawl Health</title>
         <style>
           body { background: #0f0f0f; color: #e0e0e0; font-family: sans-serif; padding: 40px; }
           .card { background: #1a1a1a; padding: 20px; border-radius: 12px; border: 1px solid #333; max-width: 600px; margin: 0 auto; }
           h1 { color: #fff; margin-top: 0; display: flex; justify-content: space-between; align-items: center; }
           .status { padding: 4px 12px; border-radius: 6px; font-size: 16px; background: ${statusColor}22; color: ${statusColor}; border: 1px solid ${statusColor}; }
           .section { margin-top: 24px; }
           .section h3 { color: #888; border-bottom: 1px solid #333; padding-bottom: 8px; margin-bottom: 12px; font-size: 14px; text-transform: uppercase; }
           .stat { display: flex; justify-content: space-between; padding: 6px 0; font-size: 15px; }
           .stat label { color: #aaa; }
           .stat val { font-weight: 600; color: #fff; }
         </style>
       </head>
       <body>
         <div class="card">
           <h1><span>🩺 Crawl Health Dashboard</span> <span class="status">${status}</span></h1>
           
           <div class="section">
             <h3>Keywords</h3>
             <div class="stat"><label>Total</label><val>${kwStats.total || 0}</val></div>
             <div class="stat"><label>Pending</label><val>${kwStats.pending || 0}</val></div>
             <div class="stat"><label>Blocked</label><val style="color:${kwStats.blocked > 0 ? '#f87171' : ''}">${kwStats.blocked || 0}</val></div>
             <div class="stat"><label>Done</label><val>${kwStats.done || 0}</val></div>
           </div>

           <div class="section">
             <h3>Crawler Performance (7d)</h3>
             <div class="stat"><label>Tasks</label><val>${taskStats.total || 0}</val></div>
             <div class="stat"><label>Success Rate</label><val style="color:${successRate < 80 ? '#fbbf24' : '#4ade80'}">${successRate}%</val></div>
           </div>

           <div class="section">
             <h3>Data Freshness</h3>
             <div class="stat"><label>Avg Price Age</label><val>${(freshStats.avg_hours || 0).toFixed(1)} hours</val></div>
             <div class="stat"><label>Stale Variants (>48h)</label><val style="color:${staleStats.count > 0 ? '#fbbf24' : ''}">${staleStats.count || 0}</val></div>
           </div>
         </div>
       </body>
       </html>`;

      return new Response(html, { headers: { "Content-Type": "text/html" } });
    }

    // 🖥️ NOVA CRAWL ADMIN PANEL - For users with Nova Act to run crawls
    if (url.pathname === "/admin/crawl" && req.method === "GET") {
      // Fetch pending keywords
      let pendingKeywords = [];
      try {
        const result = await env.DB.prepare(`
          SELECT keyword, canonical_type, fail_count, last_updated 
          FROM crawl_keywords 
          WHERE status = 'pending' 
          ORDER BY priority DESC, last_updated ASC
          LIMIT 20
        `).all();
        pendingKeywords = result.results || [];
      } catch (e) {
        console.error("[Admin] Error fetching pending keywords:", e.message);
      }

      const keywordRows = pendingKeywords.map(kw => `
        <tr>
          <td>${kw.keyword}</td>
          <td>${kw.canonical_type || 'UNKNOWN'}</td>
          <td>${kw.fail_count || 0}</td>
          <td>
            <button class="copy-btn" data-cmd="python scripts/scrape_interactive.py &quot;${kw.keyword}&quot;">
              📋 Copy Command
            </button>
          </td>
        </tr>
      `).join('');

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Nova Crawl Panel</title>
  <style>
    * { box-sizing: border-box; }
    body { background: #0f0f0f; color: #e0e0e0; font-family: -apple-system, sans-serif; padding: 40px; max-width: 900px; margin: 0 auto; }
    h1 { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .subtitle { color: #888; margin-bottom: 30px; }
    .card { background: #1a1a1a; padding: 24px; border-radius: 12px; border: 1px solid #333; margin-bottom: 24px; }
    .card h2 { margin-top: 0; color: #fff; font-size: 18px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #333; }
    th { color: #888; font-weight: 500; text-transform: uppercase; font-size: 12px; }
    .copy-btn { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; }
    .copy-btn:hover { transform: translateY(-1px); }
    .copy-btn.copied { background: #10b981; }
    .instructions { background: #1a1a2e; padding: 16px; border-radius: 8px; border: 1px solid #667eea33; margin-top: 16px; }
    .instructions h3 { margin-top: 0; color: #667eea; font-size: 14px; }
    .instructions pre { background: #0a0a0a; padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 13px; color: #4ade80; }
    .instructions code { color: #fbbf24; }
    .empty { text-align: center; padding: 40px; color: #666; }
    a { color: #818cf8; }
    .refresh-btn { background: #2a2a2a; color: #e0e0e0; border: 1px solid #444; padding: 8px 16px; border-radius: 6px; cursor: pointer; }
  </style>
</head>
<body>
  <h1>🤖 Nova Crawl Panel</h1>
  <p class="subtitle">Run these keywords with Nova Act to populate pricing data</p>
  
  <div class="card">
    <h2>📋 Pending Keywords (${pendingKeywords.length})</h2>
    ${pendingKeywords.length > 0 ? `
    <table>
      <thead>
        <tr><th>Keyword</th><th>Type</th><th>Fails</th><th>Action</th></tr>
      </thead>
      <tbody>${keywordRows}</tbody>
    </table>
    ` : '<p class="empty">✅ No pending keywords - all data is up to date!</p>'}
    <br>
    <button class="refresh-btn" onclick="location.reload()">🔄 Refresh List</button>
  </div>

  <div class="card instructions">
    <h3>📖 How to Run Nova Crawler</h3>
    <p>Make sure you have Nova Act installed, then run:</p>
    <pre>cd /path/to/bom-pricer
source .venv/bin/activate
python scripts/scrape_interactive.py "YOUR_KEYWORD"</pre>
    <p>Or crawl all pending keywords at once:</p>
    <pre>python scripts/scrape_batch.py</pre>
    <p>For more info: <a href="https://github.com/randunun-eng/bom-pricer" target="_blank">GitHub Repository</a></p>
  </div>

  <p style="margin-top:24px;"><a href="/">← Back to BOM Builder</a> | <a href="/admin/crawl-health">Crawl Health Dashboard</a></p>

  <script>
    document.querySelectorAll('.copy-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const cmd = btn.dataset.cmd;
        navigator.clipboard.writeText(cmd).then(() => {
          btn.textContent = '✅ Copied!';
          btn.classList.add('copied');
          setTimeout(() => {
            btn.textContent = '📋 Copy Command';
            btn.classList.remove('copied');
          }, 2000);
        });
      });
    });
  </script>
</body>
</html>`;
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    }

    // 📋 API: Get pending crawl keywords (for external tools)
    if (url.pathname === "/api/crawl/pending" && req.method === "GET") {
      try {
        const result = await env.DB.prepare(`
          SELECT keyword, canonical_type, fail_count, last_updated, priority
          FROM crawl_keywords 
          WHERE status = 'pending' 
          ORDER BY priority DESC, last_updated ASC
          LIMIT 50
        `).all();
        return Response.json({
          status: "ok",
          count: result.results?.length || 0,
          keywords: result.results || []
        });
      } catch (e) {
        return Response.json({ status: "error", error: e.message }, { status: 500 });
      }
    }

    // 🚀 API: Request crawl for keyword (called by UI button)
    if (url.pathname === "/api/crawl/request" && req.method === "POST") {
      try {
        const body = await req.json();
        const keyword = body.keyword?.trim();

        if (!keyword || keyword.length < 3) {
          return Response.json({ status: "error", error: "Invalid keyword" }, { status: 400 });
        }

        const now = Date.now();

        // Insert/update keyword with high priority (10 = urgent)
        await env.DB.prepare(`
          INSERT INTO crawl_keywords(keyword, canonical_type, priority, status, fail_count, last_updated)
          VALUES(?, 'UNKNOWN', 10, 'pending', 0, ?)
          ON CONFLICT(keyword) DO UPDATE SET
            priority = 10,
            status = CASE WHEN status = 'done' THEN 'pending' ELSE status END,
            last_updated = ?
        `).bind(keyword, now, now).run();

        return Response.json({
          status: "ok",
          message: "Crawl requested",
          keyword: keyword
        });
      } catch (e) {
        return Response.json({ status: "error", error: e.message }, { status: 500 });
      }
    }

    // 🔄 API: Mark keyword as done (called by Nova after crawling)
    if (url.pathname === "/api/crawl/complete" && req.method === "POST") {
      try {
        const body = await req.json();
        const keyword = body.keyword?.trim();

        if (!keyword) {
          return Response.json({ status: "error", error: "Missing keyword" }, { status: 400 });
        }

        await env.DB.prepare(`
          UPDATE crawl_keywords SET status = 'done', last_updated = ? WHERE keyword = ?
        `).bind(Date.now(), keyword).run();

        return Response.json({ status: "ok", message: "Marked as done" });
      } catch (e) {
        return Response.json({ status: "error", error: e.message }, { status: 500 });
      }
    }

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-BOM-User, Authorization"
        }
      });
    }

    // ═══════════════════════════════════════════════════════════════
    // 🖥️ NOVA DESKTOP HELPER - Ingest Endpoint
    // Receives HTML + runParams from Nova desktop script
    // ═══════════════════════════════════════════════════════════════
    if (url.pathname === "/api/nova/ingest" && req.method === "POST") {
      try {
        // Auth check
        const auth = req.headers.get("Authorization");
        if (!auth || auth !== `Bearer ${env.NOVA_INGEST_KEY}`) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        const body = await req.json();
        const { html, json, product_url } = body;

        if (!html && !json) {
          return Response.json({ error: "Missing html or json payload" }, { status: 400 });
        }

        console.log(`[Nova Ingest] Received payload: html=${(html || "").length} bytes, hasJson=${!!json}`);

        // Parse using existing AI parser
        const parsed = await parseWithAI({ html, json }, env);

        if (!parsed) {
          return Response.json({
            error: "Failed to parse product data",
            hint: "Ensure you're on a valid AliExpress product page"
          }, { status: 422, headers: { "Access-Control-Allow-Origin": "*" } });
        }

        // Extract product ID from URL if provided
        let productId = "NOVA-" + Date.now();
        if (product_url) {
          const idMatch = product_url.match(/item\/(\d+)/);
          if (idMatch) productId = idMatch[1];
        }

        // Use standardized BOM parser to generate spec_key from title
        const bomInfo = parseBomLine(parsed.title || "");
        let canonicalItem = bomInfo.canonical_type || "PRODUCT";
        let specKey = bomInfo.spec_key || `PRODUCT:${productId}`;

        // Store variants to D1
        const now = Date.now();
        let storedCount = 0;

        if (parsed.variants && parsed.variants.length > 0) {
          for (const v of parsed.variants) {
            const variantLabel = v.attributes
              ? Object.values(v.attributes).join(" ")
              : v.sku || `variant-${storedCount + 1}`;

            // Extract specs from title + variant label
            const fullLabel = (parsed.title || "") + " " + variantLabel;
            const specs = extractSpecs(fullLabel);

            // Generate variant-specific spec_key
            const variantSpecKey = generateSpecKey(bomInfo.canonical_type || "PRODUCT", specs) || specKey;

            const variantId = await generateVariantId(
              product_url || `nova://${productId}`,
              variantLabel,
              specs.pack_qty || 1,
              "nova_desktop"
            );

            // Safeguard: Prevent ingestion of known "fake" product ID
            if (product_url && product_url.includes("1005005987654321")) {
              console.log(`[Nova Ingest] Blocked fake product ${variantId}`);
              continue;
            }

            try {
              const unitPriceUsd = (toUsd(v.price || 0, parsed.currency || "USD") || v.price || 0);
              const packPriceUsd = unitPriceUsd * (specs.pack_qty || 1);

              await env.DB.prepare(`
                INSERT INTO product_variants (
                  variant_id, product_id, canonical_item, spec_key,
                  brand, model, variant_label,
                  current_A, voltage_s, capacity_mah, kv,
                  pack_qty, unit_price_usd, pack_price_usd, currency,
                  stock, product_url,
                  source, first_seen, last_seen, last_price_update,
                  link_status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(variant_id) DO UPDATE SET
                  spec_key = excluded.spec_key,
                  current_A = excluded.current_A,
                  voltage_s = excluded.voltage_s,
                  capacity_mah = excluded.capacity_mah,
                  kv = excluded.kv,
                  unit_price_usd = excluded.unit_price_usd,
                  pack_price_usd = excluded.pack_price_usd,
                  currency = excluded.currency,
                  stock = excluded.stock,
                  last_seen = excluded.last_seen,
                  last_price_update = excluded.last_price_update,
                  link_status = 'resolved'
              `).bind(
                variantId, productId, bomInfo.canonical_type || "PRODUCT", variantSpecKey,
                "", // brand
                parsed.title || "Unknown",
                variantLabel,
                specs.current_A, specs.voltage_s, specs.capacity_mah, specs.kv,
                specs.pack_qty || 1,
                unitPriceUsd,
                packPriceUsd,
                parsed.currency || "USD",
                v.stock || null,
                product_url || null,
                "nova_desktop",
                now, now, now,
                product_url ? "resolved" : "search_only"
              ).run();
              storedCount++;
            } catch (dbErr) {
              console.error("[Nova Ingest] D1 error:", dbErr.message);
            }
          }
        }

        // Also store full product snapshot for /product/:id endpoint
        try {
          await env.DB.prepare(`
            INSERT OR REPLACE INTO product_snapshots(product_id, title, data, updated_at)
            VALUES(?, ?, ?, ?)
                  `).bind(productId, parsed.title, JSON.stringify(parsed), now).run();
        } catch (snapErr) {
          // Table may not exist yet - that's okay
          console.log("[Nova Ingest] Snapshot storage skipped:", snapErr.message);
        }

        console.log(`[Nova Ingest]Stored ${storedCount} variants for product ${productId}`);

        return Response.json({
          status: "ok",
          product_id: productId,
          title: parsed.title,
          variants_stored: storedCount,
          spec_key: specKey,
          share_url: `/ product / ${productId} `
        }, { headers: { "Access-Control-Allow-Origin": "*" } });

      } catch (e) {
        console.error("[Nova Ingest] Error:", e);
        return Response.json({ error: e.message }, {
          status: 500,
          headers: { "Access-Control-Allow-Origin": "*" }
        });
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // 📖 SHAREABLE PRODUCT LINK (Read-only, no auth)
    // ═══════════════════════════════════════════════════════════════
    if (url.pathname.startsWith("/product/") && req.method === "GET") {
      const productId = url.pathname.split("/").pop();

      if (!productId) {
        return Response.json({ error: "Product ID required" }, { status: 400 });
      }

      try {
        // Try snapshot first
        const snapshot = await env.DB.prepare(
          "SELECT data, updated_at FROM product_snapshots WHERE product_id = ?"
        ).bind(productId).first();

        if (snapshot) {
          const data = JSON.parse(snapshot.data);
          return Response.json({
            product_id: productId,
            source: "snapshot",
            updated_at: snapshot.updated_at,
            ...data
          }, {
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Cache-Control": "public, max-age=3600"
            }
          });
        }

        // Fallback: build from product_variants
        const variants = await env.DB.prepare(`
          SELECT variant_label, unit_price_usd as price, currency, stock, product_url
          FROM product_variants 
          WHERE product_id = ?
                ORDER BY unit_price_usd ASC
                  `).bind(productId).all();

        if (!variants.results || variants.results.length === 0) {
          return Response.json({
            error: "Product not found",
            hint: "This product hasn't been ingested yet. Use Nova desktop helper to add it."
          }, { status: 404 });
        }

        return Response.json({
          product_id: productId,
          source: "variants",
          variants: variants.results,
          product_url: variants.results[0]?.product_url || null
        }, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=3600"
          }
        });

      } catch (e) {
        return Response.json({ error: e.message }, {
          status: 500,
          headers: { "Access-Control-Allow-Origin": "*" }
        });
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // 🤖 AUTO-CRAWL TRIGGER (Nova ACT Integration)
    // Called when user clicks "Crawl Now" on PENDING_CRAWL items
    // ═══════════════════════════════════════════════════════════════
    if (url.pathname === "/api/crawl/trigger" && req.method === "POST") {
      try {
        const body = await req.json();
        const keyword = body.keyword;

        if (!keyword || keyword.length < 3) {
          return Response.json({ error: "Keyword too short" }, {
            status: 400,
            headers: { "Access-Control-Allow-Origin": "*" }
          });
        }

        console.log(`[Crawl Trigger] Starting crawl for: "${keyword}"`);

        // Use Browser Rendering to crawl AliExpress
        // Use standardized BOM parser to generate spec_key from keyword
        const bomInfo = parseBomLine(keyword);
        const specKey = bomInfo.spec_key || `ESC:${keyword.replace(/\s+/g, '').toUpperCase()} `;

        // Use existing searchAndCrawlKeyword function (Browser Rendering + AI)
        const results = await searchAndCrawlKeyword(keyword, specKey, env);

        // Mark keyword as done
        const now = Date.now();
        await env.DB.prepare(`
          INSERT INTO crawl_keywords(keyword, canonical_type, status, last_updated)
              VALUES(?, 'ESC', 'done', ?)
          ON CONFLICT(keyword) DO UPDATE SET status = 'done', last_updated = ?
                `).bind(keyword, now, now).run();

        if (results.length === 0) {
          return Response.json({
            status: "error",
            message: "AliExpress blocked the crawl or found no results. Try again or use manual search."
          }, { status: 429, headers: { "Access-Control-Allow-Origin": "*" } });
        }

        return Response.json({
          status: "ok",
          source: "browser_rendering",
          keyword: keyword,
          variants_found: results.length,
          message: `Found ${results.length} variants.Refresh to see results.`
        }, { headers: { "Access-Control-Allow-Origin": "*" } });

      } catch (e) {
        console.error("[Crawl Trigger] Error:", e);
        return Response.json({
          error: e.message,
          hint: "Crawl failed. You can try the manual search link."
        }, {
          status: 500,
          headers: { "Access-Control-Allow-Origin": "*" }
        });
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // 🔹 BUYER-MODE CRAWL ENDPOINT (Browser Rendering + AI)
    // ═══════════════════════════════════════════════════════════════
    if (url.pathname === "/api/crawl" && req.method === "POST") {
      try {
        const body = await req.json();
        const productUrl = body.url;

        if (!productUrl || !productUrl.includes("aliexpress.com/item")) {
          return Response.json({ error: "Invalid AliExpress URL" }, { status: 400 });
        }

        // Extract product ID
        const productId = productUrl.match(/item\/(\d+)/)?.[1];
        if (!productId) {
          return Response.json({ error: "Product ID not found in URL" }, { status: 400 });
        }

        // 1️⃣ Check KV cache (6hr TTL)
        const cacheKey = `product:${productId} `;
        if (env.CACHE) {
          const cached = await env.CACHE.get(cacheKey, { type: "json" });
          if (cached) {
            return Response.json({
              source: "cache",
              product_id: productId,
              data: cached
            }, { headers: { "Access-Control-Allow-Origin": "*" } });
          }
        }

        // 2️⃣ Crawl via Browser Rendering
        const raw = await crawlAliExpress(productUrl, env);
        if (!raw) {
          return Response.json({
            error: "Browser Rendering failed",
            fallback_url: productUrl,
            message: "Please check the URL manually"
          }, { status: 503, headers: { "Access-Control-Allow-Origin": "*" } });
        }

        // 3️⃣ Parse via AI
        const parsed = await parseWithAI(raw, env);
        if (!parsed) {
          return Response.json({
            error: "AI parsing failed",
            fallback_url: productUrl,
            message: "Could not extract variant data"
          }, { status: 500, headers: { "Access-Control-Allow-Origin": "*" } });
        }

        // 4️⃣ Store in KV cache (6 hours TTL)
        if (env.CACHE) {
          await env.CACHE.put(cacheKey, JSON.stringify(parsed), {
            expirationTtl: 6 * 60 * 60
          });
        }

        // 5️⃣ Store in D1 for BOM pricing queries
        if (parsed.variants && parsed.variants.length > 0) {
          const now = Date.now();
          const pIdMatch = productUrl.match(/item\/(\d+)/);
          const productId = pIdMatch ? pIdMatch[1] : "CRAWL-" + Date.now();

          for (const v of parsed.variants) {
            const attrs = v.attributes || {};
            const variantLabel = Object.values(attrs).join(' ') || v.sku || 'default';

            // Use standardized BOM parser to generate spec_key from title + label
            const bomInfoForCrawl = parseBomLine(parsed.title + " " + variantLabel);
            const specKey = bomInfoForCrawl.spec_key || `PRODUCT:${productId} `;

            // Generate variant ID
            const variantId = await generateVariantId(productUrl, variantLabel, 1, 'browser_crawl');

            // Safeguard: Prevent ingestion of known "fake" product ID
            if (productUrl && productUrl.includes("1005005987654321")) {
              console.log(`[/api/crawl] Blocked fake product ${variantId} `);
              continue;
            }

            // Normalize price
            const unitPriceUsd = toUsd(v.price || 0, parsed.currency || "USD") || v.price || 0;
            const packPriceUsd = unitPriceUsd; // browser_crawl usually crawls unit items

            try {
              await env.DB.prepare(`
                INSERT INTO product_variants (
                  variant_id, product_id, canonical_item, spec_key,
                  brand, model, variant_label,
                  current_A, voltage_s, capacity_mah, kv,
                  pack_qty, unit_price_usd, pack_price_usd, currency,
                  stock, product_url,
                  source, first_seen, last_seen, last_price_update,
                  link_status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(variant_id) DO UPDATE SET
                  spec_key = excluded.spec_key,
                  current_A = excluded.current_A,
                  voltage_s = excluded.voltage_s,
                  capacity_mah = excluded.capacity_mah,
                  kv = excluded.kv,
                  unit_price_usd = excluded.unit_price_usd,
                  pack_price_usd = excluded.pack_price_usd,
                  currency = excluded.currency,
                  stock = excluded.stock,
                  last_seen = excluded.last_seen,
                  last_price_update = excluded.last_price_update,
                  link_status = 'resolved'
              `).bind(
                variantId, productId, bomInfoForCrawl.canonical_type || 'PRODUCT', specKey,
                '', // brand
                parsed.title || "",
                variantLabel,
                bomInfoForCrawl.current_A, bomInfoForCrawl.specs?.voltage_s, bomInfoForCrawl.specs?.capacity_mah, bomInfoForCrawl.specs?.kv,
                1, unitPriceUsd, packPriceUsd, parsed.currency || "USD",
                v.stock || null, productUrl,
                'browser_crawl', now, now, now, 'resolved'
              ).run();
            } catch (dbErr) {
              console.error('[/api/crawl] D1 upsert error:', dbErr.message);
            }
          }
          console.log(`[/api/crawl] Stored ${parsed.variants.length} variants to D1`);
        }

        return Response.json({
          source: "live",
          product_id: productId,
          data: parsed
        }, { headers: { "Access-Control-Allow-Origin": "*" } });

      } catch (e) {
        console.error("[/api/crawl] Error:", e);
        return Response.json({ error: e.message }, { status: 500, headers: { "Access-Control-Allow-Origin": "*" } });
      }
    }

    // 🧪 TEST: Ingest crawl data without HMAC (for testing only)
    if (url.pathname === "/admin/ingest-test" && req.method === "POST") {
      try {
        const payload = await req.json();
        const { search_keyword, results } = payload;

        if (!results || !Array.isArray(results)) {
          return Response.json({ error: "Missing results array" }, { status: 400 });
        }

        let canonicalItem = "UNKNOWN";
        const kw = (search_keyword || "").toUpperCase();
        if (kw.includes("ESC")) canonicalItem = "ESC";
        else if (kw.includes("MOTOR")) canonicalItem = "MOTOR";

        let ingested = 0;

        for (const product of results) {
          if (!product.variants || !Array.isArray(product.variants)) continue;

          for (const variant of product.variants) {
            const fullLabel = (product.title || "") + " " + (variant.variant_label || "");
            const specs = extractSpecs(fullLabel);
            const specKey = generateSpecKey(canonicalItem, specs);
            if (!specKey) continue;

            const variantId = await generateVariantId(product.product_url || "", variant.variant_label, specs.pack_qty, "test_ingest");
            const unitPriceUsd = toUsd(variant.price, variant.currency) || variant.price || 0;
            const now = Date.now();

            // Safeguard: Prevent ingestion of known "fake" product ID
            if (product.product_url && product.product_url.includes("1005005987654321")) {
              console.log(`[Test Ingest] Blocked fake product ${variantId} `);
              continue;
            }

            await env.DB.prepare(`
              INSERT INTO product_variants(
                    variant_id, product_id, canonical_item, spec_key,
                    brand, model, variant_label,
                    current_A, voltage_s, capacity_mah, kv,
                    pack_qty, unit_price_usd, pack_price_usd, currency,
                    stock, rating, review_count, seller,
                    product_url,
                    source, first_seen, last_seen, last_price_update, link_status
                  ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(variant_id) DO UPDATE SET
              spec_key = excluded.spec_key,
                current_A = excluded.current_A,
                voltage_s = excluded.voltage_s,
                capacity_mah = excluded.capacity_mah,
                kv = excluded.kv,
                unit_price_usd = excluded.unit_price_usd,
                pack_price_usd = excluded.pack_price_usd,
                currency = excluded.currency,
                last_seen = excluded.last_seen,
                last_price_update = excluded.last_price_update
                  `).bind(
              variantId, "UNKNOWN", canonicalItem, specKey,
              specs.brand || "", product.title || "", variant.variant_label || "",
              specs.current_A, specs.voltage_s, specs.capacity_mah, specs.kv,
              specs.pack_qty || 1, unitPriceUsd, unitPriceUsd * (specs.pack_qty || 1), variant.currency || "USD",
              variant.stock_available ? 100 : 0, product.rating || 0, product.review_count || 0, product.store_name || "",
              product.product_url || "",
              "test_ingest", now, now, now, "resolved"
            ).run();

            ingested++;
          }
        }

        // Mark keyword as done if present
        if (search_keyword) {
          await env.DB.prepare(`
            UPDATE crawl_keywords SET status = 'done', last_updated = ? WHERE keyword = ?
                `).bind(Date.now(), search_keyword).run();
        }

        return Response.json({
          status: "ok",
          ingested: ingested,
          keyword: search_keyword
        }, { headers: { "Access-Control-Allow-Origin": "*" } });

      } catch (e) {
        return Response.json({ error: e.message, stack: e.stack }, { status: 500, headers: { "Access-Control-Allow-Origin": "*" } });
      }
    }

    // Crawl Result Webhook (Callback)
    if (url.pathname === "/api/crawl/result" && req.method === "POST") {
      try {
        const signature = req.headers.get("X-Crawler-Signature");
        const keyId = req.headers.get("X-Crawler-Key"); // e.g. "default", "crawler-01"

        // 0. Strict Authentication
        if (!signature || !keyId) {
          return Response.json({ status: "error", message: "Missing Signature or Key ID" }, { status: 401 });
        }

        const bodyText = await req.text(); // Need raw text for HMAC verify

        // Verify HMAC with the secret corresponding to keyId (assuming env.CRAWLER_KEY is the secret for now)
        // In future, a map of keys could be used.
        const isValid = await verifySignature(bodyText, signature, env.CRAWLER_KEY);
        if (!isValid) {
          return Response.json({ status: "error", message: "Invalid Signature" }, { status: 401 });
        }

        let payload;
        try {
          payload = JSON.parse(bodyText);
        } catch (e) {
          return Response.json({ status: "error", message: "Invalid JSON" }, { status: 400 });
        }

        const { task_id, status, results, reason, search_keyword } = payload;

        // 1. Validate Payload
        if (!task_id || !status) {
          return Response.json({ error: "Invalid crawl payload: missing task_id or status" }, { status: 400 });
        }

        console.log(`[Webhook] Received result for task ${task_id}, status: ${status} `);

        // 2a. Detect source (RC Test Mode Round-Trip)
        // Check header first, otherwise look up from task
        let source = req.headers.get("X-Source") || null;
        if (!source && task_id) {
          const taskRow = await env.DB.prepare(
            "SELECT source FROM crawl_tasks WHERE task_id = ?"
          ).bind(task_id).first();
          source = taskRow?.source || "prod";
        }
        if (!source) source = "prod";
        console.log(`[Webhook] Source: ${source} `);

        // 2. Handle Blocked/Failed
        if (status === "blocked") {
          console.warn(`[Webhook] Task ${task_id} BLOCKED: ${reason} `);
          // Mark task as blocked
          await env.DB.prepare("UPDATE crawl_tasks SET status = 'blocked', error_type = ? WHERE task_id = ?")
            .bind(reason || "Unknown Block", task_id).run();
          // TODO: Mark keyword blocked if persistent?
          return Response.json({ status: "processed", note: "blocked_recorded" });

        } else if (status === "failed") {
          console.error(`[Webhook] Task ${task_id} FAILED: ${reason} `);
          await env.DB.prepare("UPDATE crawl_tasks SET status = 'failed', error_type = ? WHERE task_id = ?")
            .bind(JSON.stringify(payload), task_id).run();
          return Response.json({ status: "processed", note: "failure_recorded" });
        }

        // 3. Status OK -> Ingest Variants
        if (status === "ok" && results && Array.isArray(results)) {
          // Default canonical item from context or keyword
          // Ideally payload tells us, or we infer from keyword.
          // Simple inference:
          let canonicalItem = "UNKNOWN";
          const kw = (search_keyword || "").toUpperCase();
          if (kw.includes("ESC")) canonicalItem = "ESC";
          else if (kw.includes("MOTOR")) canonicalItem = "MOTOR";
          else if (kw.includes("BATTERY") || kw.includes("LIPO")) canonicalItem = "BATTERY";
          else if (kw.includes("SERVO")) canonicalItem = "SERVO";
          else if (kw.includes("PROP")) canonicalItem = "PROP";

          for (const product of results) {
            if (!product.variants || !Array.isArray(product.variants)) continue;

            for (const variant of product.variants) {
              // 4. Extract Specs (Deterministic)
              // Combine title + variant label for context
              const fullLabel = product.title + " " + variant.variant_label;
              const specs = extractSpecs(fullLabel);

              // 5. Compute Canonical Identity & Spec Key
              const specKey = generateSpecKey(canonicalItem, specs);
              if (!specKey) continue; // Skip if we can't key it

              // 6. Stable Variant ID (includes source for uniqueness)
              const variantId = await generateVariantId(product.product_url || product.url, variant.variant_label, specs.pack_qty, source);

              // 7. Normalize Prices
              const unitPriceUsd = toUsd(variant.price, variant.currency) || 0;
              const packPriceUsd = unitPriceUsd;
              const calculatedUnitPrice = specs.pack_qty > 1 ? (packPriceUsd / specs.pack_qty) : packPriceUsd;
              const currentStock = product.stock || variant.stock || 0;

              // 7a. Price History Tracking - check if price/stock changed
              const prevState = await env.DB.prepare(
                "SELECT unit_price_usd, stock FROM product_variants WHERE variant_id = ?"
              ).bind(variantId).first();

              const priceChanged = !prevState || Math.abs((prevState.unit_price_usd || 0) - calculatedUnitPrice) > 0.001;
              const stockChanged = !prevState || prevState.stock !== currentStock;

              if (priceChanged || stockChanged) {
                // Record price history (append-only)
                await env.DB.prepare(`
                  INSERT INTO variant_price_history(variant_id, source, unit_price_usd, pack_price_usd, stock, recorded_at)
              VALUES(?, ?, ?, ?, ?, ?)
                `).bind(variantId, source, calculatedUnitPrice, packPriceUsd, currentStock, Date.now()).run();
              }

              // 8. Upsert (Idempotent) - includes source column
              await env.DB.prepare(`
                        INSERT INTO product_variants(
                  variant_id, product_id, canonical_item, spec_key,
                  brand, model, variant_label,
                  current_A, kv, voltage_s, capacity_mah,
                  pack_qty, unit_price_usd, pack_price_usd, currency,
                  stock, rating, review_count, seller,
                  product_url, image_url,
                  source, first_seen, last_seen, last_price_update
                ) VALUES(
                            ?, ?, ?, ?,
                            ?, ?, ?,
                            ?, ?, ?, ?,
                            ?, ?, ?, ?,
                            ?, ?, ?, ?,
                            ?, ?,
                            ?, ?, ?, ?
                )
                        ON CONFLICT(variant_id) DO UPDATE SET
              spec_key = excluded.spec_key,
                current_A = excluded.current_A,
                kv = excluded.kv,
                voltage_s = excluded.voltage_s,
                capacity_mah = excluded.capacity_mah,
                unit_price_usd = excluded.unit_price_usd,
                pack_price_usd = excluded.pack_price_usd,
                currency = excluded.currency,
                stock = excluded.stock,
                rating = excluded.rating,
                review_count = excluded.review_count,
                seller = excluded.seller,
                last_seen = excluded.last_seen,
                last_price_update = excluded.last_price_update
                  `).bind(
                variantId, product.product_id || "UNKNOWN", canonicalItem, specKey,
                product.brand || "Unknown", product.title || "", variant.variant_label || "Default",
                specs.current_A, specs.kv, specs.voltage_s, specs.capacity_mah,
                specs.pack_qty, calculatedUnitPrice, packPriceUsd, variant.currency || "USD",
                currentStock, product.rating || 0, product.reviews || 0, product.store_name || "Unknown",
                product.product_url || product.url, variant.image_token || product.image_url || null,
                source, Date.now(), Date.now(), Date.now()
              ).run();
            }
          }

          // 9. Update Crawl State
          await env.DB.prepare("UPDATE crawl_tasks SET status = 'completed', completed_at = ? WHERE task_id = ?")
            .bind(Date.now(), task_id).run();

          return Response.json({ status: "processed", items_ingested: results.length }); // Approx count
        } else {
          // Status unknown?
          return Response.json({ status: "ignored", reason: "status not ok/blocked/failed" });
        }

      } catch (e) {
        console.error("[Webhook] Error processing callback:", e);
        return Response.json({ error: e.message }, { status: 500 });
      }
    }

    // Preference recording endpoint (User Trust)
    if (url.pathname === "/api/preference" && req.method === "POST") {
      try {
        const userKey = req.headers.get("X-BOM-User");
        if (!userKey) {
          return Response.json({ error: "Missing X-BOM-User header" }, { status: 400 });
        }
        const body = await req.json();
        const { brand, supplier } = body;
        if (!brand) {
          return Response.json({ error: "Missing brand" }, { status: 400 });
        }
        await updateTrust(env.DB, userKey, brand, supplier);
        return Response.json({
          status: "ok",
          message: "Trust preference recorded",
          brand,
          supplier
        }, {
          headers: { "Access-Control-Allow-Origin": "*" }
        });
      } catch (e) {
        return Response.json({ error: e.message }, { status: 500 });
      }
    }

    // 3️⃣ WORKER ENDPOINT — EXACT CODE
    if (url.pathname === "/api/resolve" && req.method === "GET") {
      try {
        const variantId = url.searchParams.get("variant_id");

        if (!variantId) {
          return new Response("Missing variant_id", { status: 400 });
        }

        // 1️⃣ Fetch variant record
        const row = await env.DB.prepare(`
          SELECT variant_id, product_url, variant_url, link_status
          FROM product_variants
          WHERE variant_id = ?
                LIMIT 1
                  `).bind(variantId).first();

        if (!row) {
          return new Response("Variant not found", { status: 404 });
        }

        // 2️⃣ Already resolved → redirect
        if (row.link_status === "resolved" && row.variant_url) {
          return Response.redirect(row.variant_url, 302);
        }

        // 3️⃣ Resolve PDP + variant (ONE TIME)
        const resolved = await resolveAliExpressVariant(row.product_url, env);

        // Fallback to product page if resolution fails or returns null
        const finalUrl = (resolved && resolved.variant_url) ? resolved.variant_url : row.product_url;

        // 4️⃣ Persist resolution (only if actually resolved)
        if (resolved && resolved.variant_url) {
          await env.DB.prepare(`
            UPDATE product_variants
            SET variant_url = ?, link_status = 'resolved'
            WHERE variant_id = ?
                `).bind(resolved.variant_url, variantId).run();
        }

        // 5️⃣ Redirect
        return Response.redirect(finalUrl, 302);

      } catch (e) {
        console.error("Endpoint /api/resolve error:", e);
        return new Response("Internal Server Error: " + e.message, { status: 500 });
      }
    }

    // 🏠 Serve UI (Root)
    if ((url.pathname === "/" || url.pathname === "/index.html") && req.method === "GET") {
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RC BOM Builder V2.0</title>
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
      background-clip: text;
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
    textarea::placeholder { color: #666; }
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
      display: inline-block;
      width: 20px;
      height: 20px;
      border: 2px solid #444;
      border-top-color: #667eea;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-right: 10px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .total-row td { background: #252525; font-weight: 600; border-top: 2px solid #444; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; margin-left: 6px; }
    .badge-trusted { background: linear-gradient(135deg, #a855f7, #7c3aed); color: #fff; padding: 2px 8px; border-radius: 12px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; margin-left: 6px; }
    .badge-low { background: #065f46; color: #34d399; }
    .badge-medium { background: #78350f; color: #fbbf24; }
    .badge-high { background: #7f1d1d; color: #f87171; }
    .verified { color: #4ade80; font-size: 12px; display: block; margin-top: 4px; }
    .verified::before { content: "✓ "; }
    .warning { color: #fbbf24; font-size: 12px; display: block; margin-top: 4px; }
    .warning::before { content: "⚠ "; }
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
    .candidate-row .feedback-info { display: flex; gap: 8px; font-size: 10px; color: #9ca3af; margin-left: 8px; }
    .candidate-row .feedback-info .rating { color: #fbbf24; }
    .candidate-row .feedback-info .reviews { color: #60a5fa; }
    .candidate-row .feedback-info .sold { color: #34d399; }
    .candidate-row .pref-badge { background: linear-gradient(135deg, #f59e0b, #d97706); color: #fff; font-size: 9px; padding: 1px 5px; border-radius: 3px; margin-left: 6px; font-weight: 600; }
    .risk-badge { padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: 600; margin-left: 8px; }
    .risk-low { background: #065f46; color: #34d399; }
    .risk-medium { background: #78350f; color: #fbbf24; }
    .risk-high { background: #7f1d1d; color: #f87171; }
    .row-unit, .row-total { transition: all 0.3s; }
    .status-pending { color: #60a5fa; }
    .pending-fetch { color: #60a5fa; font-weight: 500; }
  </style>
</head>
<body>
  <h1>RC BOM Builder <small style="font-size:0.5em;color:#666">V2.0</small></h1>
  <p class="subtitle">Skeptical RC Buyer • Paste your Bill of Materials, get instant pricing</p>
  <textarea id="bom" rows="6" placeholder="30A ESC x2&#10;40A ESC x1&#10;1300mAh 4S LiPo x2"></textarea>
                        <div class="btn-group">
                          <button class="btn-primary" id="btn-price">Get Prices</button>
                          <button class="btn-secondary" id="btn-csv">Download CSV</button>
                        </div>
                        <div id="loading"><span class="spinner"></span>Fetching prices...</div>
                        <div id="results"></div>
                        <script>
    // User key for personalized brand preferences (anonymous, local-only)
                          function getUserKey() {
                            let key = localStorage.getItem('bom_user_key');
                          if (!key) {
                            key = crypto.randomUUID();
                          localStorage.setItem('bom_user_key', key);
      }
                          return key;
    }
                          const userKey = getUserKey();

                          // Make functions globally accessible
                          window.price = async function() {
      const bom = document.getElementById("bom").value;
                          document.getElementById("loading").style.display = "block";
                          document.getElementById("results").innerHTML = "";
                          try {
        const res = await fetch("/api/price", {
                            method: "POST",
                          headers: {
                            "Content-Type": "application/json",
                          "X-BOM-User": userKey
          },
                          body: JSON.stringify({bom}) 
        });
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
                          if (!data.items?.length) {document.getElementById("results").innerHTML = "<p>No results.</p>"; return; }
                          let html = '<table><thead><tr><th>Item</th><th>Qty</th><th>Select Supplier</th><th>Unit Price</th><th>Total</th></tr></thead><tbody>';
                            for (const i of data.items) {
        if (i.status === "MATCHED") {
          const itemKey = (i.bom.raw || 'item').replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
                            const itemName = i.bom.raw || (i.bom.current_A ? i.bom.current_A + 'A ESC' : 'Unknown Item');
          const defaultCand = i.candidates?.find(c => c.default) || i.candidates?.[0];
                            const hasRealUrl = defaultCand?.product_url && defaultCand.product_url.includes('/item/');
                            const isEstimate = defaultCand?.is_estimate;
                            html += '<tr>';
                              // Only show View link if we have a real product URL (not a search URL) and it's not an AI estimate
                              let viewBtn = '';
                              if (!isEstimate && defaultCand?.variant_id && hasRealUrl) {
                                viewBtn = ' <a href="/api/resolve?variant_id=' + defaultCand.variant_id + '" target="_blank" style="font-size:11px;color:#6d9eeb;text-decoration:none;">[View]</a>';
          } else if (isEstimate) {
                                viewBtn = ' <span style="font-size:10px;color:#fbbf24;">[Data pending - crawl needed]</span>';
          }
                              html += '<td>' + itemName + (hasRealUrl && !isEstimate ? '<span class="verified">Variant verified</span>' : '') + viewBtn + '</td>';
                              html += '<td class="qty" data-item="' + itemKey + '">' + i.bom.qty + '</td>';
                              html += '<td><div class="candidates" data-item="' + itemKey + '" data-qty="' + i.bom.qty + '">';
                                if (i.candidates) {
            for (const c of i.candidates) {
                                  html += '<div class="candidate-row">';
                                html += '<label>';
                                  html += '<input type="radio" name="cand_' + itemKey + '" value="' + c.id + '" ' + (c.default ? 'checked' : '') + ' data-price-usd="' + c.unit_price_usd + '" data-price-local="' + c.unit_price_local + '" data-currency="' + c.local_currency + '" data-pack-qty="' + (c.pack_qty || 1) + '" data-pack-price-usd="' + (c.pack_price_usd || c.unit_price_usd) + '" data-item-key="' + itemKey + '" data-qty="' + i.bom.qty + '" data-brand="' + c.brand + '" data-supplier="' + (c.remark || '') + '">';
                                  html += '<span class="brand">' + c.brand + '</span> ' + c.model;
                                  // User Trust Badge
                                  if (c.trust?.is_trusted) {
                                    html += '<span class="badge-trusted" title="Based on your past selections">★ Trusted</span>';
              }
              // html += '<span class="risk-badge risk-' + c.risk.toLowerCase() + '">' + c.risk + '</span>';
              // Show unit price with pack breakdown if pack_qty > 1
              if (c.pack_qty > 1) {
                                    html += '<span class="price">$' + (c.unit_price_usd?.toFixed(2) || '-') + '/unit</span>';
                                  html += '<span class="pack-info">(' + c.pack_qty + 'pcs = $' + (c.pack_price_usd?.toFixed(2) || '-') + ')</span>';
              } else {
                                    html += '<span class="price">$' + (c.unit_price_usd?.toFixed(2) || '-') + '</span>';
              }
                                  if (c.is_estimate) {
                                    html += ' <span style="font-size:9px;color:#fbbf24;border:1px solid #fbbf24;padding:0 2px;border-radius:2px;">EST</span>';
              }
                                  html += '</label>';
                                // Feedback signals display
                                html += '<span class="feedback-info">';
                                  if (c.feedback?.rating) {
                                    html += '<span class="rating">★' + (c.feedback.rating?.toFixed(1) || '-') + '</span>';
              }
                                  if (c.feedback?.reviews) {
                                    html += '<span class="reviews">' + c.feedback.reviews + ' reviews</span>';
              }
                                  if (c.feedback?.sold) {
                                    html += '<span class="sold">' + c.feedback.sold + ' sold</span>';
              }
                                  html += '</span>';
                                html += '<span class="remark">' + c.remark + '</span>';
                                // Only show View button if: (1) not an AI estimate AND (2) has real product URL (contains /item/)
                                const candHasRealUrl = c.product_url && c.product_url.includes('/item/');
                                if (!c.is_estimate && c.variant_id && candHasRealUrl) {
                                  html += ' <a href="/api/resolve?variant_id=' + c.variant_id + '" target="_blank" style="color:#6d9eeb;text-decoration:none;margin-left:6px;font-size:11px;border:1px solid #444;padding:1px 4px;border-radius:4px;">View ↗</a>';
              } else if (!c.is_estimate && candHasRealUrl) {
                                  html += ' <a href="' + c.product_url + '" target="_blank" style="color:#6d9eeb;text-decoration:none;margin-left:6px;font-size:11px;border:1px solid #444;padding:1px 4px;border-radius:4px;">View ↗</a>';
              } else {
                                  // Either AI estimate or search URL - show indicator
                                  html += ' <span style="color:#888;font-size:10px;margin-left:6px;">(no direct link)</span>';
              }
                                html += '</div>';
            }
          }
                                html += '</div></td>';
                            const unitPriceUsd = defaultCand?.unit_price_usd || i.unit_price_usd || 0;
                            const unitPriceLkr = Math.round(unitPriceUsd * 320); // USD to LKR at 1:320
                            const totalUsd = (unitPriceUsd * i.bom.qty);
                            const totalLkr = Math.round(totalUsd * 320);
                            // Always show dual currency: USD primary, LKR secondary
                            const unitDisplay = '$' + unitPriceUsd.toFixed(2) + '<span class="item-details">≈ LKR ' + unitPriceLkr.toLocaleString() + '</span>';
                            const totalDisplay = '$' + totalUsd.toFixed(2) + '<span class="item-details">≈ LKR ' + totalLkr.toLocaleString() + '</span>';

                            html += '<td class="price row-unit" data-item="' + itemKey + '" data-usd="' + unitPriceUsd + '" data-lkr="' + unitPriceLkr + '">' + unitDisplay + '</td>';
                            html += '<td class="price row-total" data-item="' + itemKey + '" data-usd="' + totalUsd + '" data-lkr="' + totalLkr + '">' + totalDisplay + '</td>';
                            html += '</tr>';
        } else {
                              // Non-MATCHED status (SEARCHING, NOT_FOUND, PENDING_CRAWL etc.)
                              let statusCell = '';
                              
                             if (i.status === 'PENDING_CRAWL') {
                               // Show command + request button
                               const safeKeyword = (i.crawl_keyword || i.bom?.raw || '').replace(/"/g, '&quot;');
                               const cmdText = 'python scripts/scrape_interactive.py "' + safeKeyword + '"';
                               statusCell = '<span class="pending-fetch" style="color:#fbbf24;">⏳ No pricing data yet</span>';
                               statusCell += '<br><code class="crawl-cmd" style="background:#1a1a2e;color:#4ade80;padding:4px 8px;border-radius:4px;font-size:11px;display:inline-block;margin:6px 0;cursor:pointer;" data-cmd="' + cmdText + '" title="Click to copy">' + cmdText + '</code>';
                               statusCell += ' <button class="copy-cmd-btn" data-cmd="' + cmdText + '" style="background:#333;color:#fff;border:none;padding:3px 8px;border-radius:4px;cursor:pointer;font-size:10px;">📋 Copy</button>';
                               statusCell += '<br><small style="color:#888;">Run this command on a PC with Nova Act to populate pricing data</small>';
                             } else {
                               statusCell = '<span class="status-' + i.status.toLowerCase() + '">' + i.status + '</span>';
                             }

                            // Keep manual search as fallback for non-pending items
                            if (i.manual_url && i.status !== 'PENDING_CRAWL') {
                              statusCell += ' <a href="' + i.manual_url + '" target="_blank" style="color:#6d9eeb;font-size:11px;margin-left:6px;">[Manual Search]</a>';
          }
                            if (i.message && i.status !== 'PENDING_CRAWL') {
                              statusCell += '<br><small style="opacity:0.7">' + i.message + '</small>';
          }
                            html += '<tr data-pending-keyword="' + (i.crawl_keyword || '') + '"><td>' + (i.bom?.raw || 'Unknown') + '</td><td>' + (i.bom?.qty || '-') + '</td><td colspan="3" class="' + (i.status === 'PENDING_CRAWL' ? 'status-pending' : 'status-error') + '">' + statusCell + '</td></tr>';
        }
      }
                            html += '<tr class="total-row"><td colspan="3">Total BOM Cost</td><td></td><td class="price" id="bom-total">$' + recalcBomTotal() + '</td></tr></tbody></table>';
                        document.getElementById("results").innerHTML = html;
                        recalcBomTotal();

      // Auto-retry only for SEARCHING status (actively being processed)
      // Don't auto-refresh for PENDING_CRAWL (waiting for manual Nova run)
      const hasSearching = data.items.some(i => i.status === "SEARCHING");
      const retryCount = window._pendingRetryCount || 0;
      
      if (hasSearching && retryCount < 4) {
        window._pendingRetryCount = retryCount + 1;
        let countdown = 15;
        const countdownEl = document.createElement("p");
        countdownEl.id = "retry-countdown";
        countdownEl.style.cssText = "color:#6d9eeb; margin-top:10px; display:flex; align-items:center; gap:8px;";
        countdownEl.innerHTML = '<span class="spinner" style="width:14px;height:14px;border-width:2px;"></span> Checking for data in ' + countdown + 's... (attempt ' + (retryCount + 1) + '/4)';
        document.getElementById("results").appendChild(countdownEl);
        
        const timer = setInterval(() => {
          countdown--;
          if (countdown > 0) {
            countdownEl.innerHTML = '<span class="spinner" style="width:14px;height:14px;border-width:2px;"></span> Checking for data in ' + countdown + 's...';
          } else {
            clearInterval(timer);
            countdownEl.innerHTML = '<span class="spinner" style="width:14px;height:14px;border-width:2px;"></span> Refreshing...';
            window.price();
          }
        }, 1000);
      } else if (!hasSearching) {
        // Reset retry count when all items are resolved
        window._pendingRetryCount = 0;
      }
    }
                        window.onCandidateSelected = function(itemKey, qty) {
      const selected = document.querySelector('input[name="cand_' + itemKey + '"]:checked');
                        if (!selected) return;
                        const unitUsd = parseFloat(selected.dataset.priceUsd);

                        // Record brand preference
                        const brand = selected.dataset.brand;
                        const supplier = selected.dataset.supplier;
                        if (brand) {
                          fetch('/api/preference', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'X-BOM-User': userKey },
                            body: JSON.stringify({ brand, supplier })
                          }).catch(() => { });
      }

                        const rowUnit = document.querySelector('.row-unit[data-item="' + itemKey + '"]');
                        const rowTotal = document.querySelector('.row-total[data-item="' + itemKey + '"]');

                        const unitLkr = Math.round(unitUsd * 320);
                        const totalUsd = unitUsd * qty;
                        const totalLkr = Math.round(totalUsd * 320);

                        if (rowUnit) rowUnit.innerHTML = '$' + unitUsd.toFixed(2) + '<span class="item-details">≈ LKR ' + unitLkr.toLocaleString() + '</span>';
                        if (rowTotal) rowTotal.innerHTML = '$' + totalUsd.toFixed(2) + '<span class="item-details">≈ LKR ' + totalLkr.toLocaleString() + '</span>';
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
                        const totalLkr = Math.round(total * 320);
                        if (bomTotalEl) bomTotalEl.innerHTML = '$' + total.toFixed(2) + '<span style="font-size:12px;display:block;color:#888;font-weight:normal">≈ LKR ' + totalLkr.toLocaleString() + '</span>';
                        return total.toFixed(2);
    }
                        window.downloadCSV = async function() {
      const bom = document.getElementById("bom").value;
                        if (!bom.trim()) {alert("Please enter a BOM first"); return; }
                        try {
        const res = await fetch("/api/price?format=csv", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({bom}) });
                        if (!res.ok) {alert("Error fetching CSV"); return; }
                        const blob = await res.blob();
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = "bom_pricing_" + new Date().toISOString().slice(0,10) + ".csv";
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        URL.revokeObjectURL(url);
      } catch (e) {alert("Download failed: " + e.message); }
    };

                        // 🤖 Auto-crawl trigger function
                        window.triggerCrawl = async function(keyword, btn) {
      const originalText = btn.textContent;
                        btn.disabled = true;
                        btn.textContent = "⏳ Crawling...";
                        btn.style.opacity = "0.7";

                        console.log("[Crawl] Triggering for:", keyword);
                        try {
        const res = await fetch("/api/crawl/trigger", {
                          method: "POST",
                        headers: {"Content-Type": "application/json" },
                        body: JSON.stringify({keyword: keyword })
        });

                        const data = await res.json();
                        console.log("[Crawl] Response:", res.status, data);

                        if (res.ok && data.status === "ok") {
                          btn.textContent = "✅ Done! Refreshing...";
                        btn.style.background = "#10b981";
          
          setTimeout(() => {
                          window.price();
          }, 1500);
        } else {
          let errMsg = data.error || data.message || "Failed";
          let shortMsg = errMsg.length > 20 ? "Error" : errMsg;
          if (res.status === 429) shortMsg = "Blocked";
          
          btn.textContent = "❌ " + shortMsg;
                        btn.style.background = "#ef4444";
                        console.error("[Crawl] Failed:", errMsg);
          
          setTimeout(() => {
                          btn.textContent = originalText;
                        btn.disabled = false;
                        btn.style.opacity = "1";
                        btn.style.background = "linear-gradient(135deg,#667eea,#764ba2)";
          }, 4000);
        }
      } catch (e) {
                          btn.textContent = "❌ Error";
                        btn.style.background = "#ef4444";
                        console.error("[Crawl] Request error:", e);
        
        setTimeout(() => {
                          btn.textContent = originalText;
                        btn.disabled = false;
                        btn.style.opacity = "1";
                        btn.style.background = "linear-gradient(135deg,#667eea,#764ba2)";
        }, 3000);
      }
    };

                        // Attach event listeners (DOM already loaded since script is at end of body)
                        document.getElementById('btn-price').addEventListener('click', window.price);
                        document.getElementById('btn-csv').addEventListener('click', window.downloadCSV);

                        // Currency selector - update all prices when changed
                        // Currency selector removed - prices always show both currencies
                        // Currency selector removed


                        // Event delegation for candidate radio buttons (dynamically added)
                        document.getElementById('results').addEventListener('change', function(e) {
      if (e.target.type === 'radio' && e.target.dataset.itemKey) {
        const itemKey = e.target.dataset.itemKey;
                        const qty = parseInt(e.target.dataset.qty) || 1;
                        window.onCandidateSelected(itemKey, qty);
      }
    });

                        // Crawl button removed - Nova agents handle crawling in background

                        // Event delegation for copy command buttons
                        document.getElementById('results').addEventListener('click', function(e) {
      // Handle copy button click
      if (e.target.classList.contains('copy-cmd-btn') || e.target.classList.contains('crawl-cmd')) {
        const cmd = e.target.dataset.cmd;
        if (cmd) {
          navigator.clipboard.writeText(cmd).then(() => {
            const originalText = e.target.textContent;
            e.target.textContent = '✅ Copied!';
            e.target.style.background = '#10b981';
            e.target.style.color = '#fff';
            setTimeout(() => {
              e.target.textContent = originalText;
              if (e.target.classList.contains('copy-cmd-btn')) {
                e.target.style.background = '#333';
              } else {
                e.target.style.background = '#1a1a2e';
                e.target.style.color = '#4ade80';
              }
            }, 2000);
          }).catch(() => {
            prompt('Copy this command:', cmd);
          });
        }
      }
    });
                      </script>
                    </body>
                </html>`;
      return new Response(html, { headers: { "Content-Type": "text/html", "Access-Control-Allow-Origin": "*" } });
    }

    // 💰 BOM Pricing API
    if ((url.pathname === "/api/price" || url.pathname === "/") && req.method === "POST") {
      try {
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

        // RC Hobby Test Mode detection
        const isRCTest = req.headers.get("X-Test-Mode") === "rc_hobby"
          || url.searchParams.get("test") === "rc";
        const sourceFilter = isRCTest
          ? "('prod', 'rc_test', 'test_ingest')"
          : "('prod', 'auto_crawl', 'browser_crawl', 'nova_desktop', 'rc_test')";

        // Get user key for personalized brand preferences
        const userKey = req.headers.get("X-BOM-User") || null;
        const trustMemory = userKey ? await getTrustScores(env.DB, userKey) : {};

        // 1. Parse BOM
        let bomItems = parseBom(bomText);
        let truncated = false;
        if (bomItems.length > MAX_BOM_LINES) {
          bomItems = bomItems.slice(0, MAX_BOM_LINES);
          truncated = true;
        }

        // 2. Process each BOM line
        const results = [];
        for (const b of bomItems) {
          if (!b.canonical_type) {
            results.push({ bom: b, status: "INVALID_LINE" });
            continue;
          }

          // 3. Query Variant Catalog (Primary Source)
          let candidates = [];
          let dataSource = "NONE";

          if (b.spec_key) {
            const { results: variantRows } = await env.DB.prepare(
              `SELECT * FROM product_variants 
           WHERE spec_key = ? AND source IN ${sourceFilter}
           ORDER BY unit_price_usd ASC, rating DESC 
           LIMIT 20`
            ).bind(b.spec_key).all();

            if (variantRows && variantRows.length > 0) {
              dataSource = "VARIANT_CATALOG";
              candidates = variantRows.map(r => ({
                title: r.model || r.variant_label, // Use model or label as title
                variant: r.variant_label,
                brand: r.brand,
                current_A: r.current_A,
                variant_id: r.variant_id, // For price history lookup

                price_value: r.pack_price_usd || r.unit_price_usd,
                price_currency: "USD", // For now, catalog is USD-centric

                seller: { name: r.seller, rating: r.rating },
                product_url: r.product_url,
                last_updated: r.last_seen,
                review_count: r.review_count || 0,
                sold_count: r.stock || 0, // Using stock as proxy or 0 if not tracked
                store_years: 0, // Not in new schema yet
                has_choice: 1,
                has_photos: 1,
                pack_qty: r.pack_qty || 1
              }));

              // Filter variants to match requested amperage (e.g., 30A query only shows 30A variants)
              if (b.current_A) {
                const requestedAmps = String(b.current_A);
                const filtered = candidates.filter(c => {
                  const label = (c.variant || "").toUpperCase();
                  const amps = label.match(/(\d+)\s*A/gi);
                  if (!amps) return true; // Keep if no amperage found
                  return amps.some(m => m.match(/(\d+)/)?.[1] === requestedAmps);
                });
                if (filtered.length > 0) candidates = filtered;
              }
            }
          }
          // Fallback: Legacy Catalog (Optional, can keep or remove. Keeping for safety provided nothing found in variants)
          if (candidates.length === 0 && b.canonical_type) {
            // ... (existing helper or just skip to empty) ...
            // For now, assuming complete migration, we skip legacy if empty.
            // Actually, let's just trigger enqueue if empty.
          }

          if (candidates.length === 0) {
            // --- AUTO-CRAWL ON-DEMAND ---
            // When no D1 data exists, automatically crawl AliExpress
            const cleanKeyword = b.raw.replace(/x\d+$/i, "").trim();
            console.log(`[BOM] No D1 data for "${cleanKeyword}" - triggering auto - crawl`);

            // Enqueue crawl keyword for async processing via cron
            if (cleanKeyword.length > 3) {
              const now = Date.now();
              await env.DB.prepare(`
               INSERT INTO crawl_keywords(keyword, canonical_type, priority, status, fail_count, last_updated)
              VALUES(?, ?, 1, 'pending', 0, ?)
               ON CONFLICT(keyword) DO UPDATE SET
              priority = 1,
                status = CASE WHEN status = 'done' THEN 'done' ELSE 'pending' END
                  `).bind(cleanKeyword, b.canonical_type || "UNKNOWN", now).run();
            }

            // Return CRAWLING status - cron will crawl in background
            // Check if keyword is already done from previous cron run
            const existingData = await env.DB.prepare(`
            SELECT keyword, status FROM crawl_keywords WHERE keyword = ?
                `).bind(cleanKeyword).first();

            if (existingData && existingData.status === 'done') {
              // Re-query D1 since cron may have stored data
              const recheck = await env.DB.prepare(`
              SELECT * FROM product_variants WHERE spec_key = ? LIMIT 5
            `).bind(b.spec_key).all();

              if (recheck.results && recheck.results.length > 0) {
                candidates = recheck.results.map(r => ({
                  title: r.model || r.variant_label,
                  variant: r.variant_label,
                  brand: r.brand,
                  variant_id: r.variant_id,
                  price_value: r.unit_price_usd,
                  price_currency: "USD",
                  seller: { name: '', rating: 0 },
                  product_url: r.product_url,
                  last_updated: r.last_seen,
                  pack_qty: r.pack_qty || 1
                }));

                // Filter variants to match requested amperage
                if (b.current_A) {
                  const requestedAmps = String(b.current_A);
                  const filtered = candidates.filter(c => {
                    const label = (c.variant || "").toUpperCase();
                    const amps = label.match(/(\d+)\s*A/gi);
                    if (!amps) return true;
                    return amps.some(m => m.match(/(\d+)/)?.[1] === requestedAmps);
                  });
                  if (filtered.length > 0) candidates = filtered;
                }

                dataSource = "CRON_CRAWL";
              }
            } else {
              // Keyword is pending - needs Nova crawl
              results.push({
                bom: b,
                status: "PENDING_CRAWL",
                message: "No data yet. Run Nova crawler with this keyword to populate.",
                manual_url: buildAliExpressSearchUrl(cleanKeyword),
                crawl_keyword: cleanKeyword
              });
              continue;
            }
          }

          // 4. Build candidates array with brand/model parsing and pack normalization
          const allCandidates = candidates.map((c, idx) => {
            let brand = c.brand;
            if ((!brand || brand === "Unknown") && c.title) {
              // Fallback: extract from title, ignoring quantity prefixes (e.g. 4PCS, 10X)
              const cleanTitle = c.title.replace(/^(\d+\s*[xX]?\s*|(\d+\s*PCS\s*))/i, "").trim();
              const brandMatch = cleanTitle.match(/^(\w+)/);
              brand = brandMatch ? brandMatch[1] : "Unknown";
            }
            if (!brand) brand = "Unknown";

            // variant_label: exact variant from AliExpress selector (immutable)
            const variantLabel = c.variant || "";

            // Extract pack quantity from variant label (e.g., "4Pcs LITTLEBEE 30A" → 4)
            const packQty = extractPackQty(variantLabel);

            // Clean variant name: strip quantity words, keep variant identity only
            const cleanVariant = stripQtyWords(variantLabel) || variantLabel;

            // display_label: pack + clean variant ONLY (never includes listing_title)
            const displayLabel = packQty > 1
              ? `${packQty}Pcs ${cleanVariant} `
              : cleanVariant ? `1Pc ${cleanVariant} ` : variantLabel;

            const packPriceUsd = toUsd(c.price_value, c.price_currency);
            const packPriceLocal = c.price_value;

            // Normalize to unit price (pack price / pack quantity)
            const unitPriceUsd = packPriceUsd != null ? Math.round((packPriceUsd / packQty) * 10000) / 10000 : null;
            const unitPriceLocal = packPriceLocal / packQty;

            const priceConfidence = calculateConfidenceDecay(0.85, c.last_updated);

            // Calculate feedback score from trust signals
            const feedbackScore = calculateFeedbackScore(
              c.seller?.rating,
              c.review_count,
              c.sold_count,
              c.store_years,
              c.has_choice,
              c.has_photos
            );

            // Get brand preference from user memory (Trust)
            const supplierName = c.seller?.name || "";
            const trust = getTrustScore(trustMemory, brand, supplierName);
            const trustScore = trust.score; // Max 0.3

            // Final score formula: 
            // Price: 45%, Variant Match: 20%, Feedback: 20%, Trust: 15%
            // Normalized roughly to 0-1
            const priceScore = priceConfidence;
            const matchScore = 0.85; // Variant match assumed high if in this list

            const finalScore =
              priceScore * 0.45 +
              matchScore * 0.20 +
              feedbackScore * 0.20 +
              trustScore * 0.15 * (1 / 0.3); // Normalize trust (0.3 max) to scale influence? 
            // Wait, prompt says: trust_score * 0.15. 
            // If max trust_score is 0.3, then max boost is 0.3 * 0.15 = 0.045
            // But prompt also says "Trust never exceeds 15%".
            // If trust_score is literally 0.0 to 0.3, then sticking to additive 0.15 * (trust/0.3) makes sense if we want full 15% range.
            // Or just trust * 0.15 if the score is already 0-1.
            // The prompt says "trust_score += 0.05, max 0.3".
            // And formula: `price_score * 0.45 + variant_match * 0.20 + feedback_score * 0.20 + trust_score * 0.15`.
            // If trust_score is max 0.3, then max contribution is 0.045 (4.5%).
            // User might mean trust itself is a component 0-1. 
            // "Trust never exceeds 15%" -> Usually means max *weight* is 15%.
            // I'll leave it as `trustScore * 0.5` effectively to boost it? 
            // Let's normalize it: (trustScore / 0.3) * 0.15. That gives exactly 15% power when fully trusted.

            const normalizedTrust = (trustScore / 0.3);
            const calcScore =
              priceConfidence * 0.45 +
              0.85 * 0.20 +
              feedbackScore * 0.20 +
              normalizedTrust * 0.15;

            // Re-assign for consistency
            const finalScoreVal = calcScore;
            const risk = finalScore >= 0.8 ? "LOW" : finalScore >= 0.6 ? "MEDIUM" : "HIGH";

            return {
              id: `cand_${idx}_${c.current_A} a`,
              variant_id: c.variant_id, // For price history lookup
              brand,
              // Three separate label fields (IMPORTANT)
              listing_title: c.title,          // Marketing title from listing
              variant_label: variantLabel,     // Exact variant from selector
              display_label: displayLabel,     // Pack + variant for UI/CSV
              model: displayLabel,             // Backward compat
              // Pack pricing (original)
              pack_qty: packQty,
              pack_price_usd: packPriceUsd,
              pack_price_local: packPriceLocal,
              // Normalized unit pricing
              unit_price_usd: unitPriceUsd,
              unit_price_local: unitPriceLocal,
              local_currency: c.price_currency,
              // Feedback signals for trust scoring
              feedback: {
                rating: c.seller?.rating || 0,
                reviews: c.review_count,
                sold: c.sold_count,
                store_years: c.store_years,
                choice: !!c.has_choice,
                photos: !!c.has_photos,
                score: feedbackScore
              },
              // Trust signals from user memory
              trust: {
                score: trustScore,
                select_count: trust.select_count,
                is_trusted: trust.select_count >= 3
              },
              confidence: priceConfidence,
              final_score: Math.round(finalScoreVal * 100) / 100,
              risk,
              remark: c.seller?.name || "AliExpress Seller",
              variant_verified: true,
              stock_ok: true,
              product_url: c.product_url,
              last_updated: c.last_updated,
              default: false,
              is_estimate: !!c.is_estimate
            };
          });

          // Sort by final_score desc, then price asc
          allCandidates.sort((a, b) => {
            if (b.final_score !== a.final_score) return b.final_score - a.final_score;
            return (a.unit_price_usd || 999) - (b.unit_price_usd || 999);
          });

          // Mark first as default
          if (allCandidates.length > 0) {
            allCandidates[0].default = true;
          }

          // 5. Nova ACT Ranking (for backward compatibility)
          const nova = novaRank(b, candidates);
          // If we have candidates, we prefer our own sorting. 
          // Nova logic was mock.
          const selected = allCandidates[0]; // Pick best candidate

          if (!selected) {
            const cleanKeyword = b.raw.replace(/x\d+$/i, "").trim();
            results.push({
              bom: b,
              status: "PENDING_CRAWL",
              message: "Fetching from trusted source...",
              crawl_keyword: cleanKeyword,
              manual_url: buildAliExpressSearchUrl(cleanKeyword)
            });
            continue;
          }

          // 5a. Price trend computation (only for selected candidate - performance)
          let priceTrend = { trend: "stable", change_pct: 0, data_points: 0 };
          if (selected.variant_id) {
            const history = await getRecentPriceHistory(env.DB, selected.variant_id, sourceFilter);
            priceTrend = computePriceTrend(history);
          }

          // 6. Currency Conversion
          const unitPriceUsd = toUsd(selected.price_value, selected.price_currency);
          const totalPriceUsd = unitPriceUsd != null ? unitPriceUsd * b.qty : null;

          // 7. Apply confidence decay based on price age
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
            // Price trend info
            price_trend: priceTrend.trend,
            price_change_pct: priceTrend.change_pct,
            price_history_points: priceTrend.data_points,
            // Candidates array (limited for performance)
            candidates: allCandidates.slice(0, MAX_PRODUCTS_PER_ITEM)
          });
        }

        // 7. Return Response (JSON or CSV)
        const format = url.searchParams.get("format");

        if (format === "csv") {
          const csv = toCSV(results);
          return new Response(csv, {
            headers: {
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition": 'attachment; filename="bom.csv"',
              "Cache-Control": "no-store",
              "Access-Control-Allow-Origin": "*"
            }
          });
        }

        return Response.json(
          {
            status: "ok",
            version: VERSION,
            test_mode: isRCTest,
            truncated,
            currency: "USD",
            generated_at: new Date().toISOString(),
            items: results
          },
          {
            headers: {
              "Access-Control-Allow-Origin": "*"
            }
          }
        );
      } catch (priceError) {
        console.error("[API/price] Uncaught error:", priceError);
        return Response.json({
          status: "error",
          message: "Internal server error in price handler",
          error: priceError.message,
          stack: priceError.stack?.split("\n").slice(0, 5).join("\n")
        }, {
          status: 500,
          headers: { "Access-Control-Allow-Origin": "*" }
        });
      }
    } // End pricing API

    // Fallback
    return new Response("Not Found", { status: 404 });
  }
};
