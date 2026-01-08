import { Hono } from 'hono';
import { createClient } from '@libsql/client';
import { nanoid } from 'nanoid';
import type { HeadersInit } from 'bun';

// Define environment type
type Bindings = {
  TURSO_DATABASE_URL: string;
  TURSO_AUTH_TOKEN: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// Initialize database schema
async function initDB(url: string, authToken: string) {
  const turso = createClient({
    url,
    authToken,
  });
  
  await turso.execute(`
    CREATE TABLE IF NOT EXISTS urls (
      id TEXT PRIMARY KEY,
      original_url TEXT NOT NULL UNIQUE,
      content_type TEXT,
      content_length TEXT,
      filename TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    )
  `);
}

// HTML page
app.get('/', (c) => {
  return c.html(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Transload Service</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 16px;
      padding: 40px;
      max-width: 600px;
      width: 100%;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    }
    h1 {
      color: #333;
      margin-bottom: 10px;
      font-size: 28px;
    }
    .subtitle {
      color: #666;
      margin-bottom: 30px;
      font-size: 14px;
    }
    .input-group {
      margin-bottom: 20px;
    }
    label {
      display: block;
      margin-bottom: 8px;
      color: #555;
      font-weight: 500;
      font-size: 14px;
    }
    input[type="url"] {
      width: 100%;
      padding: 12px 16px;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      font-size: 15px;
      transition: border-color 0.3s;
    }
    input[type="url"]:focus {
      outline: none;
      border-color: #667eea;
    }
    button {
      width: 100%;
      padding: 14px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    button:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(102, 126, 234, 0.4);
    }
    button:active {
      transform: translateY(0);
    }
    button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
    }
    .result {
      margin-top: 30px;
      padding: 20px;
      background: #f8f9fa;
      border-radius: 8px;
      display: none;
    }
    .result.show {
      display: block;
      animation: slideIn 0.3s ease;
    }
    @keyframes slideIn {
      from { opacity: 0; transform: translateY(-10px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .result h3 {
      color: #333;
      margin-bottom: 15px;
      font-size: 18px;
    }
    .url-box {
      background: white;
      padding: 12px;
      border-radius: 6px;
      border: 2px solid #e0e0e0;
      word-break: break-all;
      font-family: 'Courier New', monospace;
      font-size: 13px;
      margin-bottom: 10px;
    }
    .copy-btn {
      width: auto;
      padding: 8px 16px;
      font-size: 14px;
      margin-top: 10px;
    }
    .info {
      margin-top: 15px;
      padding: 15px;
      background: #e3f2fd;
      border-left: 4px solid #2196f3;
      border-radius: 4px;
      font-size: 13px;
      color: #555;
    }
    .info code {
      background: white;
      padding: 2px 6px;
      border-radius: 3px;
      font-family: 'Courier New', monospace;
      color: #d63384;
    }
    .error {
      background: #ffebee;
      color: #c62828;
      padding: 12px;
      border-radius: 6px;
      margin-top: 15px;
      display: none;
    }
    .error.show {
      display: block;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>⚡ Transload Service</h1>
    <p class="subtitle">Stream any file through Cloudflare's fast servers</p>
    
    <form id="uploadForm">
      <div class="input-group">
        <label for="url">File URL</label>
        <input 
          type="url" 
          id="url" 
          name="url" 
          placeholder="https://example.com/file.zip"
          required
        />
      </div>
      <button type="submit" id="submitBtn">Generate Transload Link</button>
    </form>

    <div class="error" id="error"></div>

    <div class="result" id="result">
      <h3>✅ Transload Link Created</h3>
      <div class="url-box" id="transloadUrl"></div>
      <button class="copy-btn" onclick="copyUrl()">📋 Copy Link</button>
      
      <div class="info">
        <strong>Download with wget:</strong><br>
        <code id="wgetCmd"></code>
        <br><br>
        <strong>Download with aria2c:</strong><br>
        <code id="ariaCmd"></code>
      </div>
    </div>
  </div>

  <script>
    const form = document.getElementById('uploadForm');
    const submitBtn = document.getElementById('submitBtn');
    const result = document.getElementById('result');
    const error = document.getElementById('error');
    const transloadUrl = document.getElementById('transloadUrl');
    const wgetCmd = document.getElementById('wgetCmd');
    const ariaCmd = document.getElementById('ariaCmd');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const url = document.getElementById('url').value;
      submitBtn.disabled = true;
      submitBtn.textContent = 'Generating...';
      error.classList.remove('show');
      result.classList.remove('show');

      try {
        const response = await fetch('/api/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url })
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || 'Failed to create transload link');
        }

        const fullUrl = window.location.origin + data.download_url;
        transloadUrl.textContent = fullUrl;
        wgetCmd.textContent = \`wget "$\{fullUrl\}"\`;
        ariaCmd.textContent = \`aria2c "$\{fullUrl\}"\`;
        
        result.classList.add('show');
      } catch (err) {
        error.textContent = '❌ ' + err.message;
        error.classList.add('show');
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Generate Transload Link';
      }
    });

    function copyUrl() {
      const url = transloadUrl.textContent;
      navigator.clipboard.writeText(url).then(() => {
        const btn = event.target;
        const originalText = btn.textContent;
        btn.textContent = '✅ Copied!';
        setTimeout(() => {
          btn.textContent = originalText;
        }, 2000);
      });
    }
  </script>
</body>
</html>
  `);
});

// API: Create transload link
app.post('/api/create', async (c) => {
  try {
  
    // Get environment variables from context
    const turso = createClient({
      url: c.env.TURSO_DATABASE_URL,
      authToken: c.env.TURSO_AUTH_TOKEN,
    });

    const { url } = await c.req.json();

    if (!url || !url.startsWith('http')) {
      return c.json({ error: 'Valid URL is required' }, 400);
    }

    // Validate URL length
    if (url.length > 2048) {
      return c.json({ error: 'URL too long' }, 400);
    }

    // 1. Check for duplicates (Deduplication)
    const existing = await turso.execute({
      sql: 'SELECT * FROM urls WHERE original_url = ?',
      args: [url]
    });

    if (existing.rows.length > 0) {
      const record = existing.rows[0];
      if(record){
        const filename = record.filename as string;
        const safeFilename = encodeURIComponent(filename);
        
        return c.json({
          success: true,
          id: record.id,
          download_url: `/download/${record.id}/${safeFilename}`,
          is_existing: true,
          metadata: {
            content_type: record.content_type,
            content_length: record.content_length,
            filename: filename
          }
        });
      }
    }

    // --- New URL Logic with GET request ---
    let contentType = 'application/octet-stream';
    let contentLength = '';
    let filename = '';
    let metadataFetched = false;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      
      const response = await fetch(url, { 
        method: 'GET',
        signal: controller.signal,
        redirect: 'follow'
      });
      
      clearTimeout(timeoutId);

      // Extract metadata from response headers
      contentType = response.headers.get('content-type') || contentType;
      contentLength = response.headers.get('content-length') || '';
      
      const disposition = response.headers.get('content-disposition');
      if (disposition) {
        const filenameMatch = disposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
        if (filenameMatch && filenameMatch[1]) {
          filename = filenameMatch[1].replace(/['"]/g, '');
        }
      }
      
      // If no filename from content-disposition, extract from final URL (after redirects)
      if (!filename) {
        const finalUrl = response.url;
        const urlPath = new URL(finalUrl).pathname;
        // Remove query parameters and get the last segment
        const pathSegment = urlPath.split('/').pop() || '';
        const decodedSegment = pathSegment.split('?')[0] || '';
        filename = decodeURIComponent(decodedSegment) || 'download';
      }

      metadataFetched = true;
      
      // Abort the request to stop downloading the body
      controller.abort();
      
    } catch (e) {
      // Ignore AbortError since we abort intentionally after getting headers
      if (e instanceof Error && e.name !== 'AbortError') {
        console.error('Failed to fetch metadata:', e);
      }
      
      // Fallback filename if metadata fetch completely fails
      if (!filename) {
        try {
          const urlPath = new URL(url).pathname;
          const pathSegment = urlPath.split('/').pop() || '';
          const decodedSegment = pathSegment.split('?')[0] || '';
          filename = decodeURIComponent(decodedSegment) || 'download.bin';
        } catch {
          filename = 'download.bin';
        }
      }
    }

    // Sanitize filename: remove invalid characters
    filename = filename.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim() || 'download.bin';
    
    // Ensure filename isn't empty after sanitization
    if (!filename || filename === '_') {
      filename = 'download.bin';
    }

    const id = nanoid(10);

    // Store the ORIGINAL URL, not the final redirected URL
    await turso.execute({
      sql: `INSERT INTO urls (id, original_url, content_type, content_length, filename) 
            VALUES (?, ?, ?, ?, ?)`,
      args: [id, url, contentType, contentLength, filename]
    });

    const safeFilename = encodeURIComponent(filename);

    return c.json({
      success: true,
      id,
      download_url: `/download/${id}/${safeFilename}`,
      metadata: {
        content_type: contentType,
        content_length: contentLength,
        filename
      }
    });
  } catch (error) {
    console.error('Error creating transload:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

app.get('/download/:id/:filename?', async (c) => {
  try {
    const turso = createClient({
      url: c.env.TURSO_DATABASE_URL,
      authToken: c.env.TURSO_AUTH_TOKEN,
    });

    const { id } = c.req.param();

    const result = await turso.execute({
      sql: 'SELECT * FROM urls WHERE id = ?',
      args: [id]
    });

    if (result.rows.length === 0) {
      return c.text('Not found', 404);
    }

    const record = result.rows[0];
    if(!record){
      return c.text('Not found', 404);
    }
    const originalUrl = record.original_url as string;
    const dbFilename = record.filename as string;

    // Get Range header from incoming request
    const rangeHeader = c.req.header('range');
    
    const fetchHeaders: HeadersInit = {};
    if (rangeHeader) {
      fetchHeaders['Range'] = rangeHeader;
    }

    const fileResponse = await fetch(originalUrl, {
      headers: fetchHeaders
    });

    if (!fileResponse.ok && fileResponse.status !== 206) {
      return c.text('Failed to fetch original file', 502);
    }

    const upstreamLength = fileResponse.headers.get('content-length');
    const dbLength = record.content_length as string;
    const finalLength = upstreamLength || dbLength;

    const headers: Record<string, string> = {
      'Content-Type': fileResponse.headers.get('content-type') || record.content_type as string,
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes'
    };

    if (finalLength) {
      headers['Content-Length'] = finalLength;
    }

    if (dbFilename) {
      headers['Content-Disposition'] = `attachment; filename="${dbFilename}"`;
    }

    // Pass through range-related headers
    const contentRange = fileResponse.headers.get('content-range');
    if (contentRange) {
      headers['Content-Range'] = contentRange;
    }

    const etag = fileResponse.headers.get('etag');
    if (etag) headers['ETag'] = etag;

    const lastModified = fileResponse.headers.get('last-modified');
    if (lastModified) headers['Last-Modified'] = lastModified;

    return new Response(fileResponse.body, {
      status: fileResponse.status, // 200 or 206 for partial content
      headers
    });
  } catch (error) {
    console.error('Error streaming file:', error);
    return c.text('Internal server error', 500);
  }
});

// API: Get link info
app.get('/api/info/:id', async (c) => {
  try {
    // Get environment variables from context
    const turso = createClient({
      url: c.env.TURSO_DATABASE_URL,
      authToken: c.env.TURSO_AUTH_TOKEN,
    });

    const { id } = c.req.param();

    const result = await turso.execute({
      sql: 'SELECT * FROM urls WHERE id = ?',
      args: [id]
    });

    if (result.rows.length === 0) {
      return c.json({ error: 'Not found' }, 404);
    }

    return c.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching info:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// Initialize DB on first request
app.use('*', async (c, next) => {

  try {
    
    await initDB(c.env.TURSO_DATABASE_URL, c.env.TURSO_AUTH_TOKEN);
  } catch (e) {
    // Table likely already exists, ignore
  }
  await next();
});

export default app;