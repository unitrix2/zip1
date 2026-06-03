self.addEventListener('install', event => {
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(clients.claim());
});

const activeStreams = new Map();

self.addEventListener('message', event => {
    if (event.data.type === 'REGISTER_STREAM') {
        activeStreams.set(event.data.id, event.data.payload);
        if (event.ports && event.ports[0]) {
            event.ports[0].postMessage({ status: 'ok' });
        }
    }
});

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    
    // Intercepting via Query Params to ensure strict scope
    if (url.searchParams.has('sw_stream')) {
        const id = url.searchParams.get('sw_stream');
        const fileData = activeStreams.get(id);

        if (!fileData) {
            event.respondWith(new Response('Stream expired or Service Worker reset. Please reload the page.', { status: 404 }));
            return;
        }
        event.respondWith(handleStreamRequest(event.request, fileData, url.searchParams.get('dl') === '1'));
    }
});

async function handleStreamRequest(request, f, isDownload) {
    const rangeHeader = request.headers.get('Range');
    let start = 0;
    let end = f.size - 1;

    if (f.compression === 0 && rangeHeader) {
        const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if (match) {
            start = parseInt(match[1], 10);
            if (match[2]) end = parseInt(match[2], 10);
        }
    }

    let fetchStart = f.compression === 0 ? (f.dataStart + start) : f.dataStart;
    
    try {
        // ANTI-STUTTER FIX: Fetch open-ended range instead of exact bytes.
        // This prevents Cloudflare from throttling multiple small requests and lets the browser buffer natively.
        const fetchHeaders = new Headers();
        if (f.compression === 0) {
            fetchHeaders.set('Range', `bytes=${fetchStart}-`);
        } else {
            fetchHeaders.set('Range', `bytes=${f.dataStart}-${f.dataEnd}`);
        }

        const res = await fetch(f.zipUrl, { headers: fetchHeaders });
        if (!res.ok) throw new Error(`Server rejected request. Status: ${res.status}`);

        let stream = res.body;
        if (f.compression === 8) {
            stream = stream.pipeThrough(new DecompressionStream('deflate-raw'));
        }

        const responseHeaders = new Headers();
        responseHeaders.set('Access-Control-Allow-Origin', '*');

        if (isDownload) {
            responseHeaders.set('Content-Disposition', `attachment; filename="${encodeURIComponent(f.name)}"`);
            responseHeaders.set('Content-Type', 'application/octet-stream');
            responseHeaders.set('Content-Length', f.size.toString());
            return new Response(stream, { status: 200, headers: responseHeaders });
        } else {
            responseHeaders.set('Content-Type', getMimeType(f.name));
            responseHeaders.set('Accept-Ranges', f.compression === 0 ? 'bytes' : 'none');
            
            if (f.compression === 0 && rangeHeader) {
                // We fake the exact chunk response to satisfy the HTML5 player, 
                // but the underlying stream is continuously buffering.
                responseHeaders.set('Content-Range', `bytes ${start}-${end}/${f.size}`);
                responseHeaders.set('Content-Length', (end - start + 1).toString());
                return new Response(stream, { status: 206, headers: responseHeaders });
            } else {
                responseHeaders.set('Content-Length', f.size.toString());
                return new Response(stream, { status: 200, headers: responseHeaders });
            }
        }
    } catch(e) {
        console.error("SW Fetch Error:", e);
        return new Response(e.message, { status: 500 });
    }
}

function getMimeType(name) {
    const ext = name.split('.').pop().toLowerCase();
    const map = {
        'mp4': 'video/mp4', 'mkv': 'video/mp4', 'avi': 'video/mp4', 'webm': 'video/webm',
        'mp3': 'audio/mpeg', 'ogg': 'audio/ogg', 'wav': 'audio/wav',
        'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png', 'gif': 'image/gif', 'webp': 'image/webp',
        'pdf': 'application/pdf',
        'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'csv': 'text/csv',
        'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    };
    return map[ext] || 'application/octet-stream';
}
