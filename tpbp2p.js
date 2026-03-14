// The Pirate Bay Addon - Premiumize + Magnet (Combined Worker)
// With key: Premiumize DirectDL instant streams
// Without key: P2P magnet links

const TMDB_API_KEY = 'f051e7366c6105ad4f9aafe4733d9dae';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const fileCache = new Map();
const CACHE_TTL = 1800000;

// ============================================
// PREMIUMIZE DIRECTDL
// ============================================
class Premiumize {
    constructor(apiKey) {
        this.apiKey = apiKey.replace('pr=', '');
        this.baseUrl = 'https://www.premiumize.me/api';
        this.batchSize = 99;
    }

    async checkCacheStatuses(hashes) {
        try {
            const results = {};
            const batches = [];
            for (let i = 0; i < hashes.length; i += this.batchSize) {
                batches.push(hashes.slice(i, i + this.batchSize));
            }
            for (let i = 0; i < batches.length; i++) {
                const batch = batches[i];
                const params = new URLSearchParams();
                batch.forEach(h => params.append('items[]', h));
                const data = await this.makeRequest('GET', `/cache/check?${params}`);
                batch.forEach((hash, idx) => {
                    results[hash] = { cached: data.response[idx], service: 'Premiumize' };
                });
                if (i < batches.length - 1) await new Promise(r => setTimeout(r, 500));
            }
            return results;
        } catch (e) {
            console.error('❌ Cache check failed:', e);
            return {};
        }
    }

    async getFileList(magnetLink) {
        const hash = extractInfoHash(magnetLink);
        const cacheKey = `files:${hash}`;
        if (fileCache.has(cacheKey)) {
            const cached = fileCache.get(cacheKey);
            if (Date.now() - cached.timestamp < CACHE_TTL) return cached.data;
            fileCache.delete(cacheKey);
        }
        try {
            const formData = new URLSearchParams();
            formData.append('src', magnetLink);
            formData.append('apikey', this.apiKey);
            const data = await this.makeRequest('POST', '/transfer/directdl', {
                body: formData,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });
            const files = (data.content || []).map(file => ({
                path: file.path,
                size: file.size,
                link: file.link,
                isVideo: /\.(mkv|mp4|avi|mov|wmv|m4v|webm)$/i.test(file.path),
                isSubtitle: /\.(srt|sub|ass|ssa|vtt)$/i.test(file.path),
                extension: file.path.split('.').pop().toLowerCase()
            }));
            fileCache.set(cacheKey, { data: files, timestamp: Date.now() });
            console.log(`📂 Found ${files.length} files (${files.filter(f => f.isVideo).length} videos)`);
            return files;
        } catch (e) {
            console.error('❌ getFileList failed:', e);
            return [];
        }
    }

    async makeRequest(method, path, opts = {}) {
        const retries = 3;
        let lastError;
        for (let i = 0; i < retries; i++) {
            try {
                const url = `${this.baseUrl}${path}`;
                const finalUrl = method === 'GET'
                    ? `${url}${url.includes('?') ? '&' : '?'}apikey=${this.apiKey}`
                    : url;
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 30000);
                const response = await fetch(finalUrl, { ...opts, method, signal: controller.signal });
                clearTimeout(timeout);
                const data = await response.json();
                if (data.status === 'error') throw new Error(`API Error: ${data.message}`);
                return data;
            } catch (e) {
                lastError = e;
                if (i < retries - 1) await new Promise(r => setTimeout(r, 2000));
            }
        }
        throw lastError;
    }
}

// ============================================
// SMART FILE SELECTION
// ============================================
class FileSelector {
    static findBestMovieFile(files) {
        const videoFiles = files.filter(f => f.isVideo);
        if (!videoFiles.length) return null;
        const scored = videoFiles.map(f => ({ ...f, score: this.scoreMovieFile(f) }));
        scored.sort((a, b) => b.score - a.score);
        return scored[0];
    }

    static scoreMovieFile(file) {
        const filename = file.path.toLowerCase();
        let score = 100;
        const sizeMB = file.size / (1024 * 1024);
        if (sizeMB > 500)  score += 300;
        if (sizeMB > 1000) score += 200;
        if (sizeMB > 2000) score += 150;
        if (sizeMB > 5000) score += 100;
        const bad = ['sample','trailer','preview','extras','bonus','deleted','behind','making','interview','featurette'];
        if (bad.some(kw => filename.includes(kw))) score -= 800;
        if (file.extension === 'mkv') score += 50;
        if (file.extension === 'mp4') score += 40;
        if (file.path.split('/').length <= 2) score += 100;
        return score;
    }

    static findEpisodeFile(files, season, episode) {
        for (const file of files.filter(f => f.isVideo)) {
            const match = file.path.match(/s(\d{1,2})e(\d{1,2})/i);
            if (match && parseInt(match[1]) === season && parseInt(match[2]) === episode) return file;
        }
        return null;
    }

    static extractMetadata(filename) {
        const name = filename.toLowerCase();
        const metadata = { quality: this.extractQuality(name), hdr: [], codec: null, audio: null };
        if (/hdr10\+/i.test(name)) metadata.hdr.push('HDR10+');
        else if (/hdr10/i.test(name)) metadata.hdr.push('HDR10');
        if (/dolby.?vision|dv/i.test(name)) metadata.hdr.push('DV');
        if (/[hx].?265|hevc/i.test(name)) metadata.codec = 'HEVC';
        else if (/[hx].?264|avc/i.test(name)) metadata.codec = 'H.264';
        else if (/av1/i.test(name)) metadata.codec = 'AV1';
        if (/atmos/i.test(name)) metadata.audio = 'Atmos';
        else if (/7\.1/i.test(name)) metadata.audio = '7.1';
        else if (/5\.1/i.test(name)) metadata.audio = '5.1';
        return metadata;
    }

    static extractQuality(text) {
        if (/2160p|4k|uhd/i.test(text)) return '4K';
        if (/1080p/i.test(text)) return '1080p';
        if (/720p/i.test(text)) return '720p';
        if (/480p/i.test(text)) return '480p';
        return 'SD';
    }
}

// ============================================
// HELPERS
// ============================================
function extractInfoHash(magnetLink) {
    const match = magnetLink?.match(/btih:([a-fA-F0-9]{40})/i);
    return match ? match[1].toUpperCase() : null;
}

function formatFileSize(bytes) {
    if (!bytes) return '';
    const gb = bytes / (1024 ** 3);
    return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / (1024 ** 2)).toFixed(0)} MB`;
}

function buildMagnetLink(infoHash, title) {
    return `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}`;
}

function getQualityScore(quality, size = 0) {
    const q = String(quality || '').toLowerCase();
    let score = 0;
    if (q.includes('2160') || q.includes('4k') || q.includes('uhd')) score += 1000;
    else if (q.includes('1080')) score += 800;
    else if (q.includes('720'))  score += 600;
    else if (q.includes('480'))  score += 400;
    else score += 200;
    if (q.includes('remux'))   score += 200;
    if (q.includes('bluray') || q.includes('blu-ray')) score += 100;
    if (q.includes('webrip') || q.includes('web-dl'))  score += 50;
    if (q.includes('hdr'))    score += 75;
    if (q.includes('x265') || q.includes('hevc')) score += 25;
    return score;
}

function extractQuality(title) {
    const m = title?.match(/\b(2160p|1080p|720p|4k|uhd|WEBRip|BluRay|REMUX|web-dl|webrip)\b/i);
    return m ? m[1] : '';
}

function formatSize(bytes) {
    if (!bytes || isNaN(bytes)) return 'Unknown';
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    if (bytes === 0) return '0 B';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
}

function matchesEpisode(title, season, episode) {
    const s = season.padStart(2, '0');
    const e = episode.padStart(2, '0');
    return [
        `S${s}\\s*[.-]?\\s*E${e}\\b`,
        `S${s}\\s*${e}\\b`,
        `\\b${s}x${e}\\b`,
        `\\b${parseInt(s)}x${parseInt(e)}\\b`
    ].some(p => new RegExp(p, 'i').test(title));
}

function extractImdbId(id) {
    if (id.startsWith('tt')) return id;
    if (id.match(/^\d+$/)) return `tt${id}`;
    return null;
}

async function getTMDBDetails(imdbId) {
    try {
        const res = await fetch(`${TMDB_BASE_URL}/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`);
        if (!res.ok) throw new Error(`TMDB error: ${res.status}`);
        const data = await res.json();
        if (data.movie_results?.[0]) {
            const m = data.movie_results[0];
            return { title: m.title, year: new Date(m.release_date).getFullYear(), type: 'movie' };
        }
        if (data.tv_results?.[0]) {
            const s = data.tv_results[0];
            return { title: s.name, year: new Date(s.first_air_date).getFullYear(), type: 'series' };
        }
        return null;
    } catch (e) {
        console.error('TMDB error:', e);
        return null;
    }
}

async function fetchTPBResults(searchQuery, type = 'movie') {
    const cacheKey = `${searchQuery}-${type}`;
    if (fileCache.has(cacheKey)) {
        const cached = fileCache.get(cacheKey);
        if (Date.now() - cached.timestamp < CACHE_TTL) return cached.data;
        fileCache.delete(cacheKey);
    }
    try {
        const res = await fetch(`https://apibay.org/q.php?q=${encodeURIComponent(searchQuery)}&cat=0`, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
        });
        if (!res.ok) throw new Error(`APIBay failed: ${res.status}`);
        const results = await res.json();
        if (!Array.isArray(results) || !results.length || results[0].id === '0') return [];

        const streams = results.map(item => {
            const hash = item.info_hash.toUpperCase();
            const quality = extractQuality(item.name);
            return {
                title: item.name,
                quality,
                size: formatSize(parseInt(item.size, 10)),
                seeders: parseInt(item.seeders || '0', 10),
                leechers: parseInt(item.leechers || '0', 10),
                infoHash: hash,
                rawSize: parseInt(item.size, 10) || 0,
                qualityScore: getQualityScore(quality, parseInt(item.size, 10))
            };
        }).filter(Boolean);

        streams.sort((a, b) => {
            const qd = b.qualityScore - a.qualityScore;
            return qd !== 0 ? qd : b.rawSize - a.rawSize;
        });

        fileCache.set(cacheKey, { data: streams, timestamp: Date.now() });
        return streams;
    } catch (e) {
        console.error('APIBay error:', e);
        return [];
    }
}

// ============================================
// CONFIGURATOR UI
// ============================================
const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TPB Addon Configurator</title>
    <style>
        :root {
            --bg-dark: #0c0c0c;
            --bg-card: #121212;
            --bg-card-hover: #1a1a1a;
            --border: #2a2a2a;
            --text-primary: #d0d0d0;
            --text-secondary: #888888;
            --text-muted: #666666;
            --accent-primary: #3a506b;
            --accent-primary-hover: #4a6080;
            --accent-success: #2d6a4f;
            --accent-pm: #7c3aed;
            --accent-pm-hover: #8b5cf6;
        }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: var(--bg-dark); color: var(--text-primary);
            line-height: 1.6; min-height: 100vh; padding: 20px;
        }
        .container { max-width: 800px; margin: 0 auto; }
        .header { text-align: center; margin-bottom: 40px; padding-bottom: 30px; border-bottom: 1px solid var(--border); }
        .logo { font-size: 3.5rem; margin-bottom: 20px; }
        h1 { font-size: 2rem; font-weight: 300; margin-bottom: 10px; }
        .subtitle { color: var(--text-secondary); font-size: 0.95rem; margin: 10px auto; }
        .card {
            background: var(--bg-card); border: 1px solid var(--border);
            border-radius: 8px; padding: 30px; margin-bottom: 20px;
            transition: all 0.3s ease;
        }
        .card:hover { background: var(--bg-card-hover); }
        .card h2 { font-size: 1.3rem; font-weight: 500; margin-bottom: 15px; display: flex; align-items: center; gap: 10px; }
        .card p { color: var(--text-secondary); margin-bottom: 15px; line-height: 1.7; }
        .input-group { margin-bottom: 20px; }
        .input-group label { display: block; margin-bottom: 8px; font-size: 0.9rem; color: var(--text-secondary); }
        .input-group input {
            width: 100%; padding: 12px; border-radius: 6px;
            border: 1px solid var(--border); background: var(--bg-dark);
            color: var(--text-primary); font-size: 0.95rem; font-family: monospace;
            outline: none; transition: border-color 0.2s;
        }
        .input-group input:focus { border-color: var(--accent-pm); }
        .input-group input::placeholder { color: var(--text-muted); }
        .btn {
            display: inline-flex; align-items: center; gap: 8px;
            padding: 12px 24px; border-radius: 6px; font-weight: 500;
            cursor: pointer; border: none; font-size: 0.95rem;
            transition: all 0.2s ease; margin-right: 10px; margin-bottom: 10px;
        }
        .btn-primary { background: var(--accent-success); color: var(--text-primary); }
        .btn-primary:hover { background: #347c5a; transform: translateY(-1px); }
        .btn-pm { background: var(--accent-pm); color: #fff; }
        .btn-pm:hover { background: var(--accent-pm-hover); transform: translateY(-1px); }
        .btn-secondary { background: var(--accent-primary); color: var(--text-primary); }
        .btn-secondary:hover { background: var(--accent-primary-hover); }
        .code-block {
            background: var(--bg-dark); border: 1px solid var(--border);
            border-radius: 4px; padding: 15px; margin: 15px 0;
            font-family: monospace; font-size: 0.9rem;
            color: var(--text-primary); overflow-x: auto; position: relative;
            word-break: break-all;
        }
        .copy-btn {
            position: absolute; top: 10px; right: 10px;
            background: var(--bg-card); border: 1px solid var(--border);
            color: var(--text-secondary); padding: 4px 10px;
            border-radius: 3px; cursor: pointer; font-size: 0.8rem;
        }
        .copy-btn:hover { background: var(--bg-card-hover); color: var(--text-primary); }
        .info-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-top: 20px; }
        .info-item { display: flex; flex-direction: column; gap: 5px; }
        .info-label { color: var(--text-secondary); font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.5px; }
        .info-value { color: var(--text-primary); font-family: monospace; font-size: 0.95rem; }
        .text-success { color: var(--accent-success); }
        .text-pm { color: #a78bfa; }
        .alert { border-radius: 6px; padding: 15px; margin-bottom: 20px; font-size: 0.9rem; }
        .alert-info { background: rgba(58, 80, 107, 0.15); border: 1px solid rgba(58, 80, 107, 0.4); color: #94a3b8; }
        .alert-pm  { background: rgba(124, 58, 237, 0.1); border: 1px solid rgba(124, 58, 237, 0.3); color: #c4b5fd; }
        .mode-badge { display: inline-block; padding: 4px 10px; border-radius: 20px; font-size: 0.8rem; font-weight: 600; margin-bottom: 15px; }
        .badge-magnet { background: rgba(45, 106, 79, 0.2); color: #6ee7b7; border: 1px solid rgba(45,106,79,0.4); }
        .badge-pm { background: rgba(124, 58, 237, 0.2); color: #a78bfa; border: 1px solid rgba(124,58,237,0.4); }
        #resultSection { display: none; }
        .footer { text-align: center; margin-top: 40px; padding-top: 20px; border-top: 1px solid var(--border); color: var(--text-muted); font-size: 0.85rem; }
        .status-toast { position: fixed; bottom: 20px; right: 20px; background: var(--bg-card); border: 1px solid var(--border); border-radius: 6px; padding: 12px 20px; display: none; box-shadow: 0 5px 20px rgba(0,0,0,0.5); z-index: 1000; }
        @media (max-width: 768px) { h1 { font-size: 1.5rem; } .card { padding: 20px; } .btn { width: 100%; justify-content: center; margin: 5px 0; } }
    </style>
</head>
<body>
<div class="container">
    <header class="header">
        <div class="logo">🏴‍☠️</div>
        <h1>TPB Addon Configurator</h1>
        <p class="subtitle">Optional Premiumize support for instant cached streams, or use free P2P magnet links.</p>
    </header>

    <div class="card">
        <h2>🔑 Premiumize Key <small style="font-size:0.75rem;color:var(--text-muted);font-weight:400">(optional)</small></h2>
        <div class="alert alert-pm">
            <strong>⚡ With Premiumize:</strong> Cached torrents served as instant direct streams — no seeding required.<br>
            <strong>🧲 Without Premiumize:</strong> Pure P2P magnet links (needs Stremio or a torrent client).
        </div>
        <div class="input-group">
            <label>Premiumize API Key</label>
            <input type="password" id="pmKey" placeholder="pr=your_key_here  (or leave blank for magnet mode)">
        </div>
        <button class="btn btn-pm" onclick="generateUrl()">⚡ Generate with Premiumize</button>
        <button class="btn btn-primary" onclick="generateMagnetUrl()">🧲 Generate Magnet Only</button>
    </div>

    <div class="card" id="resultSection">
        <h2>✅ Addon URL</h2>
        <div id="modeDisplay"></div>
        <div class="alert alert-info">
            Copy the URL below and paste it into Stremio → Addons → Install from URL
        </div>
        <div class="code-block">
            <span id="manifestUrl"></span>
            <button class="copy-btn" onclick="copyUrl()">Copy</button>
        </div>
        <div class="info-grid">
            <div class="info-item">
                <span class="info-label">Source</span>
                <span class="info-value">The Pirate Bay</span>
            </div>
            <div class="info-item">
                <span class="info-label">Mode</span>
                <span class="info-value" id="modeText">—</span>
            </div>
            <div class="info-item">
                <span class="info-label">Content</span>
                <span class="info-value">Movies &amp; TV</span>
            </div>
        </div>
    </div>

    <footer class="footer">
        <p>TPB Addon • v4.0.0 • Premiumize + P2P</p>
    </footer>
</div>

<div id="statusToast" class="status-toast"><span id="statusText">Copied!</span></div>

<script>
    function generateUrl() {
        const key = document.getElementById('pmKey').value.trim();
        const base = window.location.origin;
        const url = key ? base + '/manifest.json?key=' + encodeURIComponent(key) : base + '/manifest.json';
        showResult(url, !!key);
    }
    function generateMagnetUrl() {
        const base = window.location.origin;
        showResult(base + '/manifest.json', false);
    }
    function showResult(url, hasPm) {
        document.getElementById('manifestUrl').textContent = url;
        document.getElementById('modeText').textContent = hasPm ? '⚡ Premiumize DirectDL' : '🧲 Magnet Links';
        const badge = document.getElementById('modeDisplay');
        badge.innerHTML = hasPm
            ? '<span class="mode-badge badge-pm">⚡ Premiumize DirectDL — instant cached streams</span>'
            : '<span class="mode-badge badge-magnet">🧲 Magnet — pure P2P, no account needed</span>';
        document.getElementById('resultSection').style.display = 'block';
        document.getElementById('resultSection').scrollIntoView({ behavior: 'smooth' });
    }
    function copyUrl() {
        const url = document.getElementById('manifestUrl').textContent;
        navigator.clipboard.writeText(url).then(() => showToast('✅ Copied!'));
    }
    function showToast(msg) {
        const toast = document.getElementById('statusToast');
        document.getElementById('statusText').textContent = msg;
        toast.style.display = 'block';
        setTimeout(() => toast.style.display = 'none', 3000);
    }
<\/script>
</body>
</html>`;

// ============================================
// MAIN HANDLER
// ============================================
export default {
    async fetch(request, env, ctx) {
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        };

        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        const url = new URL(request.url);

        // Config: optional Premiumize key via query param
        const apikey = url.searchParams.get('key') || '';
        const hasPremiumize = apikey.trim() !== '';

        // ROOT: Configurator UI
        if (url.pathname === '/' || url.pathname === '') {
            return new Response(HTML_PAGE, {
                headers: { 'Content-Type': 'text/html', ...corsHeaders }
            });
        }

        // MANIFEST
        if (url.pathname === '/manifest.json') {
            const manifest = {
                id: hasPremiumize ? 'org.tpb.pm.bridge' : 'org.apibay.p2p',
                version: '4.0.0',
                name: hasPremiumize ? 'TPB ⚡ Premiumize' : 'TPB 🧲 P2P',
                description: hasPremiumize
                    ? 'The Pirate Bay with Premiumize DirectDL — cached torrents as instant streams.'
                    : 'The Pirate Bay — pure P2P magnet links.',
                resources: ['stream'],
                types: ['movie', 'series'],
                idPrefixes: ['tt'],
                catalogs: [],
                behaviorHints: { configurable: true, configurationRequired: false }
            };
            return new Response(JSON.stringify(manifest), {
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
        }

        // STREAMS
        if (url.pathname.startsWith('/stream/')) {
            try {
                const pathParts = url.pathname.split('/');
                const type = pathParts[2];
                let id = pathParts[3];
                if (id.endsWith('.json')) id = id.slice(0, -5);
                id = decodeURIComponent(id);

                let imdbId = id;
                let season, episode;

                if (type === 'series') {
                    const parts = id.split(':');
                    imdbId = parts[0];
                    season = parts[1];
                    episode = parts[2];
                    if (!season || !episode) {
                        return new Response(JSON.stringify({ streams: [] }), {
                            headers: { 'Content-Type': 'application/json', ...corsHeaders }
                        });
                    }
                }

                const cleanImdbId = extractImdbId(imdbId);
                if (!cleanImdbId) {
                    return new Response(JSON.stringify({ streams: [] }), {
                        headers: { 'Content-Type': 'application/json', ...corsHeaders }
                    });
                }

                const mediaDetails = await getTMDBDetails(cleanImdbId);
                if (!mediaDetails) {
                    return new Response(JSON.stringify({ streams: [] }), {
                        headers: { 'Content-Type': 'application/json', ...corsHeaders }
                    });
                }

                let searchQuery = `${mediaDetails.title} ${mediaDetails.year}`;
                if (type === 'series') {
                    searchQuery += ` S${season.padStart(2, '0')}E${episode.padStart(2, '0')}`;
                }

                console.log(`\n🎬 ${type} - ${mediaDetails.title} | Mode: ${hasPremiumize ? 'Premiumize' : 'Magnet'}`);

                let torrents = await fetchTPBResults(searchQuery, type);
                if (type === 'series' && season && episode) {
                    torrents = torrents.filter(t => matchesEpisode(t.title, season, episode));
                }

                if (!torrents.length) {
                    return new Response(JSON.stringify({ streams: [] }), {
                        headers: { 'Content-Type': 'application/json', ...corsHeaders }
                    });
                }

                const streams = [];

                if (hasPremiumize) {
                    // ── PREMIUMIZE DIRECTDL PATH ──
                    const premiumize = new Premiumize(apikey);
                    const hashes = torrents.map(t => t.infoHash).filter(Boolean);
                    const cacheResults = await premiumize.checkCacheStatuses(hashes);
                    const cachedTorrents = torrents.filter(t => t.infoHash && cacheResults[t.infoHash]?.cached);

                    console.log(`✅ ${cachedTorrents.length}/${torrents.length} cached on Premiumize`);

                    for (const torrent of cachedTorrents.slice(0, 10)) {
                        try {
                            const magnetLink = buildMagnetLink(torrent.infoHash, torrent.title);
                            const files = await premiumize.getFileList(magnetLink);
                            if (!files.length) continue;

                            let selectedFile;
                            if (type === 'movie') {
                                selectedFile = FileSelector.findBestMovieFile(files);
                            } else {
                                selectedFile = FileSelector.findEpisodeFile(files, parseInt(season), parseInt(episode));
                            }
                            if (!selectedFile) continue;

                            const metadata = FileSelector.extractMetadata(selectedFile.path);
                            const fileSize = formatFileSize(selectedFile.size);
                            const techSpecs = [metadata.codec, metadata.audio].filter(Boolean).join(' • ');

                            const streamName = [
                                metadata.quality,
                                metadata.hdr.length ? metadata.hdr.join('+') : null,
                                fileSize,
                                '⚡ Cached'
                            ].filter(Boolean).join(' | ');

                            const titleLines = [
                                `🎬 ${mediaDetails.title} (${mediaDetails.year})`,
                                ``,
                                `📺 Quality: ${metadata.quality}${metadata.hdr.length ? ` ${metadata.hdr.join('+')}` : ''}`,
                                techSpecs ? `🔧 ${techSpecs}` : null,
                                `💾 Size: ${fileSize}`,
                                ``,
                                `📁 ${selectedFile.path.split('/').pop()}`,
                                `🏴‍☠️ Source: TPB`,
                                ``,
                                `⚡ Cached on Premiumize — instant playback!`
                            ].filter(Boolean);

                            streams.push({
                                name: streamName,
                                title: titleLines.join('\n'),
                                url: selectedFile.link,
                                behaviorHints: {
                                    filename: selectedFile.path.split('/').pop(),
                                    bingeGroup: `tpb-${torrent.infoHash}`
                                }
                            });

                            console.log(`✅ PM stream: ${streamName}`);
                        } catch (e) {
                            console.error('❌ Error processing torrent:', e);
                        }
                    }
                } else {
                    // ── MAGNET FALLBACK PATH ──
                    console.log('🧲 No PM key — serving magnet links');

                    for (const torrent of torrents.slice(0, 100)) {
                        const qualityDisplay = (torrent.quality || 'Unknown').toUpperCase();
                        let qIcon = '🎬';
                        if (qualityDisplay.includes('2160') || qualityDisplay.includes('4K')) qIcon = '🔥';
                        else if (qualityDisplay.includes('1080')) qIcon = '⭐';
                        else if (qualityDisplay.includes('720'))  qIcon = '✅';

                        let seedIcon = '🌱';
                        if (torrent.seeders > 100) seedIcon = '🔥';
                        else if (torrent.seeders > 50) seedIcon = '⚡';
                        else if (torrent.seeders > 20) seedIcon = '✅';

                        streams.push({
                            infoHash: torrent.infoHash,
                            fileIdx: 0,
                            name: `${seedIcon} ${qIcon} ${qualityDisplay} | ${torrent.size} | 👥 ${torrent.seeders} | TPB`,
                            title: `${torrent.title}\n\n📺 Quality: ${qualityDisplay}\n💾 Size: ${torrent.size}\n👥 Seeders: ${torrent.seeders} | Leechers: ${torrent.leechers}\n🏴‍☠️ Source: TPB\n🧲 P2P Magnet`
                        });
                    }
                }

                // Sort by quality
                streams.sort((a, b) => {
                    const order = { '4K': 4, '1080P': 3, '1080': 3, '720P': 2, '720': 2, '480P': 1 };
                    const getQ = name => {
                        for (const [k, v] of Object.entries(order)) if (name.toUpperCase().includes(k)) return v;
                        return 0;
                    };
                    const qd = getQ(b.name) - getQ(a.name);
                    if (qd !== 0) return qd;
                    // PM streams (have url) above magnets (have infoHash)
                    const pmA = !!a.url, pmB = !!b.url;
                    if (pmA && !pmB) return -1;
                    if (!pmA && pmB)  return 1;
                    return 0;
                });

                console.log(`🎉 Returning ${streams.length} streams`);
                return new Response(JSON.stringify({ streams }), {
                    headers: { 'Content-Type': 'application/json', ...corsHeaders }
                });

            } catch (e) {
                console.error('Stream error:', e);
                return new Response(JSON.stringify({ streams: [] }), {
                    headers: { 'Content-Type': 'application/json', ...corsHeaders }
                });
            }
        }

        return new Response('Not Found', { status: 404, headers: corsHeaders });
    }
};
