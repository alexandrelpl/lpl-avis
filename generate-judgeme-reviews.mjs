#!/usr/bin/env node
/**
 * ============================================================================
 * GÉNÉRATEUR DE JSON D'AVIS JUDGE.ME  (snapshot sécurisé, côté serveur)
 * ----------------------------------------------------------------------------
 * Ce script :
 *   1. Convertit chaque handle produit Shopify -> ID interne Judge.me
 *   2. Récupère les avis de chaque produit (par_page=100, publiés uniquement)
 *   3. Filtre sur les notes >= MIN_RATING (3 par défaut)
 *   4. Fusionne, trie, et garde les LIMIT plus récents (20 par défaut)
 *   5. Écrit "judgeme-reviews.json" et affiche le JSON à coller dans la section
 *
 * Le Private Token RESTE sur ta machine (variable d'environnement).
 * Il n'est JAMAIS écrit dans le JSON ni exposé au navigateur.
 *
 * ----------------------------------------------------------------------------
 * PRÉREQUIS : Node.js 18 ou plus récent (fetch natif).
 *
 * UTILISATION (depuis un terminal, dans le dossier du script) :
 *
 *   SHOP_DOMAIN="le-petit-lunetier.myshopify.com" \
 *   JUDGEME_API_TOKEN="ton_private_token" \
 *   node generate-judgeme-reviews.mjs
 *
 * (Sur Windows PowerShell :
 *   $env:SHOP_DOMAIN="..."; $env:JUDGEME_API_TOKEN="..."; node generate-judgeme-reviews.mjs )
 * ============================================================================
 */

// ─────────────────────────────────────────────────────────────────────────────
// ⚙️  CONFIGURATION — À ADAPTER
// ─────────────────────────────────────────────────────────────────────────────

// La liste FIXE de produits à mettre en avant (leurs handles Shopify).
// Le handle est la fin de l'URL : /products/CE-QUI-EST-ICI
const PRODUCT_HANDLES = [
  'annie-j-champagne-lumiere-bleue',
  'annie-j-bleu-ecaille-lumiere-bleue',
  'annie-j-ecaille-lumiere-bleue',
  'jerry-s-ecaille-solaire',
  'gigi-ecaille-lumiere-bleue-copy',
  'dolores-ecaille-solaire',
  'dolores-ecaille-lumiere-bleue',
  'annie-j-ecaille-solaire',
  'emma-s-noir',
  'peaches-s-noir-solaire',
  'emily-c-gold-lumiere-bleue',
  'montrose-noir-lumiere-bleue',
  'alex-l-ecaille-solaire',
  'naya-ecaille-rouge-solaire',
];

const MIN_RATING = 3;   // notes minimales conservées (3 -> garde 3, 4 et 5 étoiles)
const LIMIT      = 20;  // nombre d'avis final
const SORT_BY    = 'date'; // 'date' (plus récents) ou 'rating' (mieux notés d'abord)

const OUTPUT_FILE = 'judgeme-reviews.json';

// ─────────────────────────────────────────────────────────────────────────────
// 🔒  IDENTIFIANTS (via variables d'environnement — ne pas écrire en dur ici)
// ─────────────────────────────────────────────────────────────────────────────
const SHOP_DOMAIN = process.env.SHOP_DOMAIN;
const API_TOKEN   = process.env.JUDGEME_API_TOKEN;

const BASE = 'https://api.judge.me/api/v1';

// ─────────────────────────────────────────────────────────────────────────────

import { writeFileSync } from 'node:fs';

function assertEnv() {
  const missing = [];
  if (!SHOP_DOMAIN) missing.push('SHOP_DOMAIN');
  if (!API_TOKEN) missing.push('JUDGEME_API_TOKEN');
  if (missing.length) {
    console.error(`\n❌ Variable(s) d'environnement manquante(s) : ${missing.join(', ')}`);
    console.error('   Exemple :');
    console.error('   SHOP_DOMAIN="xxx.myshopify.com" JUDGEME_API_TOKEN="ton_token" node generate-judgeme-reviews.mjs\n');
    process.exit(1);
  }
  if (PRODUCT_HANDLES.some(h => h.startsWith('remplace-moi'))) {
    console.error('\n❌ Remplace d\'abord les handles produits factices dans PRODUCT_HANDLES (en haut du script).\n');
    process.exit(1);
  }
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} sur ${url.replace(API_TOKEN, '***')}`);
  }
  return res.json();
}

// 1) Handle Shopify -> ID interne Judge.me
async function resolveInternalId(handle) {
  const url = `${BASE}/products/-1?shop_domain=${encodeURIComponent(SHOP_DOMAIN)}`
            + `&api_token=${encodeURIComponent(API_TOKEN)}`
            + `&handle=${encodeURIComponent(handle)}`;
  const data = await getJson(url);
  const product = data.product || data;
  if (!product || !product.id) {
    throw new Error(`Aucun produit Judge.me trouvé pour le handle "${handle}"`);
  }
  return { id: product.id, title: product.title || handle, handle };
}

// 2) Récupère tous les avis publiés d'un produit (jusqu'à 100)
async function fetchReviews(productInternalId) {
  const url = `${BASE}/reviews?shop_domain=${encodeURIComponent(SHOP_DOMAIN)}`
            + `&api_token=${encodeURIComponent(API_TOKEN)}`
            + `&product_id=${productInternalId}`
            + `&per_page=100&published=true`;
  const data = await getJson(url);
  return Array.isArray(data.reviews) ? data.reviews : [];
}

// Mise en forme d'un avis brut -> objet propre et minimal
function cleanReview(raw, product) {
  const reviewer =
    (raw.reviewer && (raw.reviewer.name || raw.reviewer.email)) ||
    raw.reviewer_name || 'Client vérifié';

  const verified =
    raw.verified === 'buyer' || raw.verified === true || raw.verified === 'verified';

  return {
    id: raw.id,
    rating: Number(raw.rating) || 0,
    title: (raw.title || '').trim(),
    body: (raw.body || '').trim(),
    reviewer: String(reviewer).trim(),
    verified: Boolean(verified),
    date: raw.created_at || raw.updated_at || null,
    product_title: product.title,
    product_handle: product.handle,
    product_url: `/products/${product.handle}`,
  };
}

async function main() {
  assertEnv();

  console.log(`\n→ Boutique : ${SHOP_DOMAIN}`);
  console.log(`→ Produits : ${PRODUCT_HANDLES.length}`);
  console.log(`→ Filtre   : notes >= ${MIN_RATING}, max ${LIMIT} avis, tri par ${SORT_BY}\n`);

  let all = [];

  for (const handle of PRODUCT_HANDLES) {
    try {
      const product = await resolveInternalId(handle);
      const raw = await fetchReviews(product.id);
      const kept = raw
        .map(r => cleanReview(r, product))
        .filter(r => r.rating >= MIN_RATING && r.body.length > 0);

      console.log(`  ✓ ${handle} : ${kept.length} avis ≥${MIN_RATING}★ (sur ${raw.length} récupérés)`);
      all = all.concat(kept);
    } catch (err) {
      console.warn(`  ✗ ${handle} : ${err.message}`);
    }
  }

  // Dédoublonnage par id d'avis (au cas où)
  const seen = new Set();
  all = all.filter(r => (seen.has(r.id) ? false : (seen.add(r.id), true)));

  // Tri
  if (SORT_BY === 'rating') {
    all.sort((a, b) => (b.rating - a.rating) || (new Date(b.date) - new Date(a.date)));
  } else {
    all.sort((a, b) => new Date(b.date) - new Date(a.date));
  }

  // Limite
  const final = all.slice(0, LIMIT);

  const payload = {
    generated_at: new Date().toISOString(),
    count: final.length,
    min_rating: MIN_RATING,
    reviews: final,
  };

  const json = JSON.stringify(payload, null, 2);
  writeFileSync(OUTPUT_FILE, json, 'utf8');

  console.log(`\n✅ ${final.length} avis écrits dans "${OUTPUT_FILE}".`);
  console.log('   Copie/colle le contenu ci-dessous dans le champ "Données des avis (JSON)" de la section :\n');
  console.log('────────────────────────────────────────────────────────');
  console.log(json);
  console.log('────────────────────────────────────────────────────────\n');
}

main().catch(err => {
  console.error('\n❌ Erreur fatale :', err.message, '\n');
  process.exit(1);
});
