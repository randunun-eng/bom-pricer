
/**
 * Shared logic for Variant Catalog Indexing
 * Used by both Worker (lookup) and Orchestrator (ingestion)
 */

// Format: "{TYPE}:{KEY_SPECS}"
// ESC: "ESC:30A"
// Motor: "MOTOR:2300KV" or "MOTOR:2205:2300KV"
// Battery: "BATTERY:3S:1500MAH"
// Prop: "PROP:5045"
// Servo: "SERVO:9G"

export function generateSpecKey(type, specs) {
    if (!type) return null;
    const t = type.toUpperCase();

    if (t === "ESC") {
        // ESC:30A
        if (specs.current_A) return `ESC:${specs.current_A}A`;
        return "ESC:UNKNOWN";
    }

    if (t === "MOTOR") {
        // MOTOR:2300KV or MOTOR:2205:2300KV
        const kv = specs.kv ? `${specs.kv}KV` : null;
        const size = specs.size ? specs.size : null;
        if (size && kv) return `MOTOR:${size}:${kv}`;
        if (kv) return `MOTOR:${kv}`;
        // Use normalized raw keyword for DC/coreless motors without KV
        if (specs.raw) {
            const normalized = specs.raw.replace(/\s+/g, '_').substring(0, 50);
            return `MOTOR:${normalized}`;
        }
        return "MOTOR:UNKNOWN";
    }

    if (t === "BATTERY" || t === "LIPO") {
        // BATTERY:3S:1500MAH
        const s = specs.voltage_s ? specs.voltage_s // already "3S" or "2-4S" ? Normalize?
            : (specs.cells ? `${specs.cells}S` : null);

        // Normalize cells if it came in as number
        const cellsStr = specs.cells ? `${specs.cells}S` : (specs.voltage_s || null);

        const mah = specs.capacity_mah ? `${specs.capacity_mah}MAH` : null;

        if (cellsStr && mah) return `BATTERY:${cellsStr}:${mah}`;
        if (cellsStr) return `BATTERY:${cellsStr}`;
        return "BATTERY:UNKNOWN";
    }

    if (t === "PROP" || t === "PROPELLER") {
        // PROP:5045
        if (specs.size) return `PROP:${specs.size}`;
        return "PROP:UNKNOWN";
    }

    if (t === "SERVO") {
        // SERVO:9G
        if (specs.weight) return `SERVO:${specs.weight}`; // e.g. "9G"
        return "SERVO:UNKNOWN";
    }

    return `${t}:UNKNOWN`;
}

// Stable Variant ID
// sha1(product_id + variant_label + pack_qty + source) - includes source to avoid RC test conflicts
export async function generateVariantId(productId, variantLabel, packQty, source = 'prod') {
    const input = `${productId}|${variantLabel || ""}|${packQty || 1}|${source}`;
    const encoder = new TextEncoder();
    const data = encoder.encode(input);
    const hashBuffer = await crypto.subtle.digest('SHA-1', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex;
}

// DETERMINISTIC SPEC EXTRACTION (STRICT)
// This replaces loose normalization for ingestion purposes.
export function extractSpecs(variantLabel) {
    if (!variantLabel) return { current_A: null, pack_qty: 1, voltage_s: null, capacity_mah: null, kv: null };

    const text = variantLabel.toUpperCase();

    // 1. Pack Quantity
    // "4Pcs", "1Pc", "5x", "x5", "5 x"
    let pack_qty = 1;
    const packMatch = text.match(/(\d+)\s*(PCS|PC|PAIRS|PAIR)/i)
        || text.match(/X\s*(\d+)/i)
        || text.match(/^(\d+)\s*X/i)
        || text.match(/[X\s](\d+)\s*$/i);
    if (packMatch) {
        pack_qty = parseInt(packMatch[1] || packMatch[2] || packMatch[0].match(/\d+/)[0], 10);
    }
    // Sanity check
    if (pack_qty < 1) pack_qty = 1;

    // 2. Amps (ESC) - strict "35A", "40A". Avoid UBEC/BEC ratings (usually 3A/5A).
    const ampMatches = [...text.matchAll(/(\d+)\s*A\b/g)];
    let current_A = null;
    if (ampMatches.length > 0) {
        // Prioritize values >= 10 (likely ESC rating) over small values (likely UBEC)
        const candidates = ampMatches.map(m => parseInt(m[1], 10));
        const largeAmps = candidates.filter(a => a >= 10);
        current_A = largeAmps.length > 0 ? largeAmps[0] : candidates[0];
    }

    // 3. Voltage (Battery/ESC) - "3S", "2-4S"
    const voltMatch = text.match(/(\d+(?:-\d+)?)\s*S\b/);
    const voltage_s = voltMatch ? voltMatch[1] + "S" : null;

    // 4. Capacity (Battery) - "1500mAh"
    const capMatch = text.match(/(\d+)\s*MAH/);
    const capacity_mah = capMatch ? parseInt(capMatch[1], 10) : null;

    // 5. KV (Motor) - "2300KV"
    const kvMatch = text.match(/(\d+)\s*KV/);
    const kv = kvMatch ? parseInt(kvMatch[1], 10) : null;

    return {
        current_A,
        pack_qty,
        voltage_s,
        capacity_mah,
        kv
    };
}

// Helper to normalize specs from raw crawl data or BOM line
// Returns standardized object: { current_A, kv, cells, capacity_mah, size, ... }
export function normalizeSpecs(type, rawData) {
    // rawData can be { title, variant } from crawl
    // or { specs } from BOM parser
    const combinedText = ((rawData.title || "") + " " + (rawData.variant || "") + " " + (rawData.raw || "")).toUpperCase();
    const extracted = extractSpecs(combinedText);

    // Map strict extraction back to loose objects expected by legacy code if needed
    // But mostly we used specific parsers before. Now we use the unified extractor.

    let specs = { ...extracted };

    // Map voltage_s to cells for compatibility if needed
    if (specs.voltage_s) {
        const cells = parseInt(specs.voltage_s); // "3S" -> 3
        if (!isNaN(cells)) specs.cells = cells;
    }

    return specs;
}
