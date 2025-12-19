-- Migration: Add link resolution columns to product_variants

ALTER TABLE product_variants ADD COLUMN link_status TEXT DEFAULT 'search_only';
ALTER TABLE product_variants ADD COLUMN variant_url TEXT;
