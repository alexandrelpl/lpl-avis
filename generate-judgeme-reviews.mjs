#!/usr/bin/env node
/**
 * ============================================================================
 * GÉNÉRATEUR DE JSON D'AVIS JUDGE.ME — MODE STORE-WIDE
 * ----------------------------------------------------------------------------
 * Récupère les avis de TOUTE la boutique (pas une sélection de produits),
 * filtre les notes >= MIN_RATING, trie par date décroissante, garde les LIMIT
 * plus récents, et résout le produit de chaque avis (pour le lien).
 *
 * Le Private Token RESTE sur ta machine / dans les secrets GitHub (jamais ici).
 *
 * ----------------------------------------------------------------------------
 * PRÉREQUIS : Node.js 18+ (fetch natif).
 * UTILISATION :
 *   SHOP_DOMAIN="le-petit-lunetier.myshopify.com" \
 *   JUDGEME_API_TOKEN="ton_private_token" \
 *   node generate-judgeme-reviews.mjs
 * ============================================================================
 */

import { writeFileSync } from 'node:fs';

// ─────────────────────────────────────────────────────────────────────────────
// ⚙️  RÉGLAGES
// ─────────────────────────────────────────────────────────────────────────────
const MIN_RATING   = 3;     // notes minimales conservées (3 -> 3, 4 et 5 étoiles)
const LIMIT        = 20;    // nombre d'avis final
const REQUIRE_TEXT = false; // true = ne garder que les avis avec un vrai commentaire écrit
const MAX_PAGES    = 100;   // garde-fou (100 pages x 100 = 10 000 avis max balayés)
const OUTPUT_FILE  = 'judgeme-reviews.json';
const BASE         = 'https://api.judge.me/api/v1';

// ─────────────────────────────────────────────────────────────────────────────
// 🔒  IDENTIFIANTS (variables d'environnement)
// ─────────────────────────────────────────────────────────────────────────────
const SHOP_DOMAIN = process.env.SHOP_DOMAIN;
const API_TOKEN   = process.env.JUDGEME_API_TOKEN;

const AUTH = `shop_domain=${encodeURIComponent(SHOP_DOMAIN || '')}&api_token=${encodeURIComponent(API_TOKEN || '')}`;

function assertEnv() {
  const missing = [];
  if (!SHOP_DOMAIN) missing.push('SHOP_DOMAIN');
  if (!API_TOKEN) missing.push('JUDGEME_API_TOKEN');
  if (missing.length) {
    console.error(`\n❌ Variable(s) d'environnement manquante(s) : ${missing.join(', ')}`);
    console.error('   Exemple : SHOP_DOMAIN="xxx.myshopify.com" JUDGEME_API_TOKEN="..." node generate-judgeme-reviews.mjs\n');
    process.exit(1);
  }
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} sur ${url.replace(API_TOKEN, '***')}`);
  return res.json();
}

// 1) Pagination de TOUS les avis publiés de la boutique
async function fetchAllReviews() {
  let all = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${BASE}/reviews?${AUTH}&per_page=100&published=true&page=${page}`;
    const data = await getJson(url);
    const reviews = Array.isArray(data.reviews) ? data.reviews : [];
    all = all.concat(reviews);
    if (reviews.length < 100) break; // dernière page atteinte
  }
  return all;
}

// 2) Résolution produit (handle + titre) pour le lien, avec cache
const productCache = new Map();
async function resolveProduct(review) {
  // Si l'avis porte déjà l'info, on s'en sert directement
  if (review.product_handle && review.product_title) {
    return { handle: review.product_handle, title: review.product_title };
  }
  const ext = review.product_external_id;
  const internal = review.product_id;
  const key = ext ? ('e' + ext) : (internal ? ('i' + internal) : null);
  if (!key) return { handle: null, title: null };
  if (productCache.has(key)) return productCache.get(key);

  let product = null;
  try {
    let url;
    if (ext) url = `${BASE}/products/-1?${AUTH}&external_id=${encodeURIComponent(ext)}`;
    else     url = `${BASE}/products/${encodeURIComponent(internal)}?${AUTH}`;
    const d = await getJson(url);
    product = d.product || d;
  } catch (e) { /* on ignore : le lien sera simplement absent */ }

  const res = (product && product.handle)
    ? { handle: product.handle, title: product.title || product.handle }
    : { handle: null, title: null };
  productCache.set(key, res);
  return res;
}

function reviewerName(r) {
  return (r.reviewer && (r.reviewer.name || r.reviewer.email)) || r.reviewer_name || 'Client vérifié';
}
function isVerified(r) {
  return r.verified === 'buyer' || r.verified === true || r.verified === 'verified';
}

async function main() {
  assertEnv();
  console.log(`\n→ Boutique : ${SHOP_DOMAIN}`);
  console.log(`→ Mode     : TOUS les produits, notes >= ${MIN_RATING}, ${LIMIT} plus récents\n`);

  const raw = await fetchAllReviews();
  console.log(`  Avis récupérés (toute la boutique) : ${raw.length}`);
  if (raw[0]) console.log(`  Champs d'un avis : ${Object.keys(raw[0]).join(', ')}`);

  // Filtre note + tri par date décroissante
  let kept = raw.filter(r => Number(r.rating) >= MIN_RATING);
  kept.sort((a, b) => new Date(b.created_at || b.updated_at || 0) - new Date(a.created_at || a.updated_at || 0));

  // Construction des 20 plus récents (avec résolution produit)
  const out = [];
  for (const r of kept) {
    if (out.length >= LIMIT) break;

    const p = await resolveProduct(r);

    let body = (r.body || '').trim();
    // Certains avis "note seule" ont pour corps le nom du produit : on le neutralise
    if (p.title && body === p.title.trim()) body = '';
    if (REQUIRE_TEXT && body.length === 0) continue;

    out.push({
      id: r.id,
      rating: Number(r.rating) || 0,
      title: (r.title || '').trim(),
      body,
      reviewer: String(reviewerName(r)).trim(),
      verified: Boolean(isVerified(r)),
      date: r.created_at || r.updated_at || null,
      product_title: p.title || '',
      product_handle: p.handle || '',
      product_url: p.handle ? `/products/${p.handle}` : '',
    });
  }

  const payload = {
    generated_at: new Date().toISOString(),
    count: out.length,
    min_rating: MIN_RATING,
    reviews: out,
  };

  const json = JSON.stringify(payload, null, 2);
  writeFileSync(OUTPUT_FILE, json, 'utf8');

  console.log(`\n✅ ${out.length} avis écrits dans "${OUTPUT_FILE}".`);
  if (out[0]) console.log(`   Plus récent : ${out[0].date} — ${out[0].reviewer} (${out[0].product_title || 'produit ?'})`);
}

main().catch(err => {
  console.error('\n❌ Erreur fatale :', err.message, '\n');
  process.exit(1);
});
