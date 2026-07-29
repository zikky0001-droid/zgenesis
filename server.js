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

const app = express();
const PORT = process.env.PORT || 10000;

// ============================================
// 2. ⚙️ GLOBAL CONFIGURATION & CONSTANTS
// ============================================

// ----- URL CONSTANTS -----
const URLS = {
    BASE: 'https://amp.thnxx.com/',
    SEARCH: 'https://amp.thnxx.com/search/',
    VIDEO: 'https://amp.thnxx.com/video-',
    API: 'https://api.mangadex.org'
};

// ----- SUPPORTED DOMAINS -----
const SUPPORTED_DOMAINS = [
    'thh.com',
    'thnxx.com', 
    'txnhh.com',
    'thxx.com'
];

// ----- CACHE CONSTANTS -----
const CACHE = {
    TTL: 15 * 60 * 1000,           // 15 minutes in milliseconds
    CLEANUP_INTERVAL: 5 * 60 * 1000 // Clean expired every 5 minutes
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
    MAX_FILE_SIZE: 100 * 1024 * 1024, // 100MB
    MAX_PAGES: 10
};

// ----- REQUEST HEADERS -----
const HEADERS = {
    USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ACCEPT: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    ACCEPT_LANGUAGE: 'en-US,en;q=0.9',
    ACCEPT_ENCODING: 'gzip, deflate, br'
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
        '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
        '&#039;': "'", '&nbsp;': ' ', '&ntilde;': 'ñ', '&Ntilde;': 'Ñ',
        '&aacute;': 'á', '&eacute;': 'é', '&iacute;': 'í', '&oacute;': 'ó',
        '&uacute;': 'ú', '&Aacute;': 'Á', '&Eacute;': 'É', '&Iacute;': 'Í',
        '&Oacute;': 'Ó', '&Uacute;': 'Ú', '&agrave;': 'à', '&egrave;': 'è',
        '&igrave;': 'ì', '&ograve;': 'ò', '&ugrave;': 'ù', '&ccedil;': 'ç',
        '&Ccedil;': 'Ç', '&szlig;': 'ß'
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
    if (!duration || duration === 'N/A') return 'N/A';
    
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
        
        // Extract video URL
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
        
        // Only add if we have a title
        if (title && title !== 'Untitled') {
            videos.push({
                id: getVideoIdFromUrl(videoUrl) || `video_${index}`,
                url: videoUrl || '#',
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
        duration: 'N/A',
        quality: 'N/A',
        rating: 'N/A',
        likes: '0',
        dislikes: '0',
        views: 'N/A',
        tags: [],
        thumbnail: '',
        videoUrl: '#',
        downloadUrl: '#',
        relatedVideos: []
    };
    
    // Extract title
    const titleMatch = html.match(/<div class="video-title">\s*<strong>([^<]+)<\/strong>/);
    if (titleMatch) {
        details.title = decodeText(titleMatch[1].trim());
    }
    
    // Extract uploader, duration, quality from metadata
    const metadataSpanMatch = html.match(/<span class="metadata">(.*?)<\/span>/s);
    if (metadataSpanMatch) {
        const metaContent = metadataSpanMatch[1];
        
        const uploaderMatch = metaContent.match(/<a class="gold-plate"[^>]*>([^<]+)<\/a>/);
        if (uploaderMatch) {
            details.uploader = decodeText(uploaderMatch[1].trim());
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
            
            // Extract video URL & download URL
            if (jsonData.contentUrl) {
                details.videoUrl = jsonData.contentUrl;
                
                if (jsonData.contentUrl.includes('&download=')) {
                    details.downloadUrl = jsonData.contentUrl;
                } else {
                    const baseMatch = jsonData.contentUrl.match(/(.*?)(\?secure=.*?)(?:&|$)/);
                    if (baseMatch) {
                        const base = baseMatch[1];
                        const securePart = baseMatch[2];
                        const filename = details.title
                            .toLowerCase()
                            .replace(/[^a-z0-9]/g, '_')
                            .replace(/_+/g, '_')
                            .trim();
                        details.downloadUrl = `${base}${securePart}&download=thnxx_${filename}_SD.mp4`;
                    }
                }
            }
        } catch (e) {
            console.error('JSON-LD parse error:', e.message);
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
    
    // Extract related videos
    const relatedMatch = html.match(/var video_related=\[(.*?)\];/s);
    if (relatedMatch) {
        try {
            const videoObjects = relatedMatch[1].match(/\{[^}]*\}/g);
            
            if (videoObjects) {
                for (const objStr of videoObjects) {
                    try {
                        const urlMatch = objStr.match(/"u":"([^"]+)"/);
                        const thumbMatch = objStr.match(/"i":"([^"]+)"/);
                        const titleMatch = objStr.match(/"t":"([^"]+)"/);
                        const durationMatch = objStr.match(/"d":"([^"]+)"/);
                        const viewsMatch = objStr.match(/"n":"([^"]+)"/);
                        const ratingMatch = objStr.match(/"r":"([^"]+)"/);
                        const uploaderMatch = objStr.match(/"p":"([^"]+)"/);
                        
                        if (titleMatch) {
                            let fullUrl = urlMatch ? urlMatch[1] : '#';
                            if (fullUrl && !fullUrl.startsWith('http')) {
                                fullUrl = `https://amp.thnxx.com${fullUrl}`;
                            }
                            
                            details.relatedVideos.push({
                                url: fullUrl,
                                thumbnail: thumbMatch ? thumbMatch[1] : '',
                                title: decodeText(titleMatch[1].trim()),
                                duration: durationMatch ? durationMatch[1] : 'N/A',
                                views: viewsMatch ? viewsMatch[1] : 'N/A',
                                rating: ratingMatch ? ratingMatch[1] : 'N/A',
                                uploader: uploaderMatch ? decodeText(uploaderMatch[1].trim()) : 'Unknown'
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
    
    return details;
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
        const html = await fetchPage(videoUrl);
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
        const html = await fetchPage(videoUrl);
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
            headers: HEADERS
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
            headers: HEADERS
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

// ----- HEALTH CHECK -----

app.get('/ping', (req, res) => {
    res.status(200).json({
        status: 'alive',
        timestamp: new Date().toISOString(),
        cacheSize: cache.size
    });
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

// ----- VIDEO DETAILS ROUTE -----

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
        console.log(`💾 Cache entries: ${cache.size}`);
        console.log('============================================');
        console.log('📖 Available routes:');
        console.log('   GET  /ping           - Health check');
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




