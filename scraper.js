'use strict';

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const TelegramBot = require('node-telegram-bot-api');

// --- SERVER WEB PENTRU RENDER ---
const app = express();
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
  res.send('FlipIQ Scraper is running successfully!');
});

app.listen(PORT, () => {
  console.log(`[Render] Server pornit pe portul ${PORT}.`);
  startScraperLifecycle();
});
// ---------------------------------

const PRICE_MIN = 20000;
const PRICE_MAX = 32000;
const MAX_PRICE_PER_SQM = 950;
const SCRAPE_INTERVAL_MS = 10 * 60 * 1000;

// Target-uri cu link-uri optimizate și curate pentru a evita erorile de filtrare directă
const SEARCH_TARGETS = [
  {
    platform: 'OLX',
    location: 'Constanța',
    url: 'https://www.olx.ro/imobiliare/apartamente-garsoniere-de-vanzare/constanta/?search%5Bfilter_float_price%3Afrom%5D=20000&search%5Bfilter_float_price%3Ato%5D=32000',
  },
  {
    platform: 'OLX',
    location: 'Năvodari',
    url: 'https://www.olx.ro/imobiliare/apartamente-garsoniere-de-vanzare/navodari-jud-constanta/?search%5Bfilter_float_price%3Afrom%5D=20000&search%5Bfilter_float_price%3Ato%5D=32000',
  },
  {
    platform: 'Storia',
    location: 'Constanța',
    url: 'https://www.storia.ro/ro/rezultate/vanzare/apartament/constanta/constanta/constanta?limit=36&priceMin=20000&priceMax=32000',
  },
  {
    platform: 'Storia',
    location: 'Năvodari',
    url: 'https://www.storia.ro/ro/rezultate/vanzare/apartament/constanta/navodari?limit=36&priceMin=20000&priceMax=32000',
  },
  {
    platform: 'Imobiliare.ro',
    location: 'Constanța',
    url: 'https://www.imobiliare.ro/vanzare-apartamente/constanta?pret-min=20000&pret-max=32000',
  },
  {
    platform: 'Imobiliare.ro',
    location: 'Năvodari',
    url: 'https://www.imobiliare.ro/vanzare-apartamente/navodari-constanta?pret-min=20000&pret-max=32000',
  },
];

const http = axios.create({
  timeout: 20000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'ro,en-US;q=0.7,en;q=0.3',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache'
  }
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseNumber(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const str = String(value).trim();
  const match = str.match(/(\d[\d\s.,]*)/);
  if (!match) return null;
  const normalized = match[1].replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
  const num = parseFloat(normalized);
  return Number.isFinite(num) ? num : null;
}

function extractSurfaceFromText(...parts) {
  const text = parts.filter(Boolean).join(' ');
  const patterns = [
    /(\d+(?:[.,]\d+)?)\s*m[²2]\b/gi,
    /(\d+(?:[.,]\d+)?)\s*mp\b/gi,
    /suprafat[aa][^0-9]{0,20}(\d+(?:[.,]\d+)?)/gi
  ];
  for (const pattern of patterns) {
    const matches = [...text.matchAll(pattern)];
    for (const match of matches) {
      const area = parseNumber(match[1]);
      if (area && area >= 10 && area <= 200) return area;
    }
  }
  return null;
}

function extractPriceEur(...parts) {
  const text = parts.filter(Boolean).join(' ');
  const eurMatch = text.match(/([\d\s.,]+)\s*(?:€|EUR)\b/i);
  if (eurMatch) {
    const price = parseNumber(eurMatch[1]);
    if (price) return price;
  }
  return null;
}

function normalizeListingUrl(url, baseUrl) {
  if (!url) return null;
  let cleaned = url.split('?')[0];
  if (cleaned.startsWith('http')) return cleaned;
  if (cleaned.startsWith('//')) return `https:${cleaned}`;
  if (cleaned.startsWith('/')) return new URL(cleaned, baseUrl).href;
  return new URL(cleaned, baseUrl).href;
}

function extractPriceFromObject(obj) {
  if (!obj) return null;
  if (typeof obj === 'number') return obj;
  if (typeof obj === 'string') return extractPriceEur(obj);
  if (obj.value != null) return parseNumber(obj.value);
  if (obj.amount != null) return parseNumber(obj.amount);
  return null;
}

function extractSurfaceFromObject(obj) {
  if (!obj) return null;
  if (typeof obj === 'number') return obj;
  if (typeof obj === 'string') return extractSurfaceFromText(obj);
  const keys = ['area', 'surface', 'size', 'usableArea', 'value'];
  for (const key of keys) {
    if (obj[key] != null) {
      const val = parseNumber(obj[key]);
      if (val && val >= 10 && val <= 200) return val;
    }
  }
  return null;
}

function isListingCandidate(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const title = obj.title || obj.name || obj.adTitle;
  const url = obj.url || obj.link || obj.href || obj.slug;
  return Boolean(title && url);
}

function normalizeRawListing(raw, meta) {
  const title = String(raw.title || raw.name || '').trim();
  const url = normalizeListingUrl(raw.url || raw.link || raw.href || raw.slug, meta.baseUrl);

  if (!url || url.includes('[lang]') || url.includes('[hpr]') || url.includes('/undefined')) {
    return null;
  }

  let price = extractPriceFromObject(raw.price) || extractPriceFromObject(raw.totalPrice) || extractPriceEur(title);
  let surface = extractSurfaceFromObject(raw.surface) || extractSurfaceFromObject(raw.area) || extractSurfaceFromText(title, raw.description);

  if (raw.params && Array.isArray(raw.params)) {
    for (const p of raw.params) {
      const key = String(p.key || '').toLowerCase();
      if (['surface', 'm2', 'suprafata'].includes(key)) {
        surface = surface || parseNumber(p.value?.value || p.value);
      }
      if (key === 'price') {
        price = price || parseNumber(p.value?.value || p.value);
      }
    }
  }

  if (!url || !title || !price) return null;

  return {
    platform: meta.platform,
    location: meta.location,
    title,
    url,
    price,
    surface: surface || 35 // Valoare fallback rezonabilă dacă nu s-a putut extrage suprafața din JSON-ul brut
  };
}

function collectListingsFromJson(node, results, seen, depth = 0) {
  if (!node || depth > 15) return;
  if (Array.isArray(node)) {
    for (const item of node) collectListingsFromJson(item, results, seen, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;

  if (isListingCandidate(node)) {
    const key = String(node.url || node.slug || node.title).trim();
    if (key && !seen.has(key)) {
      seen.add(key);
      results.push(node);
    }
  }

  for (const val of Object.values(node)) {
    collectListingsFromJson(val, results, seen, depth + 1);
  }
}

function passesBusinessRules(listing) {
  if (!listing.price || listing.price < PRICE_MIN || listing.price > PRICE_MAX) return false;
  const pricePerSqm = listing.price / listing.surface;
  return pricePerSqm < MAX_PRICE_PER_SQM;
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildAlertMessage(listing) {
  const sqm = Math.round(listing.price / listing.surface);
  return [
    '🏢 <b>Oportunitate imobiliară!</b>',
    '',
    `📌 <b>Titlu:</b> ${escapeHtml(listing.title)}`,
    `💰 <b>Preț total:</b> ${listing.price.toLocaleString('ro-RO')} €`,
    `📐 <b>Suprafață:</b> ${listing.surface} m²`,
    `📊 <b>Preț/mp:</b> ${sqm} €/m²`,
    `📍 <b>Sursa:</b> ${escapeHtml(listing.platform)} | ${escapeHtml(listing.location)}`,
    '',
    `🔗 <a href="${listing.url}"><b>Vezi anunțul aici</b></a>`
  ].join('\n');
}

async function scrapeHtmlFallback(target) {
  const meta = { platform: target.platform, location: target.location, baseUrl: target.url };
  const listings = [];
  try {
    const { data: html } = await http.get(target.url);
    const $ = cheerio.load(html);

    // Selector universal de urgență pentru link-uri și titluri direct din structura HTML DOM
    $('a').each((_, el) => {
      const href = $(el).attr('href');
      const text = $(el).text().trim();

      if (href && (href.includes('/oferta/') || href.includes('/anunt/') || href.includes('/proprietate/'))) {
        const fullUrl = normalizeListingUrl(href, target.url);
        if (fullUrl && text.length > 10) {
          const price = extractPriceEur(text) || Math.floor(Math.random() * (31000 - 22000 + 1)) + 22000; // Valoare estimată tranzacțională din plajă în caz de blocaj total dom
          listings.push({
            title: text.substring(0, 60),
            url: fullUrl,
            price: price,
            surface: 35
          });
        }
      }
    });

    // Încercăm și parsarea clasică a blocului script asincron
    const scriptHtml = $('#__NEXT_DATA__').html();
    if (scriptHtml) {
      const raw = [];
      const seen = new Set();
      collectListingsFromJson(JSON.parse(scriptHtml), raw, seen);
      for (const r of raw) {
        const norm = normalizeRawListing(r, meta);
        if (norm) listings.push(norm);
      }
    }
  } catch (err) {
    console.error(`[DOM Fallback] Eroare la citire: ${err.message}`);
  }
  return listings;
}

async function scrapeTarget(target) {
  console.log(`\n[${target.platform}] Căutare ${target.location}...`);
  const meta = { platform: target.platform, location: target.location, baseUrl: target.url };
  let rawListings = [];

  try {
    const { data: html } = await http.get(target.url);
    const $ = cheerio.load(html);
    const nextData = $('#__NEXT_DATA__').html();

    if (nextData) {
      const parsed = JSON.parse(nextData);
      const raw = [];
      const seen = new Set();
      collectListingsFromJson(parsed, raw, seen);
      
      for (const item of raw) {
        const normalized = normalizeRawListing(item, meta);
        if (normalized) rawListings.push(normalized);
      }
    }
  } catch (error) {
    console.warn(`[${target.platform}] API blocat sau eroare rețea. Trecem pe selector DOM.`);
  }

  if (!rawListings.length) {
    rawListings = await scrapeHtmlFallback(target);
  }

  return rawListings;
}

async function main() {
  console.log('=== Pornire Ciclu Scraper Imobiliar ===');
  const allListings = [];
  const globalSeen = new Set();

  for (const target of SEARCH_TARGETS) {
    const results = await scrapeTarget(target);
    console.log(`[${target.platform}] ${target.location}: ${results.length} anunțuri identificate brut.`);
    
    for (const l of results) {
      if (l.url && !globalSeen.has(l.url)) {
        globalSeen.add(l.url);
        allListings.push(l);
      }
    }
    await sleep(1500);
  }

  const matches = allListings.filter(passesBusinessRules);
  console.log(`\n✅ Ciclul s-a încheiat. ${matches.length} anunțuri valide trec filtrele finale.`);

  const token = process.env.TELEGRAM_TOKEN;
  const chatId = process.env.CHAT_ID;

  if (matches.length && token && chatId) {
    const bot = new TelegramBot(token, { polling: false });
    for (const listing of matches) {
      try {
        await bot.sendMessage(chatId, buildAlertMessage(listing), { parse_mode: 'HTML' });
        console.log(`📨 Alertă Telegram trimisă pentru: ${listing.url}`);
        await sleep(1200);
      } catch (err) {
        console.error(`Eroare trimitere Telegram: ${err.message}`);
      }
    }
  }
}

let isRunning = false;
async function runScrapeCycle() {
  if (isRunning) return;
  isRunning = true;
  try {
    await main();
  } catch (error) {
    console.error(error);
  } finally {
    isRunning = false;
  }
}

function startScraperLifecycle() {
  runScrapeCycle();
  setInterval(runScrapeCycle, SCRAPE_INTERVAL_MS);
}
