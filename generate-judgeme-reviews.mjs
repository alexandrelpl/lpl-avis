#!/usr/bin/env node
/**
 * ============================================================================
 * GÉNÉRATEUR DE JSON D'AVIS JUDGE.ME — MODE LISTE (léger & robuste)
 * ----------------------------------------------------------------------------
 * Récupère les avis d'une SÉLECTION de produits (liste de handles), filtre les
 * notes >= MIN_RATING, trie par date, garde les LIMIT plus récents.
 *
 * Léger : seulement quelques requêtes (≠ store-wide qui balayait toute la
 * boutique et se faisait bloquer par l'API). Inclut un petit délai + 1 retry
 * pour éviter les limites de débit (rate limit) qui faisaient planter le run.
 *
 * Le Private Token RESTE dans les secrets GitHub (jamais ici).
 *
 * PRÉREQUIS : Node.js 18+.
 * UTILISATION :
 *   SHOP_DOMAIN="le-petit-lunetier.myshopify.com" \
 *   JUDGEME_API_TOKEN="ton_private_token" \
 *   node generate-judgeme-reviews.mjs
 * ============================================================================
 */

import { writeFileSync } from 'node:fs';

// ─────────────────────────────────────────────────────────────────────────────
// ⚙️  CONFIGURATION — À ADAPTER
// ─────────────────────────────────────────────────────────────────────────────

// La liste FIXE de produits à mettre en avant (handles Shopify = fin des URLs /products/...).
// Pré-remplie avec des produits actifs ; ajuste selon ce que tu veux montrer.
const PRODUCT_HANDLES = [
  'annie-j-ecaille-lumiere-bleue',
  'gigi-champagne-solaire',
  'gigi-vert-lumiere-bleue-1',
  'grace-b-gris-solaire',
  'montrose-noir-lumiere-bleue',
  'diana-noir-lumiere-bleue',
];

const MIN_RATING          = 3;     // notes minimales conservées (3 -> 3, 4 et 5★)
const LIMIT               = 20;    // nombre d'avis final
const REQUIRE_TEXT        = false; // true = uniquement les avis avec un vrai commentaire
const INCLUDE_UNPUBLISHED = false; // ⚠️ true = inclut les avis NON publiés (récents mais non validés en boutique)
const PAGES_PER_PRODUCT   = 2;     // pages de 100 avis par produit (200 récents = large)
const REQUEST_DELAY_MS    = 300;   // pause entre requêtes (anti rate-limit)

const OUTPUT_FILE = 'judgeme-reviews.json';
const BASE        = 'https://api.judge.me/api/v1';

// ─────────────────────────────────────────────────────────────────────────────
// 🔒  IDENTIFIANTS (variables d'environnement)
// ─────────────────────────────────────────────────────────────────────────────
const SHOP_DOMAIN = process.env.SHOP_DOMAIN;
const API_TOKEN   = process.env.JUDGEME_API_TOKEN;
const AUTH = `shop_domain=${encodeURIComponent(SHOP_DOMAIN || '')}&api_token=${encodeURIComponent(API_TOKEN || '')}`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function assertEnv() {
  const missing = [];
  if (!SHOP_DOMAIN) missing.push('SHOP_DOMAIN');
  if (!API_TOKEN) missing.push('JUDGEME_API_TOKEN');
  if (missing.length) {
    console.error(`\n❌ Variable(s) d'environnement manquante(s) : ${missing.join(', ')}\n`);
    process.exit(1);
  }
  if (PRODUCT_HANDLES.length === 0 || PRODUCT_HANDLES.some(h => h.startsWith('remplace-moi'))) {
    console.error('\n❌ Renseigne d\'abord PRODUCT_HANDLES (en haut du script).\n');
    process.exit(1);
  }
}

// fetch JSON avec 1 retry en cas de rate limit (429) ou erreur serveur (5xx)
async function getJson(url, attempt = 0) {
  const res = await fetch(url);
  if ((res.status === 429 || res.status >= 500) && attempt < 1) {
    await sleep(2000);
    return getJson(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} sur ${url.replace(API_TOKEN, '***')}`);
  return res.json();
}

// Handle Shopify -> ID interne Judge.me (+ titre)
async function resolveInternalId(handle) {
  const url = `${BASE}/products/-1?${AUTH}&handle=${encodeURIComponent(handle)}`;
  const data = await getJson(url);
  const product = data.product || data;
  if (!product || !product.id) throw new Error(`Produit introuvable pour le handle "${handle}"`);
  return { id: product.id, title: product.title || handle, handle };
}

// Avis d'un produit (quelques pages max)
async function fetchReviews(productInternalId) {
  const publishedParam = INCLUDE_UNPUBLISHED ? '' : '&published=true';
  let all = [];
  for (let page = 1; page <= PAGES_PER_PRODUCT; page++) {
    const url = `${BASE}/reviews?${AUTH}&product_id=${productInternalId}&per_page=100${publishedParam}&page=${page}`;
    const data = await getJson(url);
    const reviews = Array.isArray(data.reviews) ? data.reviews : [];
    all = all.concat(reviews);
    if (reviews.length < 100) break;
    await sleep(REQUEST_DELAY_MS);
  }
  return all;
}

function reviewerName(r) {
  return (r.reviewer && (r.reviewer.name || r.reviewer.email)) || r.reviewer_name || 'Client vérifié';
}
function isVerified(r) {
  return r.verified === 'buyer' || r.verified === true || r.verified === 'verified';
}

function cleanReview(raw, product) {
  let body = (raw.body || '').trim();
  if (product.title && body === product.title.trim()) body = ''; // neutralise les "note seule"
  return {
    id: raw.id,
    rating: Number(raw.rating) || 0,
    title: (raw.title || '').trim(),
    body,
    reviewer: String(reviewerName(raw)).trim(),
    verified: Boolean(isVerified(raw)),
    date: raw.created_at || raw.updated_at || null,
    product_title: product.title,
    product_handle: product.handle,
    product_url: `/products/${product.handle}`,
  };
}

async function main() {
  assertEnv();
  console.log(`\n→ Boutique : ${SHOP_DOMAIN}`);
  console.log(`→ Produits : ${PRODUCT_HANDLES.length} | notes >= ${MIN_RATING} | ${LIMIT} plus récents`);
  console.log(`→ Avis non publiés inclus : ${INCLUDE_UNPUBLISHED ? 'OUI' : 'non'}\n`);

  let all = [];
  for (const handle of PRODUCT_HANDLES) {
    try {
      const product = await resolveInternalId(handle);
      await sleep(REQUEST_DELAY_MS);
      const raw = await fetchReviews(product.id);
      const kept = raw
        .map(r => cleanReview(r, product))
        .filter(r => r.rating >= MIN_RATING)
        .filter(r => (REQUIRE_TEXT ? r.body.length > 0 : true));
      console.log(`  ✓ ${handle} : ${kept.length} avis ≥${MIN_RATING}★ (sur ${raw.length} récupérés)`);
      all = all.concat(kept);
      await sleep(REQUEST_DELAY_MS);
    } catch (err) {
      console.warn(`  ✗ ${handle} : ${err.message}`);
    }
  }

  // Dédoublonnage + tri par date décroissante + limite
  const seen = new Set();
  all = all.filter(r => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  all.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  const final = all.slice(0, LIMIT);

  const payload = {
    generated_at: new Date().toISOString(),
    count: final.length,
    min_rating: MIN_RATING,
    reviews: final,
  };

  writeFileSync(OUTPUT_FILE, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`\n✅ ${final.length} avis écrits dans "${OUTPUT_FILE}".`);
  if (final[0]) console.log(`   Plus récent : ${final[0].date} — ${final[0].reviewer} (${final[0].product_title})`);
}

main().catch(err => {
  console.error('\n❌ Erreur fatale :', err.message, '\n');
  process.exit(1);
});
