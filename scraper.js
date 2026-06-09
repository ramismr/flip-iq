'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const TelegramBot = require('node-telegram-bot-api');

const PRICE_MIN = 20000;
const PRICE_MAX = 32000;
const SCRAPE_INTERVAL_MS = 10 * 60 * 1000;

// Centrul Constanța (Piața Ovidiu)
const CONSTANTA_CENTER = { lat: 44.1733, lng: 28.6383 };
const RADIUS_KM = 40;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const PLATFORM_ORIGIN = {
  OLX: 'https://www.olx.ro',
  Storia: 'https://www.storia.ro',
  'Imobiliare.ro': 'https://www.imobiliare.ro',
};

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

const HTTP_TIMEOUT_MS = 90000;
const HTTP_MAX_RETRIES = 3;
const HTTP_RETRY_BASE_MS = 5000;

const http = axios.create({
  timeout: HTTP_TIMEOUT_MS,
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

function isRetryableHttpError(error) {
  const code = error.code;
  const status = error.response?.status;
  return (
    code === 'ECONNABORTED' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    status === 522 ||
    status === 503 ||
    status === 502 ||
    status === 429
  );
}

async function fetchWithRetry(config, label = 'request') {
  let lastError;

  for (let attempt = 1; attempt <= HTTP_MAX_RETRIES; attempt += 1) {
    try {
      return await http.request(config);
    } catch (error) {
      lastError = error;
      const retryable = isRetryableHttpError(error);
      const status = error.response?.status;
      const detail = status ? `HTTP ${status}` : error.code || error.message;

      if (!retryable || attempt === HTTP_MAX_RETRIES) {
        throw error;
      }

      const delay = HTTP_RETRY_BASE_MS * attempt;
      console.warn(
        `[HTTP] ${label} – ${detail} – reîncerc ${attempt}/${HTTP_MAX_RETRIES} în ${delay / 1000}s...`,
      );
      await sleep(delay);
    }
  }

  throw lastError;
}

function normalizeDiacritics(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function haversineKm(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

const LOCALITY_COORDS = [
  ['mamaia nord', 44.285, 28.61],
  ['mamaia sat', 44.26, 28.615],
  ['mamaia-sat', 44.26, 28.615],
  ['mihail kogalniceanu', 44.348, 28.458],
  ['valu lui traian', 44.192, 28.478],
  ['eforie nord', 44.064, 28.634],
  ['eforie sud', 44.094, 28.631],
  ['palazu mare', 44.215, 28.545],
  ['faleza nord', 44.2, 28.62],
  ['tomis nord', 44.205, 28.64],
  ['tomis plus', 44.21, 28.58],
  ['inel ii', 44.185, 28.62],
  ['inel 2', 44.185, 28.62],
  ['mamaia', 44.245, 28.62],
  ['navodari', 44.208, 28.625],
  ['constanta', 44.173, 28.638],
  ['ovidiu', 44.268, 28.565],
  ['agigea', 44.078, 28.62],
  ['techirghiol', 44.052, 28.598],
  ['lumina', 44.348, 28.568],
  ['corbu', 44.378, 28.478],
  ['costinesti', 43.951, 28.634],
  ['cumpana', 44.105, 28.545],
  ['murfatlar', 44.169, 28.41],
  ['schitu', 43.967, 28.65],
  ['tuzla', 44.0, 28.63],
  ['23 august', 44.215, 28.57],
  ['poarta alba', 44.18, 28.4],
  ['nicolae balcescu', 44.28, 28.48],
  ['ciocarlia', 44.2, 28.5],
  ['castelu', 44.25, 28.48],
]
  .map(([name, lat, lng]) => ({ name, lat, lng, km: haversineKm(CONSTANTA_CENTER, { lat, lng }) }))
  .filter((entry) => entry.km <= RADIUS_KM)
  .sort((a, b) => b.name.length - a.name.length);

function extractLocationText(raw) {
  if (raw.locationLabel) return String(raw.locationLabel).trim();

  const parts = [];

  if (typeof raw.location === 'string') {
    parts.push(raw.location);
  } else if (raw.location && typeof raw.location === 'object') {
    const loc = raw.location;
    if (loc.district?.name) parts.push(loc.district.name);
    if (loc.city?.name) parts.push(loc.city.name);
    if (loc.region?.name) parts.push(loc.region.name);
    if (loc.address?.street?.name) parts.push(loc.address.street.name);
    if (loc.address?.district?.name) parts.push(loc.address.district.name);
    if (loc.address?.city?.name) parts.push(loc.address.city.name);
    if (Array.isArray(loc.reverseGeocoding?.locations)) {
      for (const item of loc.reverseGeocoding.locations) {
        parts.push(item.fullName || item.name);
      }
    }
  }

  if (raw.city) parts.push(typeof raw.city === 'string' ? raw.city : raw.city.name);
  if (raw.district) parts.push(typeof raw.district === 'string' ? raw.district : raw.district.name);
  if (raw.region) parts.push(typeof raw.region === 'string' ? raw.region : raw.region.name);

  if (Array.isArray(raw.params)) {
    for (const param of raw.params) {
      if (['city', 'district', 'region'].includes(param.key)) {
        parts.push(param.value?.label || param.value?.name);
      }
    }
  }

  return parts.filter(Boolean).join(', ');
}

function extractCoordinates(raw) {
  const candidates = [
    raw.lat != null && (raw.lon != null || raw.lng != null)
      ? { lat: +raw.lat, lng: +(raw.lon ?? raw.lng) }
      : null,
    raw.latitude != null && raw.longitude != null
      ? { lat: +raw.latitude, lng: +raw.longitude }
      : null,
    raw.map?.lat != null && raw.map?.lon != null
      ? { lat: +raw.map.lat, lng: +raw.map.lon }
      : null,
    raw.map?.latitude != null && raw.map?.longitude != null
      ? { lat: +raw.map.latitude, lng: +raw.map.longitude }
      : null,
    raw.location?.coordinates?.latitude != null
      ? {
          lat: +raw.location.coordinates.latitude,
          lng: +raw.location.coordinates.longitude,
        }
      : null,
    raw.location?.coordinates?.lat != null
      ? { lat: +raw.location.coordinates.lat, lng: +raw.location.coordinates.lng }
      : null,
    raw.location?.map?.lat != null
      ? { lat: +raw.location.map.lat, lng: +raw.location.map.lon }
      : null,
    raw.geo?.lat != null
      ? { lat: +raw.geo.lat, lng: +(raw.geo.lon ?? raw.geo.lng) }
      : null,
  ].filter(Boolean);

  for (const coords of candidates) {
    if (Number.isFinite(coords.lat) && Number.isFinite(coords.lng)) {
      return coords;
    }
  }

  const text = normalizeDiacritics(
    [extractLocationText(raw), raw.title, raw.description, raw.shortDescription].filter(Boolean).join(' '),
  );

  for (const entry of LOCALITY_COORDS) {
    if (text.includes(normalizeDiacritics(entry.name))) {
      return { lat: entry.lat, lng: entry.lng };
    }
  }

  return null;
}

function enrichListingGeo(listing, raw) {
  const coords = extractCoordinates(raw || listing);
  if (!coords) return listing;

  listing.lat = coords.lat;
  listing.lng = coords.lng;
  listing.distanceKm = Math.round(haversineKm(CONSTANTA_CENTER, coords) * 10) / 10;
  return listing;
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
  const totalPrices = [];

  for (const match of text.matchAll(/([\d\s.,]+)\s*€(?:\s*\/\s*m[²2])?/gi)) {
    const fragment = match[0];
    if (/€\s*\/?\s*m[²2]/i.test(fragment)) continue;

    const price = parseNumber(match[1]);
    if (price && price >= 1000) totalPrices.push(price);
  }

  if (totalPrices.length) {
    const inRange = totalPrices.filter((p) => p >= PRICE_MIN && p <= PRICE_MAX);
    if (inRange.length) return inRange[0];
    return totalPrices.find((p) => p >= PRICE_MIN) || totalPrices[0];
  }

  const ronMatch = text.match(/([\d\s.,]+)\s*(?:RON|lei)\b/i);
  if (ronMatch) {
    const ron = parseNumber(ronMatch[1]);
    if (ron) return Math.round(ron / 5);
  }

  return null;
}

function normalizeListingUrl(url, origin) {
  if (!url) return null;

  const value = String(url).trim();
  if (!value || value === '#' || value === '/') return null;

  try {
    if (value.startsWith('http')) {
      return new URL(value).href.split('?')[0].split('#')[0];
    }
    if (value.startsWith('//')) {
      return new URL(`https:${value}`).href.split('?')[0].split('#')[0];
    }
    if (value.startsWith('/')) {
      return new URL(value, origin).href.split('?')[0].split('#')[0];
    }
    return new URL(value, `${origin}/`).href.split('?')[0].split('#')[0];
  } catch {
    return null;
  }
}

function isValidListingUrl(url, platform) {
  if (!url) return false;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const host = parsed.hostname.replace(/^www\./, '');
  const path = parsed.pathname;

  if (platform === 'OLX') {
    return host === 'olx.ro' && /\/d\/oferta\/.+/i.test(path) && /ID[a-zA-Z0-9]+/i.test(path);
  }

  if (platform === 'Storia') {
    return host === 'storia.ro' && /\/oferta\/.+/i.test(path);
  }

  if (platform === 'Imobiliare.ro') {
    return host === 'imobiliare.ro' && (
      /\/oferta\/.+/i.test(path) ||
      /\/vanzare-(apartamente|garsoniere|case)\/.+/i.test(path) ||
      /\/proprietate\/.+/i.test(path)
    );
  }

  return false;
}

function resolveListingUrl(raw, meta) {
  const origin = PLATFORM_ORIGIN[meta.platform] || meta.baseUrl;
  const candidates = [
    raw.url,
    raw.link,
    raw.href,
    raw.canonicalUrl,
    raw.absoluteUrl,
    raw.shareUrl,
  ];

  if (raw.slug) {
    const slug = String(raw.slug).trim();
    if (slug.startsWith('http') || slug.startsWith('/')) {
      candidates.push(slug);
    } else if (meta.platform === 'Storia') {
      candidates.push(`/ro/oferta/${slug}`);
    } else if (meta.platform === 'OLX') {
      candidates.push(`/d/oferta/${slug}`);
    }
  }

  if (raw.id && meta.platform === 'OLX') {
    const slugPart = raw.slug ? String(raw.slug).replace(/^\/d\/oferta\//, '') : '';
    if (slugPart && !/ID[a-zA-Z0-9]+/i.test(slugPart)) {
      candidates.push(`/d/oferta/${slugPart}-ID${raw.id}.html`);
    } else if (!slugPart) {
      candidates.push(`/d/oferta/-ID${raw.id}.html`);
    }
  }

  for (const candidate of candidates) {
    const normalized = normalizeListingUrl(candidate, origin);
    if (isValidListingUrl(normalized, meta.platform)) {
      return normalized;
    }
  }

  return null;
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

function isListingCandidate(obj, platform) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;

  const title = obj.title || obj.name || obj.adTitle || obj.heading;
  const price =
    extractPriceFromObject(obj.totalPrice) ||
    extractPriceFromObject(obj.price) ||
    extractPriceFromObject(obj.priceValue) ||
    extractPriceFromObject(obj.priceAmount);

  const url = resolveListingUrl(obj, { platform, baseUrl: PLATFORM_ORIGIN[platform] });

  return Boolean(title && url && price);
}

function normalizeRawListing(raw, meta) {
  const title = String(raw.title || raw.name || raw.adTitle || raw.heading || '').trim();
  const url = resolveListingUrl(raw, meta);

  let price =
    extractPriceFromObject(raw.totalPrice) ||
    extractPriceFromObject(raw.price) ||
    extractPriceFromObject(raw.priceValue) ||
    extractPriceFromObject(raw.priceAmount);

  let surface =
    extractSurfaceFromObject(raw.areaInSquareMeters) ||
    extractSurfaceFromObject(raw.usableArea) ||
    extractSurfaceFromObject(raw.livingArea) ||
    extractSurfaceFromObject(raw.area) ||
    extractSurfaceFromObject(raw.surface) ||
    extractSurfaceFromObject(raw.size) ||
    extractSurfaceFromObject(raw.areas?.[0]);

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

  const locationLabel = extractLocationText(raw) || meta.location;

  return enrichListingGeo(
    {
      platform: meta.platform,
      location: locationLabel,
      locationLabel,
      title,
      url,
      price,
      surface,
    },
    raw,
  );
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

function collectListingsFromJson(node, results, seen, platform, depth = 0) {
  if (!node || depth > 16) return;

  if (Array.isArray(node)) {
    for (const item of node) collectListingsFromJson(item, results, seen, platform, depth + 1);
    return;
  }

  if (typeof node !== 'object') return;

  if (isListingCandidate(node, platform)) {
    const resolvedUrl = resolveListingUrl(node, { platform, baseUrl: PLATFORM_ORIGIN[platform] });
    if (!seen.has(resolvedUrl)) {
      seen.add(resolvedUrl);
      results.push(node);
    }
  }

  for (const value of Object.values(node)) {
    collectListingsFromJson(value, results, seen, platform, depth + 1);
  }
}

function addListing(listings, seen, listing) {
  if (!listing || !isValidListingUrl(listing.url, listing.platform)) return false;
  if (seen.has(listing.url)) return false;
  seen.add(listing.url);
  listings.push(listing);
  return true;
}

function passesBusinessRules(listing) {
  if (listing.price < PRICE_MIN || listing.price > PRICE_MAX) return false;
  if (listing.distanceKm == null) return false;
  return listing.distanceKm <= RADIUS_KM;
}

function escapeTelegramHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtmlAttr(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
}

function formatPrice(num) {
  return new Intl.NumberFormat('ro-RO', { maximumFractionDigits: 0 }).format(num);
}

function buildAlertMessage(listing) {
  const lines = [
    '🏠 <b>Oportunitate imobiliară!</b>',
    '',
    `📌 <b>Titlu:</b> ${escapeTelegramHtml(listing.title)}`,
    `💰 <b>Preț total:</b> ${formatPrice(listing.price)} €`,
  ];

  if (listing.surface && listing.surface > 0) {
    const pricePerSqm = listing.price / listing.surface;
    lines.push(`📐 <b>Suprafață:</b> ${formatPrice(listing.surface)} m²`);
    lines.push(`📊 <b>Preț/mp:</b> ${formatPrice(Math.round(pricePerSqm))} €/m²`);
  }

  lines.push(
    '',
    `🔗 <a href="${escapeHtmlAttr(listing.url)}">Vezi anunțul</a>`,
    '',
    `📍 ${escapeTelegramHtml(listing.location)} · ${listing.distanceKm} km de centru`,
    `🌐 ${escapeTelegramHtml(listing.platform)}`,
  );

  return lines.join('\n');
}

async function fetchHtml(url) {
  const response = await fetchWithRetry(
    {
      method: 'get',
      url,
      headers: {
        Referer: new URL(url).origin,
      },
    },
    `HTML ${new URL(url).hostname}`,
  );
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
            if (normalized && isValidListingUrl(normalized.url, meta.platform)) {
              listings.push(normalized);
            }
          }
        }
      }
    } catch {
      // ignore malformed JSON-LD blocks
    }
  });

  return listings;
}

async function resolveOlxApiParams(searchUrl) {
  const parsed = new URL(searchUrl);
  const pathKey = parsed.pathname.replace(/^\/|\/$/g, '').replace(/\//g, ',');

  try {
    const response = await fetchWithRetry(
      {
        method: 'get',
        url: `https://www.olx.ro/api/v1/friendly-links/query-params/${pathKey}/`,
        params: Object.fromEntries(parsed.searchParams),
        headers: { Referer: searchUrl },
      },
      'OLX friendly-links',
    );
    return response.data?.data || null;
  } catch (error) {
    console.warn(`[OLX] Nu s-au putut rezolva parametrii API: ${error.message}`);
    return null;
  }
}

async function scrapeOlx(target) {
  const meta = { platform: target.platform, location: target.location, baseUrl: target.url };
  const listings = [];
  const seen = new Set();

  const apiParams = await resolveOlxApiParams(target.url);
  const params = {
    offset: 0,
    limit: 50,
    sort_by: 'created_at:desc',
    ...(apiParams || {}),
  };

  for (let page = 0; page < 3; page += 1) {
    params.offset = page * params.limit;

    try {
      const response = await fetchWithRetry(
        {
          method: 'get',
          url: 'https://www.olx.ro/api/v1/offers/',
          params,
          headers: { Referer: target.url },
        },
        `OLX offers p${page + 1}`,
      );

      const offers = response.data?.data || [];
      if (!offers.length) break;

      for (const offer of offers) {
        const normalized = normalizeRawListing(
          {
            id: offer.id,
            slug: offer.slug,
            title: offer.title,
            url: offer.url,
            link: offer.link,
            price: OLX_PARAMS_PRICE(offer.params) || offer.promotion?.price,
            params: offer.params,
            description: offer.description,
            location: offer.location,
            map: offer.map,
          },
          meta,
        );

        addListing(listings, seen, normalized);
      }

      if (offers.length < params.limit) break;
      await sleep(400);
    } catch (error) {
      console.warn(`[OLX] Eroare la pagina ${page + 1}: ${error.message}`);
      break;
    }
  }

  if (listings.length) return listings;

  const html = await fetchHtml(target.url);
  const $ = cheerio.load(html);

  $('a[href*="/d/oferta/"]').each((_, el) => {
    const href = $(el).attr('href');
    const card = $(el).closest('[data-cy="l-card"], article, li, div').first();
    const cardText = card.text() || $(el).text();
    const title = $(el).attr('title') || $(el).find('h4, h6, strong').first().text().trim() || $(el).text().trim();

    addListing(
      listings,
      seen,
      normalizeRawListing(
        {
          title,
          url: href,
          price: extractPriceEur(cardText),
          surface: extractSurfaceFromText(cardText, title),
          description: cardText,
          locationLabel: cardText,
        },
        meta,
      ),
    );
  });

  const nextData = parseNextData(html);
  const raw = [];
  const jsonSeen = new Set();
  if (nextData) collectListingsFromJson(nextData, raw, jsonSeen, 'OLX');

  for (const item of raw) {
    addListing(listings, seen, normalizeRawListing(item, meta));
  }

  return listings;
}

async function scrapeStoria(target) {
  const meta = { platform: target.platform, location: target.location, baseUrl: target.url };
  const listings = [];
  const seen = new Set();

  const html = await fetchHtml(target.url);
  const $ = cheerio.load(html);

  $('a[href*="/oferta/"]').each((_, el) => {
    const href = $(el).attr('href');
    const card = $(el).closest('article, li, [data-sentry-component], div').first();
    const cardText = card.text() || $(el).text();
    const title =
      $(el).attr('title') ||
      $(el).find('h2, h3, p').first().text().trim() ||
      $(el).text().trim();

    if (!title || title.length < 5) return;

    addListing(
      listings,
      seen,
      normalizeRawListing(
        {
          title,
          url: href,
          price: extractPriceEur(cardText),
          surface: extractSurfaceFromText(cardText, title),
          description: cardText,
          locationLabel: cardText,
        },
        meta,
      ),
    );
  });

  const nextData = parseNextData(html);
  const raw = [];
  const jsonSeen = new Set();

  if (nextData) collectListingsFromJson(nextData, raw, jsonSeen, 'Storia');

  for (const item of raw) {
    addListing(
      listings,
      seen,
      normalizeRawListing(
        {
          ...item,
          url: item.href || item.url || item.link,
          surface: item.areaInSquareMeters || item.area,
          location: item.location,
        },
        meta,
      ),
    );
  }

  return listings;
}

async function scrapeImobiliare(target) {
  const meta = { platform: target.platform, location: target.location, baseUrl: target.url };
  const listings = [];
  const seen = new Set();

  const html = await fetchHtml(target.url);
  const jsonLdListings = parseJsonLdListings(html, meta);

  for (const listing of jsonLdListings) {
    addListing(listings, seen, listing);
  }

  const $ = cheerio.load(html);

  $('a[href*="imobiliare.ro"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (!/\/oferta\/|\/vanzare-(apartamente|garsoniere)\/|\/proprietate\//i.test(href)) return;

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
        locationLabel: cardText,
      },
      meta,
    );

    addListing(listings, seen, normalized);
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

    addListing(listings, seen, normalized);
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
    parse_mode: 'HTML',
    disable_web_page_preview: false,
  });
}

async function main() {
  console.log('=== FlipIQ Scraper Imobiliar ===');
  console.log(`Filtru preț: ${PRICE_MIN} – ${PRICE_MAX} €`);
  console.log(`Filtru rază: ${RADIUS_KM} km de centrul Constanței\n`);

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

    await sleep(1500);
  }

  const inPriceRange = allListings.filter(
    (l) => l.price >= PRICE_MIN && l.price <= PRICE_MAX,
  );
  const matches = inPriceRange.filter(passesBusinessRules);
  const outOfRadius = inPriceRange.filter((l) => l.distanceKm == null || l.distanceKm > RADIUS_KM);

  console.log(`\n✅ ${matches.length} anunțuri în preț și rază (${RADIUS_KM} km).`);
  if (outOfRadius.length) {
    console.log(`⚠️ ${outOfRadius.length} anunțuri în preț, dar în afara razei de ${RADIUS_KM} km.`);
  }

  for (const listing of matches) {
    const surfaceInfo =
      listing.surface && listing.surface > 0
        ? ` / ${listing.surface} m² (${Math.round(listing.price / listing.surface)} €/m²)`
        : '';
    console.log(
      `  • [${listing.platform}] ${listing.title.slice(0, 60)} – ${listing.price} €${surfaceInfo} · ${listing.distanceKm} km`,
    );
    console.log(`    ${listing.location} | ${listing.url}`);
  }

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
        await sleep(500);
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

