'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const TelegramBot = require('node-telegram-bot-api');

const PRICE_MIN = 20000;
const PRICE_MAX = 32000;
const MAX_PRICE_PER_SQM = 950;
const SCRAPE_INTERVAL_MS = 10 * 60 * 1000;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const SEARCH_TARGETS = [
  {
    platform: 'OLX',
    location: 'Constanța',
    url:
      'https://www.olx.ro/imobiliare/apartamente-garsoniere-de-vanzare/constanta/?search%5Bfilter_float_price:from%5D=20000&search%5Bfilter_float_price:to%5D=32000&search%5Bfilter_enum_currency%5D=eur',
  },
  {
    platform: 'OLX',
    location: 'Năvodari',
    url:
      'https://www.olx.ro/imobiliare/apartamente-garsoniere-de-vanzare/navodari-jud-constanta/?search%5Bfilter_float_price:from%5D=20000&search%5Bfilter_float_price:to%5D=32000&search%5Bfilter_enum_currency%5D=eur',
  },
  {
    platform: 'Storia',
    location: 'Constanța',
    url:
      'https://www.storia.ro/ro/rezultate/vanzare/apartament/constanta?priceMin=20000&priceMax=32000&currency=EUR',
  },
  {
    platform: 'Storia',
    location: 'Năvodari',
    url:
      'https://www.storia.ro/ro/rezultate/vanzare/apartament/constanta/navodari?priceMin=20000&priceMax=32000&currency=EUR',
  },
  {
    platform: 'Imobiliare.ro',
    location: 'Constanța',
    url:
      'https://www.imobiliare.ro/vanzare-apartamente/constanta?pret-min=20000&pret-max=32000&moneda=EUR',
  },
  {
    platform: 'Imobiliare.ro',
    location: 'Năvodari',
    url:
      'https://www.imobiliare.ro/vanzare-apartamente/navodari-constanta?pret-min=20000&pret-max=32000&moneda=EUR',
  },
];

const http = axios.create({
  timeout: 30000,
  headers: {
    'User-Agent': USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'ro-RO,ro;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
  },
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
    /suprafa(?:ț|t)ă[^0-9]{0,20}(\d+(?:[.,]\d+)?)/gi,
    /suprafata[^0-9]{0,20}(\d+(?:[.,]\d+)?)/gi,
    /(\d+(?:[.,]\d+)?)\s*metri\s*p[ăa]tra/gi,
  ];

  for (const pattern of patterns) {
    const matches = [...text.matchAll(pattern)];
    for (const match of matches) {
      const area = parseNumber(match[1]);
      if (area && area >= 8 && area <= 500) return area;
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

  const ronMatch = text.match(/([\d\s.,]+)\s*(?:RON|lei)\b/i);
  if (ronMatch) {
    const ron = parseNumber(ronMatch[1]);
    if (ron) return Math.round(ron / 5);
  }

  return null;
}

function normalizeListingUrl(url, baseUrl) {
  if (!url) return null;
  if (url.startsWith('http')) return url.split('?')[0];
  if (url.startsWith('//')) return `https:${url.split('?')[0]}`;
  if (url.startsWith('/')) return new URL(url, baseUrl).href.split('?')[0];
  return new URL(url, baseUrl).href.split('?')[0];
}

function extractPriceFromObject(obj) {
  if (!obj) return null;

  if (typeof obj === 'number') return obj;
  if (typeof obj === 'string') return extractPriceEur(obj);

  if (obj.value != null) {
    const currency = String(obj.currency || obj.code || 'EUR').toUpperCase();
    const value = parseNumber(obj.value);
    if (!value) return null;
    if (currency === 'EUR' || currency === '€') return value;
    if (currency === 'RON' || currency === 'LEI') return Math.round(value / 5);
    return value;
  }

  if (obj.amount != null) return extractPriceFromObject(obj.amount);
  if (obj.price != null && obj !== obj.price) return extractPriceFromObject(obj.price);

  return parseNumber(obj);
}

function extractSurfaceFromObject(obj) {
  if (!obj) return null;
  if (typeof obj === 'number') return obj;
  if (typeof obj === 'string') return extractSurfaceFromText(obj);

  const keys = [
    'area',
    'surface',
    'size',
    'usableArea',
    'areaInSquareMeters',
    'livingArea',
    'totalArea',
    'value',
  ];

  for (const key of keys) {
    if (obj[key] != null) {
      const val = parseNumber(obj[key]);
      if (val && val >= 8 && val <= 500) return val;
    }
  }

  return null;
}

function isListingCandidate(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;

  const title = obj.title || obj.name || obj.adTitle || obj.heading;
  const url = obj.url || obj.link || obj.href || obj.slug || obj.path;
  const price =
    extractPriceFromObject(obj.totalPrice) ||
    extractPriceFromObject(obj.price) ||
    extractPriceFromObject(obj.priceValue) ||
    extractPriceFromObject(obj.priceAmount);

  return Boolean(title && (url || obj.id) && price);
}

function normalizeRawListing(raw, meta) {
  const title = String(raw.title || raw.name || raw.adTitle || raw.heading || '').trim();
  const url = normalizeListingUrl(
    raw.url || raw.link || raw.href || raw.slug || raw.path,
    meta.baseUrl,
  );

  let price =
    extractPriceFromObject(raw.totalPrice) ||
    extractPriceFromObject(raw.price) ||
    extractPriceFromObject(raw.priceValue) ||
    extractPriceFromObject(raw.priceAmount);

  let surface =
    extractSurfaceFromObject(raw.area) ||
    extractSurfaceFromObject(raw.surface) ||
    extractSurfaceFromObject(raw.usableArea) ||
    extractSurfaceFromObject(raw.areaInSquareMeters) ||
    extractSurfaceFromObject(raw.livingArea) ||
    extractSurfaceFromObject(raw.size);

  if (!surface) {
    surface = extractSurfaceFromText(title, raw.description, raw.shortDescription);
  }

  if (OLX_PARAMS_SURFACE(raw.params)) {
    surface = surface || OLX_PARAMS_SURFACE(raw.params);
  }

  if (!price) {
    price = extractPriceEur(title, raw.description, raw.shortDescription);
  }

  if (!url || !title || !price) return null;

  return {
    platform: meta.platform,
    location: meta.location,
    title,
    url,
    price,
    surface,
  };
}

function OLX_PARAMS_SURFACE(params) {
  if (!Array.isArray(params)) return null;

  for (const param of params) {
    const key = String(param.key || '').toLowerCase();
    if (['surface', 'm', 'area', 'suprafata', 'suprafata_utila'].includes(key)) {
      const val = parseNumber(param.value?.value ?? param.value?.label ?? param.value);
      if (val && val >= 8 && val <= 500) return val;
    }
  }

  return null;
}

function OLX_PARAMS_PRICE(params) {
  if (!Array.isArray(params)) return null;

  for (const param of params) {
    if (param.key === 'price' && param.value) {
      const currency = String(param.value.currency || 'EUR').toUpperCase();
      const value = parseNumber(param.value.value ?? param.value.label);
      if (!value) continue;
      if (currency === 'EUR' || currency === '€') return value;
      if (currency === 'RON' || currency === 'LEI') return Math.round(value / 5);
      return value;
    }
  }

  return null;
}

function collectListingsFromJson(node, results, seen, depth = 0) {
  if (!node || depth > 14) return;

  if (Array.isArray(node)) {
    for (const item of node) collectListingsFromJson(item, results, seen, depth + 1);
    return;
  }

  if (typeof node !== 'object') return;

  if (isListingCandidate(node)) {
    const key = JSON.stringify([
      node.id,
      node.url || node.slug || node.title,
      node.price || node.totalPrice,
    ]);
    if (!seen.has(key)) {
      seen.add(key);
      results.push(node);
    }
  }

  for (const value of Object.values(node)) {
    collectListingsFromJson(value, results, seen, depth + 1);
  }
}

function passesBusinessRules(listing) {
  if (!listing.price || listing.price < PRICE_MIN || listing.price > PRICE_MAX) return false;
  if (!listing.surface || listing.surface <= 0) return false;

  const pricePerSqm = listing.price / listing.surface;
  return pricePerSqm < MAX_PRICE_PER_SQM;
}

function escapeTelegramMarkdown(text) {
  return String(text).replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

function escapeTelegramUrl(url) {
  // Escapează TOATE caracterele speciale din URL cerute de MarkdownV2, inclusiv parantezele pătrate specifice Storia
  return String(url).replace(/([_ *[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

function formatPrice(num) {
  return new Intl.NumberFormat('ro-RO', { maximumFractionDigits: 0 }).format(num);
}

function buildAlertMessage(listing) {
  const pricePerSqm = listing.price / listing.surface;

  return [
    '🏠 *Oportunitate imobiliară\\!*',
    '',
    `📌 *Titlu:* ${escapeTelegramMarkdown(listing.title)}`,
    `💰 *Preț total:* ${formatPrice(listing.price)} €`,
    `📐 *Suprafață:* ${formatPrice(listing.surface)} m²`,
    `📊 *Preț/mp:* ${formatPrice(Math.round(pricePerSqm))} €/m²`,
    '',
    `🔗 [Vezi anunțul](${escapeTelegramUrl(listing.url)})`,
    '',
    `📍 ${escapeTelegramMarkdown(listing.platform)} \\| ${escapeTelegramMarkdown(listing.location)}`,
  ].join('\n');
}

async function fetchHtml(url) {
  const response = await http.get(url, {
    headers: {
      Referer: new URL(url).origin,
    },
  });
  return response.data;
}

function parseNextData(html) {
  const $ = cheerio.load(html);
  const script = $('#__NEXT_DATA__').html();
  if (!script) return null;

  try {
    return JSON.parse(script);
  } catch {
    return null;
  }
}

function parseJsonLdListings(html, meta) {
  const $ = cheerio.load(html);
  const listings = [];

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html());
      const nodes = Array.isArray(data) ? data : [data];

      for (const node of nodes) {
        if (node['@type'] === 'ItemList' && Array.isArray(node.itemListElement)) {
          for (const item of node.itemListElement) {
            const offer = item.item || item;
            const price = extractPriceFromObject(offer.offers?.price || offer.offers);
            const surface = extractSurfaceFromText(
              offer.description,
              offer.name,
              JSON.stringify(offer),
            );
            const normalized = normalizeRawListing(
              {
                title: offer.name,
                url: offer.url || offer['@id'],
                price,
                surface,
                description: offer.description,
              },
              meta,
            );
            if (normalized) listings.push(normalized);
          }
        }
      }
    } catch {
      // ignore
    }
  });

  return listings;
}

async function resolveOlxApiParams(searchUrl) {
  const parsed = new URL(searchUrl);
  const pathKey = parsed.pathname.replace(/^\/|\/$/g, '').replace(/\//g, ',');

  try {
    const { data } = await http.get(
      `https://www.olx.ro/api/v1/friendly-links/query-params/${pathKey}/`,
      {
        params: Object.fromEntries(parsed.searchParams),
        headers: { Referer: searchUrl },
      },
    );
    return data?.data || null;
  } catch (error) {
    console.warn(`[OLX] Nu s-au putut rezolva parametrii API: ${error.message}`);
    return null;
  }
}

async function scrapeOlx(target) {
  const meta = { platform: target.platform, location: target.location, baseUrl: target.url };
  const listings = [];
  const seen = new Set();

  let useFallback = false;
  const apiParams = await resolveOlxApiParams(target.url);
  
  if (apiParams) {
    const params = {
      offset: 0,
      limit: 50,
      sort_by: 'created_at:desc',
      ...apiParams,
    };

    for (let page = 0; page < 3; page += 1) {
      params.offset = page * params.limit;
      try {
        const { data } = await http.get('https://www.olx.ro/api/v1/offers/', {
          params,
          headers: { Referer: target.url },
        });

        const offers = data?.data || [];
        if (!offers.length) break;

        for (const offer of offers) {
          const normalized = normalizeRawListing(
            {
              id: offer.id,
              title: offer.title,
              url: offer.url,
              price: OLX_PARAMS_PRICE(offer.params) || offer.promotion?.price,
              params: offer.params,
              description: offer.description,
            },
            meta,
          );

          if (normalized && !seen.has(normalized.url)) {
            seen.add(normalized.url);
            listings.push(normalized);
          }
        }

        if (offers.length < params.limit) break;
        await sleep(400);
      } catch (error) {
        console.warn(`[OLX API] Eroare: ${error.message}. Trecem direct la citirea HTML.`);
        useFallback = true;
        break;
      }
    }
  } else {
    useFallback = true;
  }

  if (listings.length && !useFallback) return listings;

  try {
    const html = await fetchHtml(target.url);
    const nextData = parseNextData(html);
    const raw = [];
    const jsonSeen = new Set();
    if (nextData) collectListingsFromJson(nextData, raw, jsonSeen);

    for (const item of raw) {
      const normalized = normalizeRawListing(item, meta);
      if (normalized && !seen.has(normalized.url)) {
        seen.add(normalized.url);
        listings.push(normalized);
      }
    }
  } catch (err) {
    console.error(`[OLX HTML Fallback] Eroare la preluarea datelor: ${err.message}`);
  }

  return listings;
}

async function scrapeStoria(target) {
  const meta = { platform: target.platform, location: target.location, baseUrl: target.url };
  const listings = [];
  const seen = new Set();

  try {
    const html = await fetchHtml(target.url);
    const nextData = parseNextData(html);
    const raw = [];
    const jsonSeen = new Set();

    if (nextData) collectListingsFromJson(nextData, raw, jsonSeen);

    for (const item of raw) {
      const normalized = normalizeRawListing(item, meta);
      if (normalized && !seen.has(normalized.url)) {
        seen.add(normalized.url);
        listings.push(normalized);
      }
    }

    if (listings.length) return listings;

    const $ = cheerio.load(html);
    $('a[href*="/oferta/"], a[href*="/ro/oferta/"]').each((_, el) => {
      const href = $(el).attr('href');
      const card = $(el).closest('article, li, div').first();
      const cardText = card.text() || $(el).text();
      const title = $(el).attr('title') || $(el).text().trim();

      const normalized = normalizeRawListing(
        {
          title,
          url: href,
          price: extractPriceEur(cardText),
          surface: extractSurfaceFromText(cardText, title),
          description: cardText,
        },
        meta,
      );

      if (normalized && !seen.has(normalized.url)) {
        seen.add(normalized.url);
        listings.push(normalized);
      }
    });
  } catch (err) {
    console.error(`[Storia] Eroare la scanare: ${err.message}`);
  }

  return listings;
}

async function scrapeImobiliare(target) {
  const meta = { platform: target.platform, location: target.location, baseUrl: target.url };
  const listings = [];
  const seen = new Set();

  try {
    const html = await fetchHtml(target.url);
    const jsonLdListings = parseJsonLdListings(html, meta);

    for (const listing of jsonLdListings) {
      if (!seen.has(listing.url)) {
        seen.add(listing.url);
        listings.push(listing);
      }
    }

    const $ = cheerio.load(html);
    $('a[href*="imobiliare.ro"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (!/\/vanzare-|\/oferta\/|\/proprietate\//i.test(href)) return;

      const card = $(el).closest('article, [class*="card"], [class*="listing"], li, div').first();
      const cardText = card.text() || '';
      const title =
        $(el).find('h2, h3, [class*="title"]').first().text().trim() ||
        $(el).attr('title') ||
        $(el).text().trim();

      if (!title || title.length < 8) return;

      const normalized = normalizeRawListing(
        {
          title,
          url: href,
          price: extractPriceEur(cardText, title),
          surface: extractSurfaceFromText(cardText, title),
          description: cardText,
        },
        meta,
      );

      if (normalized && !seen.has(normalized.url)) {
        seen.add(normalized.url);
        listings.push(normalized);
      }
    });

    const blockPattern =
      /href="(https?:\/\/www\.imobiliare\.ro\/[^"]+)"[^>]*>[\s\S]{0,2500}?([\d\s.,]+)\s*€[\s\S]{0,800}?(\d+(?:[.,]\d+)?)\s*mp/gi;

    let match;
    while ((match = blockPattern.exec(html)) !== null) {
      const normalized = normalizeRawListing(
        {
          title: match[1].split('/').pop().replace(/-/g, ' '),
          url: match[1],
          price: parseNumber(match[2]),
          surface: parseNumber(match[3]),
        },
        meta,
      );

      if (normalized && !seen.has(normalized.url)) {
        seen.add(normalized.url);
        listings.push(normalized);
      }
    }
  } catch (err) {
    console.error(`[Imobiliare] Eroare la scanare: ${err.message}`);
  }

  return listings;
}

async function scrapeTarget(target) {
  console.log(`\n[${target.platform}] Căutare ${target.location}...`);
  if (target.platform === 'OLX') return scrapeOlx(target);
  if (target.platform === 'Storia') return scrapeStoria(target);
  return scrapeImobiliare(target);
}

async function sendTelegramAlert(bot, chatId, listing) {
  await bot.sendMessage(chatId, buildAlertMessage(listing), {
    parse_mode: 'MarkdownV2',
    disable_web_page_preview: false,
  });
}

async function main() {
  console.log('=== FlipIQ Scraper Imobiliar ===');
  console.log(`Filtru preț: ${PRICE_MIN} – ${PRICE_MAX} €`);
  console.log(`Filtru randament: sub ${MAX_PRICE_PER_SQM} €/m²\n`);

  const allListings = [];
  const globalSeen = new Set();

  for (const target of SEARCH_TARGETS) {
    try {
      const results = await scrapeTarget(target);
      console.log(`[${target.platform}] ${target.location}: ${results.length} anunțuri găsite`);

      for (const listing of results) {
        const key = listing.url;
        if (!globalSeen.has(key)) {
          globalSeen.add(key);
          allListings.push(listing);
        }
      }
    } catch (error) {
      console.error(`[${target.platform}] ${target.location} – eroare: ${error.message}`);
    }
    await sleep(1000);
  }

  const matches = allListings.filter(passesBusinessRules);
  console.log(`\n✅ ${matches.length} anunțuri trec filtrele de business.`);

  const token = process.env.TELEGRAM_TOKEN;
  const chatId = process.env.CHAT_ID;

  if (!token || !chatId) {
    console.warn('\n⚠️ TELEGRAM_TOKEN sau CHAT_ID lipsesc – notificările sunt dezactivate.');
  } else if (matches.length) {
    const bot = new TelegramBot(token, { polling: false });

    for (const listing of matches) {
      try {
        await sendTelegramAlert(bot, chatId, listing);
        console.log(`📨 Alertă trimisă: ${listing.url}`);
        await sleep(1000);
      } catch (error) {
        console.error(`Eroare Telegram pentru ${listing.url}: ${error.message}`);
      }
    }
  } else {
    console.log('\nNicio oportunitate nouă – nu se trimit alerte.');
  }

  console.log('\n=== Ciclu scraper finalizat ===');
}

let isRunning = false;

async function runScrapeCycle() {
  if (isRunning) {
    console.log('Ciclu anterior încă în desfășurare – sărim această rulare.');
    return;
  }

  isRunning = true;
  try {
    await main();
  } catch (error) {
    console.error('Eroare în ciclu scraper:', error.message);
  } finally {
    isRunning = false;
  }
}

console.log(`FlipIQ Scraper pornit – rulare la fiecare ${SCRAPE_INTERVAL_MS / 60000} minute.`);
runScrapeCycle();
setInterval(runScrapeCycle, SCRAPE_INTERVAL_MS);
