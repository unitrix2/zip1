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
        // Acknowledge back to the main thread that the stream is ready
        if (event.ports && event.ports[0]) {
            event.ports[0].postMessage({ status: 'ok' });
        }
    }
});

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    if (url.pathname.startsWith('/__zip_stream/')) {
        const id = url.pathname.split('/')[2];
        const fileData = activeStreams.get(id);

        if (!fileData) {
            event.respondWith(new Response('Stream expired or not found.', { status: 404 }));
            return;
        }
        event.respondWith(handleStreamRequest(event.request, fileData, url.searchParams.has('dl')));
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
    let fetchEnd = f.compression === 0 ? (f.dataStart + end) : f.dataEnd;

    try {
        const res = await fetch(f.zipUrl, {
            headers: { 'Range': `bytes=${fetchStart}-${fetchEnd}` }
        });

        let stream = res.body;
        if (f.compression === 8) {
            stream = stream.pipeThrough(new DecompressionStream('deflate-raw'));
        }

        const headers = new Headers();
        headers.set('Access-Control-Allow-Origin', '*');

        if (isDownload) {
            headers.set('Content-Disposition', `attachment; filename="${encodeURIComponent(f.name)}"`);
            headers.set('Content-Type', 'application/octet-stream');
            headers.set('Content-Length', f.size.toString());
            return new Response(stream, { status: 200, headers });
        } else {
            headers.set('Content-Type', getMimeType(f.name));
            headers.set('Accept-Ranges', f.compression === 0 ? 'bytes' : 'none');
            
            if (f.compression === 0 && rangeHeader) {
                headers.set('Content-Range', `bytes ${start}-${end}/${f.size}`);
                headers.set('Content-Length', (end - start + 1).toString());
                return new Response(stream, { status: 206, headers });
            } else {
                headers.set('Content-Length', f.size.toString());
                return new Response(stream, { status: 200, headers });
            }
        }
    } catch(e) {
        return new Response(e.message, { status: 500 });
    }
}

function getMimeType(name) {
    const ext = name.split('.').pop().toLowerCase();
    const map = {
        'mp4': 'video/mp4',
        'webm': 'video/webm',
        // TRICK: WebM is a subset of Matroska. Spoofing MKV as WebM 
        // forces the browser's native parser to handle the video/audio track automatically.
        'mkv': 'video/webm',
        'avi': 'video/mp4',
        'mp3': 'audio/mpeg', 
        'ogg': 'audio/ogg', 
        'wav': 'audio/wav'
    };
    return map[ext] || 'application/octet-stream';
}
