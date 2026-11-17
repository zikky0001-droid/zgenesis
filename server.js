// ============================================
// 🔥 THE GENESIS - ANIME DOWNLOADER
// 📚 SERVER.JS - COMPLETE BACKEND
// 👨‍💻 By Dev Zikky Tech
// ============================================

// ============================================
// 1. 📦 IMPORTS & DEPENDENCIES
// ============================================

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const compression = require('compression');
const helmet = require('helmet');
const cors = require('cors');
const archiver = require('archiver');

// ============================================
// 1.5 🔐 ENV LOADING (local .env support)
// ============================================
// On Render, env vars are injected by the platform - nothing to do.
// Locally, a .env file is loaded if present. Real env vars always win.
(function loadDotEnv() {
    try {
        const envFile = path.join(__dirname, '.env');
        if (!fs.existsSync(envFile)) return;
        if (typeof process.loadEnvFile === 'function') {
            process.loadEnvFile(envFile);          // Node 20.12+ / 21.7+
        } else {
            require('dotenv').config({ path: envFile }); // optional fallback
        }
    } catch (e) {
        // .env is optional - never crash because of it
    }
})();

const app = express();
// Render terminates TLS/proxies requests before they reach Express. Trust one
// proxy hop so req.ip resolves to the visitor rather than Render's proxy IP.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 10000;

// ============================================
// 2. ⚙️ GLOBAL CONFIGURATION & CONSTANTS
// ============================================

// ----- ENV PARSING HELPERS -----
// Tolerant on purpose: handles stray quotes, spaces, brackets and newlines
// so a slightly messy value on Render can never take the site down.

function cleanEnv(name) {
    const raw = process.env[name];
    if (raw === undefined || raw === null) return '';
    return String(raw).trim().replace(/^["'`]+|["'`]+$/g, '').trim();
}

function envUrl(name, fallback, { trailingSlash = false } = {}) {
    let value = cleanEnv(name);
    let source = 'env';

    if (!value) {
        value = fallback;
        source = 'default';
    } else {
        try {
            const u = new URL(value);
            if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('not http(s)');
        } catch (e) {
            console.warn(`⚠️ ${name} is invalid ("${value}") - using default`);
            value = fallback;
            source = 'default (invalid env)';
        }
    }

    if (trailingSlash && !value.endsWith('/')) value += '/';
    return { value, source };
}

function envList(name, fallback) {
    const raw = cleanEnv(name);
    if (!raw) return { value: fallback, source: 'default' };

    let items;
    try {
        const parsed = JSON.parse(raw);
        items = Array.isArray(parsed) ? parsed : raw.split(/[,;\s]+/);
    } catch (e) {
        items = raw.split(/[,;\s]+/);
    }

    items = items
        .map(x => String(x)
            .replace(/[\[\]"'`]/g, '')
            .trim()
            .toLowerCase()
            .replace(/^https?:\/\//, '')
            .replace(/\/.*$/, ''))
        .filter(Boolean);

    items = [...new Set(items)];
    if (items.length === 0) {
        console.warn(`⚠️ ${name} is empty/invalid - using default`);
        return { value: fallback, source: 'default (invalid env)' };
    }
    return { value: items, source: 'env' };
}

// "from=to,from2=to2"  ->  [['from','to'], ['from2','to2']]
function envPairs(name, fallback) {
    const raw = cleanEnv(name);
    if (!raw) return { value: fallback, source: 'default' };

    const pairs = raw
        .split(/[,;\s]+/)
        .map(p => p.replace(/["'`]/g, '').split('=').map(x => x.trim().toLowerCase()))
        .filter(p => p.length === 2 && p[0] && p[1]);

    if (pairs.length === 0) {
        console.warn(`⚠️ ${name} is invalid - using default`);
        return { value: fallback, source: 'default (invalid env)' };
    }
    return { value: pairs, source: 'env' };
}

function envBool(name, fallback = false) {
    const v = cleanEnv(name).toLowerCase();
    if (!v) return fallback;
    return ['1', 'true', 'yes', 'on'].includes(v);
}

// ----- URL CONSTANTS (from env, defaults = your original values) -----
const _BASE   = envUrl('BASE_URL',   'https://amp.ccxx.com/',        { trailingSlash: true });
const _SEARCH = envUrl('SEARCH_URL', 'https://amp.ccxx.com/search/', { trailingSlash: true });
const _VIDEO  = envUrl('VIDEO_URL',  'https://www.ccxx.com/video-');
const _API    = envUrl('API_URL',    'https://zgenesis.onrender.com');

const URLS = {
    BASE: _BASE.value,
    SEARCH: _SEARCH.value,
    VIDEO: _VIDEO.value,
    API: _API.value
};

// Origin used to complete relative thumbnail / video links
const BASE_ORIGIN = new URL(URLS.BASE).origin;

// Origin of the real video pages (taken from VIDEO_URL) - related-video links use this
const VIDEO_ORIGIN = new URL(URLS.VIDEO).origin;

// If a link points at another host (e.g. the AMP host), return the same path on the
// VIDEO_URL host so we can retry there. Returns null if already on that host.
function swapToVideoHost(url) {
    try {
        const u = new URL(url);
        const target = new URL(URLS.VIDEO);
        if (u.host === target.host) return null;
        u.protocol = target.protocol;
        u.host = target.host;
        return u.toString();
    } catch (e) {
        return null;
    }
}

// ----- SUPPORTED DOMAINS (from env, comma-separated) -----
const _DOMAINS = envList('SUPPORTED_DOMAINS', [
    'amp.ccxx.com',
    'ccxx.com',
    'cchh.com',
    'thnxx.com',
    'txnhh.com'
]);
const SUPPORTED_DOMAINS = _DOMAINS.value;

// ----- HOST REWRITES (alias domain -> real domain) -----
// Default keeps your original behaviour: txnhh.com -> ccxx.com
const _REWRITES = envPairs('HOST_REWRITES', [['txnhh.com', 'ccxx.com']]);
const HOST_REWRITES = _REWRITES.value;

// ----- OPTIONAL STRICT DOMAIN CHECK (off by default) -----
// When true, /api/video/by-url only accepts hosts from SUPPORTED_DOMAINS
const ENFORCE_DOMAIN_CHECK = envBool('ENFORCE_DOMAIN_CHECK', false);

function isSupportedHost(url) {
    try {
        const host = new URL(url).hostname.toLowerCase();
        return SUPPORTED_DOMAINS.some(d => host === d || host.endsWith('.' + d));
    } catch (e) {
        return false;
    }
}

// ----- DEBUG MODE (verbose video logs; set DEBUG_MODE=false to silence) -----
const DEBUG_MODE = envBool('DEBUG_MODE', false);

function debugLog(...args) {
    if (DEBUG_MODE) {
        console.log('[VIDEO-DEBUG]', new Date().toISOString(), ...args);
    }
}

// Safe one-line description of a signed media URL (hides the token, shows expiry)
function describeMediaUrl(u) {
    if (!u || u === '#') return '(none)';
    try {
        const x = new URL(u);
        let exp = '';
        const m = String(u).match(/(?:,|%2C)(\d{9,11})(?:&|$)/i);
        if (m) {
            const mins = Math.round((Number(m[1]) * 1000 - Date.now()) / 60000);
            exp = mins > 0 ? ` | token valid ~${mins} min` : ` | token EXPIRED ${-mins} min ago`;
        }
        return `${x.origin}${x.pathname}${x.search ? ` ?...(${x.search.length} chars)` : ''}${exp}`;
    } catch (e) {
        return String(u).slice(0, 120);
    }
}

// ----- CACHE CONSTANTS -----
const CACHE = {
    TTL: 1 * 60 * 1000,           // 1 minute in milliseconds
    CLEANUP_INTERVAL: 1 * 60 * 1000 // Clean expired every 1 minute
};

// ----- TIMEOUT CONSTANTS -----
const TIMEOUTS = {
    REQUEST: 30000,    // 30 seconds
    SCRAPE: 30000,     // 30 seconds
    DOWNLOAD: 60000    // 60 seconds
};

// ----- LIMIT CONSTANTS -----
const LIMITS = {
    MAX_VIDEOS: 30,
    MAX_FILE_SIZE: 200 * 1024 * 1024, // 200MB
    MAX_PAGES: 10
};

// ----- REQUEST HEADERS -----
const HEADERS = {
    USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ACCEPT: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    ACCEPT_LANGUAGE: 'en-US,en;q=0.9',
    ACCEPT_ENCODING: 'gzip, deflate, br'
};

// Video pages/streams use REAL header names (HEADERS above has underscore keys
// that axios does not send as User-Agent/Accept). Home & search keep HEADERS as-is.
const VIDEO_HEADERS = {
    'User-Agent': HEADERS.USER_AGENT,
    'Accept': HEADERS.ACCEPT,
    'Accept-Language': HEADERS.ACCEPT_LANGUAGE
};

// ----- FILE PATHS -----
const PATHS = {
    TEMP: path.join(__dirname, 'temp'),
    CACHE: path.join(__dirname, 'temp/cache'),
    DOWNLOADS: path.join(__dirname, 'temp/downloads'),
    LOGS: path.join(__dirname, 'logs')
};

// ----- MIME TYPES -----
const MIME_TYPES = {
    HTML: 'text/html',
    JSON: 'application/json',
    ZIP: 'application/zip',
    VIDEO_MP4: 'video/mp4',
    IMAGE_JPEG: 'image/jpeg',
    IMAGE_PNG: 'image/png'
};

// ============================================
// 3. 🧰 UTILITY FUNCTIONS (HELPERS)
// ============================================

// ----- DECODING FUNCTIONS -----

function decodeUnicode(text) {
    if (!text) return text;
    try {
        return text.replace(/\\u([0-9a-fA-F]{4})/g, (match, hex) => {
            return String.fromCharCode(parseInt(hex, 16));
        });
    } catch (e) {
        return text;
    }
}

function decodeHtmlEntities(text) {
    if (!text) return text;
    
    const entities = {
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&quot;': '"',
        '&#039;': "'",
        '&apos;': "'",
        '&nbsp;': ' ',
        '&colon;': ':',
        '&period;': '.',
        '&comma;': ',',
        '&semi;': ';',
        '&excl;': '!',
        '&quest;': '?',
        '&lpar;': '(',
        '&rpar;': ')',
        '&ndash;': '–',
        '&mdash;': '—',
        '&lsquo;': "'",
        '&rsquo;': "'",
        '&ldquo;': '"',
        '&rdquo;': '"',
        '&ntilde;': 'ñ',
        '&Ntilde;': 'Ñ',
        '&aacute;': 'á',
        '&eacute;': 'é',
        '&iacute;': 'í',
        '&oacute;': 'ó',
        '&uacute;': 'ú',
        '&Aacute;': 'Á',
        '&Eacute;': 'É',
        '&Iacute;': 'Í',
        '&Oacute;': 'Ó',
        '&Uacute;': 'Ú',
        '&agrave;': 'à',
        '&egrave;': 'è',
        '&igrave;': 'ì',
        '&ograve;': 'ò',
        '&ugrave;': 'ù',
        '&ccedil;': 'ç',
        '&Ccedil;': 'Ç',
        '&szlig;': 'ß'
    };
    
    return text.replace(/&[a-zA-Z]+;/g, (match) => {
        return entities[match] || match;
    });
}

function decodeText(text) {
    if (!text) return text;
    return decodeHtmlEntities(decodeUnicode(text));
}

// ----- FORMATTING FUNCTIONS -----

function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatDuration(duration) {
    if (!duration || duration === 'N/A') return '00:00';
    
    // Remove "00h " if present
    let formatted = duration.replace(/^00h\s*/, '');
    formatted = formatted.replace(/^00 hour,?\s*/i, '');
    formatted = formatted.replace(/^0+(\d+)/, '$1');
    formatted = formatted.trim();
    
    // Handle "X minutes, Y seconds" format
    if (formatted.includes('minute') || formatted.includes('second')) {
        formatted = formatted
            .replace(/minutes?/g, 'mins')
            .replace(/seconds?/g, 'secs')
            .replace(/hours?/g, 'hrs');
    }
    
    // Handle "X min Y s" format
    if (formatted.match(/(\d+)\s*min\s*(\d+)\s*s/)) {
        formatted = formatted.replace(/(\d+)\s*min\s*(\d+)\s*s/, '$1 mins, $2 secs');
    }
    
    // Handle "Xmin Ys" format
    if (formatted.match(/(\d+)min\s*(\d+)s/)) {
        formatted = formatted.replace(/(\d+)min\s*(\d+)s/, '$1 mins, $2 secs');
    }
    
    // Handle just "Xmin" format
    if (formatted.match(/^(\d+)min$/)) {
        formatted = formatted.replace(/(\d+)min/, '$1 mins');
    }
    
    // Handle just "Xs" format
    if (formatted.match(/^(\d+)s$/)) {
        formatted = formatted.replace(/(\d+)s/, '$1 secs');
    }
    
    return formatted;
}

function getWebsiteName(url) {
    try {
        const urlObj = new URL(url);
        let name = urlObj.hostname.replace('www.', '').split('.')[0];
        return name.replace(/[^a-zA-Z0-9]/g, '_');
    } catch (e) {
        return 'website';
    }
}

function getVideoIdFromUrl(url) {
    try {
        const match = url.match(/video-([a-zA-Z0-9]+)/);
        return match ? match[1] : null;
    } catch (e) {
        return null;
    }
}

// ----- URL CLEANING -----

function cleanVideoUrl(url, title) {
    if (!url) return url;
    
    try {
        // Check if it's a supported domain
        const isSupported = SUPPORTED_DOMAINS.some(domain => url.includes(domain));
        if (!isSupported) return url;
        
        // Remove double slashes
        url = url.replace(/(https?:\/\/[^\/]+)\/+/g, '$1/');
        url = url.replace(/([^:])\/+/g, '$1/');
        
        // Extract base domain and video ID
        const match = url.match(/(https?:\/\/[^\/]+\/video-[a-zA-Z0-9]+)/);
        
        if (match && match[1]) {
            let baseUrl = match[1];
            
            if (title && title !== 'Untitled') {
                const slug = title
                    .toLowerCase()
                    .replace(/[^a-z0-9\s-]/g, '')
                    .replace(/\s+/g, '_')
                    .replace(/_+/g, '_')
                    .replace(/^_+|_+$/g, '')
                    .trim();
                
                if (slug.length > 0) {
                    return `${baseUrl}/${slug}`;
                }
            }
            return baseUrl;
        }
        
        // Fallback cleaning
        let cleaned = url;
        cleaned = cleaned.replace(/\/THUMBNUM\/[^\/]+$/, '');
        cleaned = cleaned.replace(/\/[0-9]+\/$/, '/');
        cleaned = cleaned.replace(/\/[0-9]+$/, '');
        cleaned = cleaned.replace(/\/$/, '');
        cleaned = cleaned.replace(/([^:])\/+/g, '$1/');
        
        return cleaned || url;
    } catch (e) {
        return url;
    }
}

// ===== NEW: CLEAN URL FOR SCRAPING =====
function cleanUrlForScraping(url) {
    if (!url) return url;
    
    try {
        // Remove query parameters
        let cleanUrl = url.split('?')[0];
        
        // Remove fragments
        cleanUrl = cleanUrl.split('#')[0];
        
        // Remove trailing slash
        cleanUrl = cleanUrl.replace(/\/$/, '');
        
        // Apply host rewrites (default: txnhh.com -> ccxx.com)
        for (const [from, to] of HOST_REWRITES) {
            cleanUrl = cleanUrl.split(from).join(to);
        }
        
        // Ensure HTTPS
        cleanUrl = cleanUrl.replace(/^http:/, 'https:');
        
        return cleanUrl;
    } catch (e) {
        return url;
    }
}

// ============================================
// 4. 💾 CACHE MANAGEMENT
// ============================================

const cache = new Map();

// ----- CACHE OPERATIONS -----

function getCached(key) {
    if (!cache.has(key)) return null;
    
    const entry = cache.get(key);
    const now = Date.now();
    
    if (now - entry.timestamp > CACHE.TTL) {
        cache.delete(key);
        return null;
    }
    
    return entry.data;
}

function setCached(key, data) {
    cache.set(key, {
        data: data,
        timestamp: Date.now()
    });
}

function isCachedValid(key) {
    return getCached(key) !== null;
}

function clearCache() {
    cache.clear();
    console.log('🧹 Cache cleared');
}

function cleanExpiredCache() {
    const now = Date.now();
    let count = 0;
    
    for (const [key, entry] of cache) {
        if (now - entry.timestamp > CACHE.TTL) {
            cache.delete(key);
            count++;
        }
    }
    
    if (count > 0) {
        console.log(`🧹 Cleaned ${count} expired cache entries`);
    }
}

// ----- CACHE KEYS -----

function getCacheKey(url, params = {}) {
    const paramStr = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
    return paramStr ? `${url}?${paramStr}` : url;
}

// ----- AUTO CLEANUP -----
setInterval(cleanExpiredCache, CACHE.CLEANUP_INTERVAL);

// ============================================
// 5. 🌐 SCRAPING LOGIC
// ============================================

// ----- FETCH FUNCTIONS -----

async function fetchPage(url) {
    try {
        const response = await axios.get(url, {
            headers: HEADERS,
            timeout: TIMEOUTS.REQUEST,
            maxRedirects: 5
        });
        return response.data;
    } catch (error) {
        console.error(`❌ Fetch error for ${url}:`, error.message);
        throw error;
    }
}

// Fetch a VIDEO page with real browser headers + detailed logging
async function fetchVideoPage(url, info = {}) {
    const t0 = Date.now();
    debugLog(`➡️  GET video page: ${url}`);
    try {
        const response = await axios.get(url, {
            headers: VIDEO_HEADERS,
            timeout: TIMEOUTS.REQUEST,
            maxRedirects: 5
        });
        const data = response.data;
        const len = typeof data === 'string' ? data.length : JSON.stringify(data || '').length;
        info.status = response.status;
        info.finalUrl = (response.request && response.request.res && response.request.res.responseUrl) || url;
        info.contentType = response.headers && response.headers['content-type'];
        info.length = len;
        debugLog(`✅ ${response.status} in ${Date.now() - t0}ms | type=${info.contentType} | ${len} chars | final=${info.finalUrl}`);
        return data;
    } catch (error) {
        const status = error.response && error.response.status;
        info.status = status || error.code || 'ERR';
        debugLog(`❌ Video page fetch FAILED after ${Date.now() - t0}ms | status=${status || 'none'} | code=${error.code || '-'} | msg=${error.message}`);
        if (error.response && error.response.data) {
            const body = typeof error.response.data === 'string' ? error.response.data : JSON.stringify(error.response.data);
            debugLog(`❌ Response body starts: ${body.slice(0, 300).replace(/\s+/g, ' ')}`);
        }
        console.error(`❌ Fetch error for ${url}:`, error.message);
        throw error;
    }
}

// Test the CDN link the way a browser would (without / with our site as Referer)
async function probeMediaUrl(mediaUrl) {
    const results = [];
    let siteReferer = '';
    try { siteReferer = new URL(URLS.API).origin + '/'; } catch (e) { siteReferer = ''; }

    const tests = [{ label: 'no Referer', headers: {} }];
    if (siteReferer) tests.push({ label: `Referer ${siteReferer}`, headers: { Referer: siteReferer } });

    for (const t of tests) {
        try {
            const r = await axios.get(mediaUrl, {
                headers: { 'User-Agent': VIDEO_HEADERS['User-Agent'], Range: 'bytes=0-1', ...t.headers },
                responseType: 'stream',
                timeout: 15000,
                maxRedirects: 3,
                validateStatus: () => true
            });
            const row = {
                test: t.label,
                status: r.status,
                contentType: r.headers['content-type'],
                contentLength: r.headers['content-length'],
                contentRange: r.headers['content-range']
            };
            results.push(row);
            debugLog(`🧪 CDN probe [${t.label}] → ${row.status} | type=${row.contentType} | length=${row.contentLength} | range=${row.contentRange}`);
            if (r.data && r.data.destroy) r.data.destroy();
        } catch (e) {
            results.push({ test: t.label, error: e.message });
            debugLog(`🧪 CDN probe [${t.label}] failed: ${e.message}`);
        }
    }
    return results;
}

// ----- VIDEO SCRAPER -----

function scrapeVideos(html, sourceUrl) {
    const videos = [];
    
    // Find all video containers
    const videoRegex = /<div class="video">(.*?)<\/div>\s*(?=<div class="video">|$)/gs;
    let match;
    let index = 0;
    
    while ((match = videoRegex.exec(html)) !== null) {
        index++;
        const videoBlock = match[1];
        
        if (!videoBlock || videoBlock.trim().length < 50) continue;
        
        // Extract video URL - this already gets the FULL URL from the page
let videoUrl = null;
const urlMatch = videoBlock.match(/<div class="video-thumb">\s*<a\s+href="([^"]+)"[^>]*>/);
if (urlMatch) {
    videoUrl = urlMatch[1]; 
}
        
        // Extract thumbnail
        let thumbnail = null;
        const thumbMatch = videoBlock.match(/<amp-img[^>]+src="([^"]+)"[^>]*>/);
        if (thumbMatch) {
            thumbnail = thumbMatch[1];
        }
        
        // Extract title
        let title = null;
        const titlePatterns = [
            /<p class="title">\s*<a[^>]+title="([^"]+)"[^>]*>/,
            /<p class="title">\s*<a[^>]*>([^<]+)<\/a>/,
            /<div class="thumb-under">.*?<a[^>]+title="([^"]+)"[^>]*>/s
        ];
        
        for (const pattern of titlePatterns) {
            const match = videoBlock.match(pattern);
            if (match) {
                title = match[1].trim();
                break;
            }
        }
        title = title || 'Untitled';
        
        // Extract uploader
        let uploader = null;
        const uploaderMatch = videoBlock.match(/<a class="uploader"[^>]*>([^<]+)<\/a>/);
        if (uploaderMatch) {
            uploader = uploaderMatch[1].trim();
        }
        
        // Extract length
        let length = 'N/A';
        const lengthMatch = videoBlock.match(/<div class="length">([^<]+)<\/div>/);
        if (lengthMatch) {
            length = lengthMatch[1].trim();
        }
        
        // Extract quality
        let quality = 'N/A';
        const qualityMatch = videoBlock.match(/<span class="video-hd">([^<]+)<\/span>/);
        if (qualityMatch) {
            quality = qualityMatch[1].trim();
        }
        
        // Extract views
let views = 'N/A';
const viewsMatch = videoBlock.match(/<div class="views">([^<]+)<\/div>/);
if (viewsMatch) {
    views = viewsMatch[1].trim();
}

// Clean URL
if (videoUrl) {
    videoUrl = cleanVideoUrl(videoUrl, title);
}

// ✅ Store the FULL URL (with title slug) - NOT just the ID
if (title && title !== 'Untitled') {
    videos.push({
        id: getVideoIdFromUrl(videoUrl) || `video_${index}`,
        url: videoUrl || '#',   // ✅ This is the FULL URL with slug
        thumbnail: thumbnail || '',
        title: decodeText(title),
        uploader: uploader || 'Unknown',
        duration: length,
        quality: quality,
        views: views
    });
}
}
    
    return videos;
}

// ----- VIDEO DETAILS SCRAPER -----

function scrapeVideoDetails(html) {
    const details = {
        title: 'Untitled',
        uploader: 'Unknown',
        duration: '00:00',
        quality: '1080p',
        rating: '100%',
        likes: '0',
        dislikes: '0',
        views: 'None',
        tags: [],
        thumbnail: '',
        videoUrl: '#',
        downloadUrl: '#',
        relatedVideos: []
    };
    
   // Extract title
const titleMatch = html.match(/<div class="video-title">\s*<strong>([^<]+)<\/strong>/);
if (titleMatch) {
    details.title = decodeText(titleMatch[1].trim());  // ✅ decodeText() must be called
}
    
// Extract uploader, duration, quality from metadata
const metadataSpanMatch = html.match(/<span class="metadata">(.*?)<\/span>/s);
if (metadataSpanMatch) {
    const metaContent = metadataSpanMatch[1];
    
    const uploaderMatch = metaContent.match(/<a class="gold-plate"[^>]*>([^<]+)<\/a>/);
    if (uploaderMatch) {
        details.uploader = decodeText(uploaderMatch[1].trim());  // ✅ decodeText() here too
    }
        
        const durationMatch = metaContent.match(/(\d+min)/);
        if (durationMatch) {
            details.duration = durationMatch[1];
        }
        
        const qualityMatch = metaContent.match(/(\d+p)/);
        if (qualityMatch) {
            details.quality = qualityMatch[1];
        }
    }
    
   // Extract rating, likes, dislikes
const ratingMatch = html.match(/<span class="rating-box value">([^<]+)<\/span>/);
if (ratingMatch) {
    details.rating = ratingMatch[1].trim();
}

const likesMatch = html.match(/<a class="vote-action-good[^>]*>.*?<span class="value">([^<]+)<\/span>/s);
if (likesMatch) {
    details.likes = likesMatch[1].trim();
}

const dislikesMatch = html.match(/<a class="vote-action-bad[^>]*>.*?<span class="value">([^<]+)<\/span>/s);
if (dislikesMatch) {
    details.dislikes = dislikesMatch[1].trim();
}

// Extract from JSON-LD
const jsonLdMatch = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s);
if (jsonLdMatch) {
    try {
        const jsonData = JSON.parse(jsonLdMatch[1]);
        
        if (jsonData.interactionStatistic) {
            details.views = jsonData.interactionStatistic.userInteractionCount?.toLocaleString() || 'N/A';
        }
        
        if (jsonData.thumbnailUrl && jsonData.thumbnailUrl.length > 0) {
            details.thumbnail = jsonData.thumbnailUrl[0];
        }
        
        if (jsonData.duration) {
            const durMatch = jsonData.duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
            if (durMatch) {
                let hours = durMatch[1] ? `${durMatch[1]} hour${durMatch[1] > 1 ? 's' : ''}` : '';
                let mins = durMatch[2] ? `${durMatch[2]} minute${durMatch[2] > 1 ? 's' : ''}` : '';
                let secs = durMatch[3] ? `${durMatch[3]} second${durMatch[3] > 1 ? 's' : ''}` : '';
                
                let formatted = '';
                if (hours) formatted += hours;
                if (mins) {
                    if (formatted) formatted += ', ';
                    formatted += mins;
                }
                if (secs) {
                    if (formatted) formatted += ', ';
                    formatted += secs;
                }
                
                if (formatted) details.duration = formatted;
            }
        }
        
        // ✅ Extract video URL & download URL - INSIDE try block
        if (jsonData.contentUrl) {
            details.videoUrl = jsonData.contentUrl;
            
            if (jsonData.contentUrl.includes('&download=')) {
                details.downloadUrl = jsonData.contentUrl;
            } else {
                const filename = details.title
                    .toLowerCase()
                    .replace(/[^a-z0-9]/g, '_')
                    .replace(/_+/g, '_')
                    .trim();
                
                const baseUrl = jsonData.contentUrl.split('?')[0];
                const securePart = jsonData.contentUrl.split('?')[1];
                
                if (baseUrl && securePart) {
                    details.downloadUrl = `${baseUrl}?${securePart}&download=ccxx_${filename}_SD.mp4`;
                } else {
                    details.downloadUrl = jsonData.contentUrl;
                }
            }
        }
        
    } catch (e) {
        console.error('JSON-LD parse error:', e.message);
    }
}

// ✅ FALLBACK: If contentUrl is missing, try to find video URL in the page
if (!details.videoUrl || details.videoUrl === '#') {
    const videoSrcMatch = html.match(/<video[^>]*src="([^"]+)"/);
    if (videoSrcMatch) {
        details.videoUrl = videoSrcMatch[1];
    }
}

// Format duration
details.duration = formatDuration(details.duration);
    
    // Extract tags
    const tagsMatch = html.match(/<div class="metadata-row video-tags">.*?<\/div>/s);
    if (tagsMatch) {
        const tagRegex = /<a class="is-keyword"[^>]*>([^<]+)<\/a>/g;
        let tagMatch;
        while ((tagMatch = tagRegex.exec(tagsMatch[0])) !== null) {
            details.tags.push(decodeText(tagMatch[1].trim()));
        }
    }
    
    // Extract related videos - WITH PROPER THUMBNAIL EXTRACTION
const relatedMatch = html.match(/var video_related=\[(.*?)\];/s);
if (relatedMatch) {
    try {
        const videoObjects = relatedMatch[1].match(/\{[^}]*\}/g);
        const seenIds = new Set(); // ✅ Deduplicate
        
        if (videoObjects) {
            for (const objStr of videoObjects) {
                try {
                    const urlMatch = objStr.match(/"u":"([^"]+)"/);
                    const relUrl = urlMatch ? urlMatch[1].replace(/\\/g, '') : '';  // strip JSON backslashes
                    const titleMatch = objStr.match(/"t":"([^"]+)"/);
                    const durationMatch = objStr.match(/"d":"([^"]+)"/);
                    const viewsMatch = objStr.match(/"n":"([^"]+)"/);
                    const ratingMatch = objStr.match(/"r":"([^"]+)"/);
                    const uploaderMatch = objStr.match(/"p":"([^"]+)"/);
                    
                    // ✅ FIX: Extract thumbnail from MULTIPLE sources
                    let thumbnail = '';
                    
                    // Try 'i' (main thumbnail)
                    const thumbMatch = objStr.match(/"i":"([^"]+)"/);
                    if (thumbMatch) {
                        thumbnail = thumbMatch[1];
                    }
                    
                    // If 'i' is missing or looks like a placeholder, try 'il' (listing thumbnail)
                    if (!thumbnail || thumbnail.includes('undefined') || thumbnail.includes('null')) {
                        const thumbListingMatch = objStr.match(/"il":"([^"]+)"/);
                        if (thumbListingMatch) {
                            thumbnail = thumbListingMatch[1];
                        }
                    }
                    
                    // If still missing, try 'if' (fallback)
                    if (!thumbnail || thumbnail.includes('undefined') || thumbnail.includes('null')) {
                        const thumbFallbackMatch = objStr.match(/"if":"([^"]+)"/);
                        if (thumbFallbackMatch) {
                            thumbnail = thumbFallbackMatch[1];
                        }
                    }
                    
                    // If still missing, try 'ip' (preview)
                    if (!thumbnail || thumbnail.includes('undefined') || thumbnail.includes('null')) {
                        const thumbPreviewMatch = objStr.match(/"ip":"([^"]+)"/);
                        if (thumbPreviewMatch) {
                            thumbnail = thumbPreviewMatch[1];
                        }
                    }
                    
                    // If still missing, try 'mu' (mobile)
                    if (!thumbnail || thumbnail.includes('undefined') || thumbnail.includes('null')) {
                        const thumbMobileMatch = objStr.match(/"mu":"([^"]+)"/);
                        if (thumbMobileMatch) {
                            thumbnail = thumbMobileMatch[1];
                        }
                    }
                    
                    // ✅ Clean up the thumbnail URL
                    if (thumbnail) {
                        // Remove backslashes
                        thumbnail = thumbnail.replace(/\\/g, '');
                        // Ensure it's a full URL
                        if (!thumbnail.startsWith('http')) {
                            // If it starts with //, add https:
                            if (thumbnail.startsWith('//')) {
                                thumbnail = `https:${thumbnail}`;
                            } else {
                                // If it's a relative path, add domain
                                thumbnail = `${BASE_ORIGIN}${thumbnail}`;
                            }
                        }
                    }
                    
                    if (titleMatch) {
                        // ✅ Deduplicate
                        const videoId = relUrl ? relUrl.split('/').pop() : '';
                        if (seenIds.has(videoId)) continue;
                        seenIds.add(videoId);
                        
                        let fullUrl = relUrl || '#';
                        if (fullUrl && !fullUrl.startsWith('http')) {
                            fullUrl = `${VIDEO_ORIGIN}${fullUrl}`;
                        }
                        
                        details.relatedVideos.push({
                            url: fullUrl,
                            thumbnail: thumbnail || '',
                            title: decodeText(titleMatch[1].trim()),
                          duration: durationMatch ? durationMatch[1] : '00:00',
                            views: viewsMatch ? viewsMatch[1] : '208',
                            rating: ratingMatch ? ratingMatch[1] : '100%',
                            uploader: uploaderMatch ? decodeText(uploaderMatch[1].trim()) : 'The Naughty'
                        });
                    }
                } catch (e) {
                    console.error('Error parsing related video:', e.message);
                }
            }
        }
    } catch (e) {
        console.error('Error parsing related videos:', e.message);
    }
}

// 🔎 Diagnostics
debugLog(`📄 Parsed: title="${details.title}" | uploader=${details.uploader} | jsonLd=${jsonLdMatch ? 'yes' : 'NO'} | video=${describeMediaUrl(details.videoUrl)} | download=${details.downloadUrl && details.downloadUrl !== '#' ? 'yes' : 'NO'} | tags=${details.tags.length} | related=${details.relatedVideos.length}`);
if (!details.videoUrl || details.videoUrl === '#') {
    const pageTitle = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1];
    debugLog(`⚠️ NO VIDEO URL FOUND. Page <title>: "${pageTitle}" | html starts: ${String(html).slice(0, 300).replace(/\s+/g, ' ')}`);
}

return details; // FIX: video details were never returned
}

// ----- SCRAPE FUNCTIONS -----

async function scrapeHomepage() {
    try {
        const html = await fetchPage(URLS.BASE);
        const videos = scrapeVideos(html, URLS.BASE);
        return {
            videos: videos,
            total: videos.length,
            source: URLS.BASE,
            hasMore: videos.length >= LIMITS.MAX_VIDEOS
        };
    } catch (error) {
        console.error('❌ Homepage scrape error:', error.message);
        throw error;
    }
}

async function scrapeSearch(query) {
    try {
        const searchUrl = `${URLS.SEARCH}${encodeURIComponent(query)}`;
        const html = await fetchPage(searchUrl);
        const videos = scrapeVideos(html, searchUrl);
        return {
            videos: videos,
            total: videos.length,
            query: query,
            source: searchUrl,
            hasMore: videos.length >= LIMITS.MAX_VIDEOS
        };
    } catch (error) {
        console.error('❌ Search scrape error:', error.message);
        throw error;
    }
}

async function scrapeVideo(videoId) {
    try {
        // Try to construct URL from video ID
        const videoUrl = `${URLS.VIDEO}${videoId}/`;
        const html = await fetchVideoPage(videoUrl);
        const details = scrapeVideoDetails(html);
        details.id = videoId;
        return details;
    } catch (error) {
        console.error('❌ Video scrape error:', error.message);
        throw error;
    }
}

// ============================================
// 6. 📥 DOWNLOAD HANDLER
// ============================================

async function getVideoDownloadUrl(videoId) {
    try {
        const videoUrl = `${URLS.VIDEO}${videoId}/`;
        const html = await fetchVideoPage(videoUrl);
        const details = scrapeVideoDetails(html);
        return details.downloadUrl || details.videoUrl;
    } catch (error) {
        console.error('❌ Download URL error:', error.message);
        throw error;
    }
}

async function streamVideo(videoId, res) {
    try {
        const videoUrl = await getVideoDownloadUrl(videoId);
        
        if (!videoUrl || videoUrl === '#') {
            return res.status(404).json({ error: 'Video not found' });
        }
        
        const response = await axios({
            method: 'GET',
            url: videoUrl,
            responseType: 'stream',
            timeout: TIMEOUTS.DOWNLOAD,
            headers: VIDEO_HEADERS
        });
        
        res.setHeader('Content-Type', MIME_TYPES.VIDEO_MP4);
        res.setHeader('Cache-Control', 'public, max-age=3600');
        response.data.pipe(res);
        
    } catch (error) {
        console.error('❌ Stream error:', error.message);
        res.status(500).json({ error: 'Stream failed' });
    }
}

async function downloadVideo(videoId, res) {
    try {
        const videoUrl = await getVideoDownloadUrl(videoId);
        
        if (!videoUrl || videoUrl === '#') {
            return res.status(404).json({ error: 'Video not found' });
        }
        
        const response = await axios({
            method: 'GET',
            url: videoUrl,
            responseType: 'stream',
            timeout: TIMEOUTS.DOWNLOAD,
            headers: VIDEO_HEADERS
        });
        
        const filename = `video_${videoId}.mp4`;
        res.setHeader('Content-Type', MIME_TYPES.VIDEO_MP4);
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        response.data.pipe(res);
        
    } catch (error) {
        console.error('❌ Download error:', error.message);
        res.status(500).json({ error: 'Download failed' });
    }
}

// ============================================
// 7. 🗂️ EXPRESS SERVER SETUP
// ============================================

// ----- SECURITY MIDDLEWARE -----

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
            scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdnjs.cloudflare.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
            mediaSrc: ["'self'", "https:", "blob:"], // FIX: allow video from CDN
            imgSrc: ["'self'", "data:", "https:", "http:", "*"],
            connectSrc: ["'self'", "https://api.mangadex.org", "https://uploads.mangadex.org"]
        }
    }
}));

// ----- CORS -----

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Accept']
}));

// ----- COMPRESSION -----

app.use(compression());

// ----- PARSING -----

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ----- STATIC FILES -----

app.use(express.static(__dirname));
app.use('/temp', express.static(PATHS.TEMP));

// ----- PUBLIC API RATE LIMITS ----
// The playground calls /api/v1, so its requests are counted. Existing website
// endpoints such as /api/home and /api/search do not use this limiter.
// Render runs this in one Node process. For multiple Render instances, replace
// this Map with a shared Redis store to keep counters consistent across instances.
const API_RATE_LIMITS = {
    minute: { limit: 40, windowMs: 60 * 1000 },
    hour: { limit: 2500, windowMs: 60 * 60 * 1000 }
};
const apiRateBuckets = new Map();

function getClientIp(req) {
    return String(req.ip || req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

function apiRateLimit(req, res, next) {
    const now = Date.now();
    const ip = getClientIp(req);
    let record = apiRateBuckets.get(ip);
    if (!record) {
        record = { minute: { start: now, count: 0 }, hour: { start: now, count: 0 } };
        apiRateBuckets.set(ip, record);
    }

    for (const key of ['minute', 'hour']) {
        const config = API_RATE_LIMITS[key];
        const bucket = record[key];
        if (now - bucket.start >= config.windowMs) {
            bucket.start = now;
            bucket.count = 0;
        }
        bucket.count += 1;
    }

    const minute = record.minute;
    const hour = record.hour;
    const minuteRemaining = Math.max(0, API_RATE_LIMITS.minute.limit - minute.count);
    const hourRemaining = Math.max(0, API_RATE_LIMITS.hour.limit - hour.count);
    const minuteReset = Math.max(1, Math.ceil((minute.start + API_RATE_LIMITS.minute.windowMs - now) / 1000));
    const hourReset = Math.max(1, Math.ceil((hour.start + API_RATE_LIMITS.hour.windowMs - now) / 1000));

    res.set({
        'X-RateLimit-Minute-Limit': String(API_RATE_LIMITS.minute.limit),
        'X-RateLimit-Minute-Remaining': String(minuteRemaining),
        'X-RateLimit-Minute-Reset': String(minuteReset),
        'X-RateLimit-Hour-Limit': String(API_RATE_LIMITS.hour.limit),
        'X-RateLimit-Hour-Remaining': String(hourRemaining),
        'X-RateLimit-Hour-Reset': String(hourReset),
        'RateLimit-Policy': '40;w=60, 2500;w=3600'
    });

    // If both are exceeded, report the longer retry period.
    if (minute.count > API_RATE_LIMITS.minute.limit || hour.count > API_RATE_LIMITS.hour.limit) {
        const isHourly = hour.count > API_RATE_LIMITS.hour.limit;
        const retryAfter = isHourly ? hourReset : minuteReset;
        res.set('Retry-After', String(retryAfter));
        return res.status(429).json({
            success: false,
            error: {
                code: 'RATE_LIMIT_EXCEEDED',
                message: isHourly
                    ? 'Hourly API limit exceeded. Please retry after the reset.'
                    : 'Per-minute API limit exceeded. Please retry after the reset.',
                limit: isHourly ? API_RATE_LIMITS.hour.limit : API_RATE_LIMITS.minute.limit,
                window: isHourly ? '1 hour' : '1 minute',
                retryAfterSeconds: retryAfter
            }
        });
    }
    next();
}

// Pretty-print JSON responses for the public v1 API only. This is request-scoped
// and does not change Express JSON formatting for the existing website routes.
function apiPrettyJson(req, res, next) {
    const originalJson = res.json;
    res.json = function prettyJson(body) {
        const replacer = this.app.get('json replacer');
        const bodyText = JSON.stringify(body, replacer, 2);
        this.set('Content-Type', 'application/json; charset=utf-8');
        return this.send(bodyText);
    };
    next();
}

// Only /api/v1 is rate-limited. 
app.use('/api/v1', apiPrettyJson, apiRateLimit);

// Keep the in-memory limiter bounded and clear stale visitor records.
setInterval(() => {
    const now = Date.now();
    for (const [ip, record] of apiRateBuckets) {
        if (now - record.hour.start >= API_RATE_LIMITS.hour.windowMs &&
            now - record.minute.start >= API_RATE_LIMITS.minute.windowMs) {
            apiRateBuckets.delete(ip);
        }
    }
}, 10 * 60 * 1000).unref();

// ----- DIRECTORY CREATION -----

function ensureDirectories() {
    const dirs = [PATHS.TEMP, PATHS.CACHE, PATHS.DOWNLOADS, PATHS.LOGS];
    dirs.forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });
}

// ============================================
// 8. 🛣️ API ROUTES
// ============================================

// ============================================
// 📊 IMPROVED HEALTH CHECK ENDPOINT
// ============================================

// Server start time (for uptime tracking)
const SERVER_START_TIME = Date.now();

app.get('/ping', (req, res) => {
    const now = Date.now();
    const uptimeMs = now - SERVER_START_TIME;
    const uptimeSeconds = Math.floor(uptimeMs / 1000);
    const uptimeMinutes = Math.floor(uptimeSeconds / 60);
    const uptimeHours = Math.floor(uptimeMinutes / 60);
    const uptimeDays = Math.floor(uptimeHours / 24);

    // Format uptime in human-readable format
    let uptimeString = '';
    if (uptimeDays > 0) uptimeString += `${uptimeDays}d `;
    if (uptimeHours % 24 > 0) uptimeString += `${uptimeHours % 24}h `;
    if (uptimeMinutes % 60 > 0) uptimeString += `${uptimeMinutes % 60}m `;
    if (uptimeSeconds % 60 > 0) uptimeString += `${uptimeSeconds % 60}s`;
    if (!uptimeString) uptimeString = '0s';

    // Get time in UTC+1 (West Africa Time)
    const nowUTC1 = new Date(now + (60 * 60 * 1000)); // UTC+1
    const timeUTC1 = nowUTC1.toISOString().replace('Z', '+01:00');
    const timeUTC1Formatted = nowUTC1.toLocaleString('en-US', {
        timeZone: 'Africa/Lagos',
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });

    // Get all available routes
    const routes = [
        { method: 'GET', path: '/ping', description: 'Health check' },
        { method: 'GET', path: '/api/home', description: 'Get homepage videos' },
        { method: 'GET', path: '/api/search', description: 'Search videos' },
        { method: 'GET', path: '/api/video/:id', description: 'Get video details' },
        { method: 'GET', path: '/api/stream/:id', description: 'Stream video' },
        { method: 'GET', path: '/api/download/:id', description: 'Download video' },
        { method: 'GET', path: '/api/v1/search?q=', description: 'Public API search' },
        { method: 'GET', path: '/api/v1/video?url=', description: 'Public API video details' },
        { method: 'GET', path: '/api/v1/stream?url=', description: 'Public API stream link' },
        { method: 'GET', path: '/api/v1/download?url=', description: 'Public API download link' },
        { method: 'GET', path: '/api/v1/limits', description: 'Current rate-limit usage' },
        { method: 'GET', path: '/api/v1/status', description: 'Public API status' },
        { method: 'GET', path: '/api-docs', description: 'API documentation and playground' },
        { method: 'POST', path: '/api/clear-cache', description: 'Clear cache' },
        { method: 'GET', path: '/api/cache-status', description: 'Cache status' },
        { method: 'GET', path: '/', description: 'Homepage' },
        { method: 'GET', path: '/video', description: 'Video player page' }
    ];

    // Get memory usage
    const memoryUsage = process.memoryUsage();
    const memory = {
        rss: `${Math.round(memoryUsage.rss / 1024 / 1024)} MB`,
        heapTotal: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)} MB`,
        heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)} MB`,
        external: `${Math.round(memoryUsage.external / 1024 / 1024)} MB`
    };

    // Get Node.js version
    const nodeVersion = process.version;

    // Get platform info
    const platform = {
        os: process.platform,
        arch: process.arch,
        cpus: require('os').cpus().length,
        totalMemory: `${Math.round(require('os').totalmem() / 1024 / 1024 / 1024)} GB`,
        freeMemory: `${Math.round(require('os').freemem() / 1024 / 1024 / 1024)} GB`
    };

    // Build response
    const response = {
        status: '🟢 alive',
        timestamp: {
            iso: new Date().toISOString(),
            utc1: timeUTC1,
            utc1Formatted: timeUTC1Formatted,
            unix: Math.floor(now / 1000)
        },
        uptime: {
            milliseconds: uptimeMs,
            seconds: uptimeSeconds,
            minutes: uptimeMinutes,
            hours: uptimeHours,
            days: uptimeDays,
            humanReadable: uptimeString
        },
        server: {
            nodeVersion: nodeVersion,
            environment: process.env.NODE_ENV || 'development',
            port: PORT,
            platform: platform
        },
        memory: memory,
        cache: {
            size: cache.size,
            ttl: `${CACHE.TTL / 60000} minutes`
        },
        endpoints: routes
    };

    // Pretty print JSON response
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(response);
});

// ----- PUBLIC URL SAFETY + SHARED VIDEO-BY-URL PROCESSING -----
function validatePublicVideoUrl(rawUrl) {
    if (typeof rawUrl !== 'string' || !rawUrl.trim() || rawUrl.length > 128) {
        const error = new Error('A valid video page URL is required (maximum 128 characters).');
        error.status = 400;
        throw error;
    }

    let parsed;
    try {
        parsed = new URL(rawUrl.trim());
    } catch (_) {
        const error = new Error('The supplied URL is invalid.');
        error.status = 400;
        throw error;
    }

    if (
        !['http:', 'https:'].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        (parsed.port && !['80', '443'].includes(parsed.port))
    ) {
        const error = new Error('Only public HTTP/HTTPS video-page URLs are accepted.');
        error.status = 400;
        throw error;
    }

    // Use the application's already-normalized environment-backed allowlist.
    // This avoids parsing SUPPORTED_DOMAINS differently from the website.
    if (!isSupportedHost(parsed.toString())) {
        const error = new Error(`Unsupported video domain: ${parsed.hostname}`);
        error.status = 400;
        throw error;
    }

    const cleaned = cleanUrlForScraping(parsed.toString());
    if (!isSupportedHost(cleaned)) {
        const error = new Error('The rewritten video domain is not supported.');
        error.status = 400;
        throw error;
    }

    return cleaned;
}

async function fetchSupportedVideoPage(startUrl) {
    // Preserve the public API's redirect protection. Every redirect destination
    // must also pass the same environment-backed SUPPORTED_DOMAINS check.
    let currentUrl = validatePublicVideoUrl(startUrl);
    for (let hop = 0; hop <= 5; hop++) {
        const response = await axios.get(currentUrl, {
            headers: VIDEO_HEADERS,
            timeout: TIMEOUTS.REQUEST,
            maxRedirects: 0,
            validateStatus: status => status >= 200 && status < 400
        });

        if (response.status >= 300 && response.status < 400) {
            const location = response.headers && response.headers.location;
            if (!location || hop === 5) {
                throw new Error('Too many or invalid source redirects.');
            }
            currentUrl = validatePublicVideoUrl(new URL(location, currentUrl).toString());
            continue;
        }

        return response.data;
    }

    throw new Error('Unable to follow source redirects safely.');
}

// Both /api/video/by-url and the versioned public API now share URL cleaning,
// cache handling, detail scraping, and alternate-host fallback. The public API
// supplies its redirect-safe fetcher; the website keeps its existing fetcher.
async function getVideoDetailsByUrl(rawUrl, options = {}) {
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
        const error = new Error('Video URL required');
        error.status = 400;
        throw error;
    }

    let videoUrl = cleanUrlForScraping(rawUrl.trim());
    const fetchPage = options.fetchPage || fetchVideoPage;

    // Match the website route's optional strict-domain setting before cache use.
    if (ENFORCE_DOMAIN_CHECK && !isSupportedHost(videoUrl)) {
        const error = new Error('Unsupported video domain');
        error.status = 400;
        throw error;
    }

    const cacheKey = getCacheKey('video-by-url', { url: videoUrl });
    const cached = getCached(cacheKey);
    if (cached) {
        debugLog(`💾 Cache HIT | video=${describeMediaUrl(cached.videoUrl)}`);
        return cached;
    }

    const html = await fetchPage(videoUrl);
    let details = scrapeVideoDetails(html);

    // Use the same alternate-host retry as the website player.
    if (!details.videoUrl || details.videoUrl === '#') {
        const altUrl = swapToVideoHost(videoUrl);
        if (altUrl && (!options.enforceSupportedHost || isSupportedHost(altUrl))) {
            debugLog(`🔁 No video link on this host. Retrying on video host: ${altUrl}`);
            try {
                const html2 = await fetchPage(altUrl);
                const details2 = scrapeVideoDetails(html2);
                if (details2.videoUrl && details2.videoUrl !== '#') {
                    details = details2;
                    videoUrl = altUrl;
                    debugLog('🔁 Retry succeeded - using video-host page');
                } else {
                    debugLog('🔁 Retry also had no video link');
                }
            } catch (retryErr) {
                debugLog(`🔁 Alternate-host retry failed: ${retryErr.message}`);
            }
        }
    }

    details.id = getVideoIdFromUrl(videoUrl) || 'unknown';
    details.url = videoUrl;
    setCached(cacheKey, details);
    return details;
}

async function getPublicVideoDetails(rawUrl) {
    // Use the exact same URL processing and page-fetch path as
    // /api/video/by-url. Do not apply the separate public-API domain allowlist:
    // it can disagree with the website's configured source handling.
    const details = await getVideoDetailsByUrl(String(rawUrl || ''), {
        fetchPage: fetchVideoPage
    });

    if (!details.videoUrl || details.videoUrl === '#') {
        const error = new Error('No playable stream was found for this video.');
        error.status = 404;
        throw error;
    }

    return details;
}

app.get('/api/v1/status', (req, res) => {
    res.json({ success: true, service: 'THE GENESIS API', version: '1.0.0', status: 'online', uptimeSeconds: Math.floor(process.uptime()) });
});

app.get('/api/v1/limits', (req, res) => {
    res.json({
        success: true,
        scope: 'per IP address',
        limits: {
            perMinute: { limit: API_RATE_LIMITS.minute.limit, windowSeconds: 60, remaining: Number(res.getHeader('X-RateLimit-Minute-Remaining')) },
            perHour: { limit: API_RATE_LIMITS.hour.limit, windowSeconds: 3600, remaining: Number(res.getHeader('X-RateLimit-Hour-Remaining')) }
        },
        note: 'Limits apply to /api/v1 endpoints, including requests made from the API playground.'
    });
});

app.get('/api/v1/search', async (req, res) => {
    try {
        const query = String(req.query.q || '').trim();
        if (query.length < 2 || query.length > 120) {
            return res.status(400).json({ success: false, error: { code: 'INVALID_QUERY', message: 'q must contain between 2 and 120 characters.' } });
        }
        const cacheKey = getCacheKey('v1-search', { q: query.toLowerCase() });
        let data = getCached(cacheKey);
        if (!data) {
            data = await scrapeSearch(query);
            setCached(cacheKey, data);
        }
        res.json({ success: true, ...data });
    } catch (error) {
        console.error('V1 search error:', error.message);
        res.status(500).json({ success: false, error: { code: 'SEARCH_FAILED', message: 'Search could not be completed.' } });
    }
});

app.get('/api/v1/video', async (req, res) => {
    try {
        if (!req.query.url) return res.status(400).json({ success: false, error: { code: 'URL_REQUIRED', message: 'Pass a video page URL using the url parameter.' } });
        const details = await getPublicVideoDetails(String(req.query.url));
        res.json({ success: true, video: details });
    } catch (error) {
        const status = error.status || 502;
        res.status(status).json({ success: false, error: { code: status === 404 ? 'VIDEO_NOT_FOUND' : status === 400 ? 'INVALID_URL' : 'VIDEO_LOOKUP_FAILED', message: status < 500 ? error.message : 'Unable to retrieve video details from the source.' } });
    }
});

function getSignedUrlExpiry(url) {
    try {
        const parsed = new URL(url);
        const expiryNames = ['expires', 'expiry', 'expires_at', 'exp', 'e'];

        // Prefer an explicitly named expiry query parameter when the CDN provides one.
        for (const name of expiryNames) {
            const value = parsed.searchParams.get(name);
            if (value && /^\d{10,13}$/.test(value.trim())) {
                const numeric = Number(value.trim());
                const milliseconds = value.trim().length === 13 ? numeric : numeric * 1000;
                const date = new Date(milliseconds);
                if (Number.isFinite(date.getTime())) return date.toISOString();
            }
        }

        // This CDN places the Unix expiry timestamp after the comma in `secure`.
        const secure = parsed.searchParams.get('secure') || '';
        const match = secure.match(/(?:^|,)\s*(\d{10,13})\s*$/);
        if (!match) return null;

        const numeric = Number(match[1]);
        const milliseconds = match[1].length === 13 ? numeric : numeric * 1000;
        const date = new Date(milliseconds);
        return Number.isFinite(date.getTime()) ? date.toISOString() : null;
    } catch (_) {
        return null;
    }
}

app.get('/api/v1/stream', async (req, res) => {
    try {
        if (!req.query.url) return res.status(400).json({ success: false, error: { code: 'URL_REQUIRED', message: 'Pass a video page URL using the url parameter.' } });
        const details = await getPublicVideoDetails(String(req.query.url));
        const expiresAt = getSignedUrlExpiry(details.videoUrl);
        res.json({ success: true, streamUrl: details.videoUrl, expiresAt, sourcePage: details.url, note: expiresAt ? 'Expiry time was extracted from the signed stream URL; the upstream host controls its validity.' : 'No expiry timestamp was found in the signed stream URL.' });
    } catch (error) {
        const status = error.status || 502;
        res.status(status).json({ success: false, error: { code: status === 404 ? 'VIDEO_NOT_FOUND' : status === 400 ? 'INVALID_URL' : 'STREAM_LOOKUP_FAILED', message: status < 500 ? error.message : 'Unable to retrieve a stream link from the source.' } });
    }
});

app.get('/api/v1/download', async (req, res) => {
    try {
        if (!req.query.url) return res.status(400).json({ success: false, error: { code: 'URL_REQUIRED', message: 'Pass a video page URL using the url parameter.' } });
        const details = await getPublicVideoDetails(String(req.query.url));
        const downloadUrl = details.downloadUrl && details.downloadUrl !== '#' ? details.downloadUrl : details.videoUrl;
        if (String(req.query.redirect).toLowerCase() === 'true') return res.redirect(302, downloadUrl);
        res.json({ success: true, downloadUrl, sourcePage: details.url, redirectUrl: `${URLS.API}/api/v1/download?url=${encodeURIComponent(details.url)}&redirect=true`, note: 'Use redirect=true to send a browser directly to the upstream download URL.' });
    } catch (error) {
        const status = error.status || 502;
        res.status(status).json({ success: false, error: { code: status === 404 ? 'VIDEO_NOT_FOUND' : status === 400 ? 'INVALID_URL' : 'DOWNLOAD_LOOKUP_FAILED', message: status < 500 ? error.message : 'Unable to retrieve a download link from the source.' } });
    }
});

// ----- HOME ROUTE -----

app.get('/api/home', async (req, res) => {
    try {
        const cacheKey = getCacheKey('home');
        const cached = getCached(cacheKey);
        
        if (cached) {
            return res.json(cached);
        }
        
        const data = await scrapeHomepage();
        setCached(cacheKey, data);
        res.json(data);
        
    } catch (error) {
        console.error('❌ Home API error:', error.message);
        res.status(500).json({ error: 'Failed to fetch videos' });
    }
});

// ----- SEARCH ROUTE -----

app.get('/api/search', async (req, res) => {
    try {
        const query = req.query.q || req.query.query;
        
        if (!query || query.trim().length < 2) {
            return res.status(400).json({ error: 'Search query too short' });
        }
        
        const cacheKey = getCacheKey('search', { q: query });
        const cached = getCached(cacheKey);
        
        if (cached) {
            return res.json(cached);
        }
        
        const data = await scrapeSearch(query);
        setCached(cacheKey, data);
        res.json(data);
        
    } catch (error) {
        console.error('❌ Search API error:', error.message);
        res.status(500).json({ error: 'Search failed' });
    }
});

// ===== VIDEO BY URL ROUTE (MUST COME FIRST!) =====
app.get('/api/video/by-url', async (req, res) => {
    const t0 = Date.now();
    try {
        const incomingUrl = req.query.url;

        debugLog('━━━━━━━━━━ /api/video/by-url ━━━━━━━━━━');
        debugLog('Incoming url param:', incomingUrl);

        if (!incomingUrl) {
            return res.status(400).json({ error: 'Video URL required' });
        }

        const details = await getVideoDetailsByUrl(String(incomingUrl));
        debugLog('Cleaned URL:', details.url);

        debugLog(`✅ Responding in ${Date.now() - t0}ms | id=${details.id} | video=${describeMediaUrl(details.videoUrl)}`);

        // Test the CDN link in the background (does not delay the response).
        if (DEBUG_MODE && details.videoUrl && details.videoUrl !== '#') {
            probeMediaUrl(details.videoUrl).catch(() => {});
        }

        res.json(details);

    } catch (error) {
        console.error('❌ Video by URL error:', error.message);
        debugLog(`❌ by-url FAILED after ${Date.now() - t0}ms: ${error.message}`);
        const body = { error: 'Failed to load video' };
        if (DEBUG_MODE) {
            body.reason = error.response && error.response.status
                ? `source site answered HTTP ${error.response.status}`
                : error.message;
        }
        res.status(error.status || 500).json(body);
    }
});

// ===== DEBUG ROUTE: /api/debug/video?url=<video page url> (only when DEBUG_MODE) =====
app.get('/api/debug/video', async (req, res) => {
    if (!DEBUG_MODE) return res.status(404).json({ error: 'Not found' });

    const report = { ok: false };
    try {
        let videoUrl = req.query.url;
        if (!videoUrl) return res.status(400).json({ error: 'url required' });

        videoUrl = cleanUrlForScraping(videoUrl);
        report.cleanedUrl = videoUrl;

        if (!isSupportedHost(videoUrl)) {
            return res.status(400).json({ error: 'Unsupported video domain', cleanedUrl: videoUrl, supported: SUPPORTED_DOMAINS });
        }

        const info = {};
        const html = await fetchVideoPage(videoUrl, info);
        report.fetch = info;
        report.pageTitle = (String(html).match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || null;
        report.hasJsonLd = /application\/ld\+json/.test(html);

        const details = scrapeVideoDetails(html);
        report.hasVideoUrl = !!(details.videoUrl && details.videoUrl !== '#');
        report.video = describeMediaUrl(details.videoUrl);
        report.title = details.title;
        report.relatedCount = details.relatedVideos.length;
        report.relatedSample = details.relatedVideos.slice(0, 2).map(v => v.url);

        if (report.hasVideoUrl) {
            report.cdnProbe = await probeMediaUrl(details.videoUrl);
        }
        report.ok = true;
        res.json(report);
    } catch (error) {
        report.error = error.message;
        report.httpStatus = error.response && error.response.status;
        res.status(500).json(report);
    }
});

// ----- VIDEO DETAILS ROUTE (FALLBACK - COMES AFTER) -----
app.get('/api/video/:id', async (req, res) => {
    try {
        const videoId = req.params.id;
        
        if (!videoId) {
            return res.status(400).json({ error: 'Video ID required' });
        }
        
        const cacheKey = getCacheKey('video', { id: videoId });
        const cached = getCached(cacheKey);
        
        if (cached) {
            return res.json(cached);
        }
        
        const data = await scrapeVideo(videoId);
        setCached(cacheKey, data);
        res.json(data);
        
    } catch (error) {
        console.error('❌ Video API error:', error.message);
        res.status(500).json({ error: 'Failed to load video' });
    }
});

// ----- STREAM ROUTE -----

app.get('/api/stream/:id', async (req, res) => {
    try {
        const videoId = req.params.id;
        
        if (!videoId) {
            return res.status(400).json({ error: 'Video ID required' });
        }
        
        await streamVideo(videoId, res);
        
    } catch (error) {
        console.error('❌ Stream error:', error.message);
        res.status(500).json({ error: 'Stream failed' });
    }
});

// ----- DOWNLOAD ROUTE -----

app.get('/api/download/:id', async (req, res) => {
    try {
        const videoId = req.params.id;
        
        if (!videoId) {
            return res.status(400).json({ error: 'Video ID required' });
        }
        
        await downloadVideo(videoId, res);
        
    } catch (error) {
        console.error('❌ Download error:', error.message);
        res.status(500).json({ error: 'Download failed' });
    }
});

// ----- CLEAR CACHE ROUTE -----

app.post('/api/clear-cache', (req, res) => {
    try {
        clearCache();
        res.json({ success: true, message: 'Cache cleared' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to clear cache' });
    }
});

// ----- CACHE STATUS ROUTE -----

app.get('/api/cache-status', (req, res) => {
    const status = {
        size: cache.size,
        entries: Array.from(cache.keys()),
        ttl: CACHE.TTL / 60000 + ' minutes'
    };
    res.json(status);
});

// ============================================
// 9. 📄 STATIC PAGE ROUTES
// ============================================

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/video', (req, res) => {
    res.sendFile(path.join(__dirname, 'video.html'));
});

app.get('/api-docs', (req, res) => {
    res.sendFile(path.join(__dirname, 'api.html'));
});

// Catch-all for SPA support
app.get('*', (req, res) => {
    // If requesting a file that exists, serve it
    const filePath = path.join(__dirname, req.path);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        return res.sendFile(filePath);
    }
    // Otherwise, redirect to home
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ============================================
// 10. ⚠️ ERROR HANDLING
// ============================================

// ----- 404 Handler -----

app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// ----- Global Error Handler -----

app.use((err, req, res, next) => {
    console.error('❌ Server error:', err.stack || err.message);
    res.status(500).json({
        error: 'Internal server error',
        message: err.message
    });
});

// ----- Unhandled Rejection Handler -----

process.on('unhandledRejection', (err) => {
    console.error('❌ Unhandled rejection:', err);
});

// ----- Uncaught Exception Handler -----

process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught exception:', err);
    process.exit(1);
});

// ============================================
// 11. 🚀 SERVER STARTUP
// ============================================

function startServer() {
    // Ensure directories exist
    ensureDirectories();
    
    // Start server
    app.listen(PORT, () => {
        console.log('============================================');
        console.log('🔥 THE GENESIS - ANIME DOWNLOADER');
        console.log('============================================');
        console.log(`🚀 Server running on port: ${PORT}`);
        console.log(`📚 Started at: ${new Date().toISOString()}`);
        console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
        console.log(`📦 Cache TTL: ${CACHE.TTL / 60000} minutes`);
        console.log('🚦 API limits: 40 requests/minute + 2,500 requests/hour per IP');
        console.log('📖 API docs: /api-docs');
        console.log(`💾 Cache entries: ${cache.size}`);
        console.log('--------------------------------------------');
        console.log('⚙️  Config (env or default):');
        console.log(`   BASE_URL     [${_BASE.source}]: ${URLS.BASE}`);
        console.log(`   SEARCH_URL   [${_SEARCH.source}]: ${URLS.SEARCH}`);
        console.log(`   VIDEO_URL    [${_VIDEO.source}]: ${URLS.VIDEO}`);
        console.log(`   API_URL      [${_API.source}]: ${URLS.API}`);
        console.log(`   DOMAINS      [${_DOMAINS.source}]: ${SUPPORTED_DOMAINS.join(', ')}`);
        console.log(`   HOST_REWRITES[${_REWRITES.source}]: ${HOST_REWRITES.map(p => p.join('=')).join(', ')}`);
        console.log(`   DOMAIN CHECK: ${ENFORCE_DOMAIN_CHECK ? 'ON' : 'off'}`);
        console.log(`   DEBUG_MODE:   ${DEBUG_MODE ? 'ON (video logs + /api/debug/video)' : 'off'}`);
        console.log('============================================');
        console.log('📖 Available routes:');
        console.log('   GET  /ping or /health         - Health check');
        console.log('   GET  /api/home       - Homepage videos');
        console.log('   GET  /api/search     - Search videos');
        console.log('   GET  /api/video/:id  - Video details');
        console.log('   GET  /api/stream/:id - Stream video');
        console.log('   GET  /api/download/:id - Download video');
        console.log('   POST /api/clear-cache - Clear cache');
        console.log('============================================');
        console.log('👨‍💻 By Dev Zikky Tech');
        console.log('============================================');
    });
}

// Start the server
startServer();




