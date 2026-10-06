import { Hono } from "hono";
import { createClient } from "@libsql/client";
import { nanoid } from "nanoid";
import type { HeadersInit } from "bun";

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
  console.log("calling turso");
}

// // HTML page
// app.get('/', async (c) => {
//   const file = Bun.file('./index.html');
//   return new Response(file.stream(), {
//     headers: { 'Content-Type': 'text/html' }
//   });
// })

let dbReady: Promise<unknown> | null = null;

app.use("*", async (c, next) => {
  dbReady ??= initDB(c.env.TURSO_DATABASE_URL, c.env.TURSO_AUTH_TOKEN).catch(
    (e) => {
      dbReady = null;
      throw e;
    },
  );
  await dbReady;
  await next();
});

// API: Create transload link
app.post("/api/create", async (c) => {
  try {
    // Get environment variables from context
    const turso = createClient({
      url: c.env.TURSO_DATABASE_URL,
      authToken: c.env.TURSO_AUTH_TOKEN,
    });

    const { url } = await c.req.json();

    if (!url || !url.startsWith("http")) {
      return c.json({ error: "Valid URL is required" }, 400);
    }

    // Validate URL length
    if (url.length > 2048) {
      return c.json({ error: "URL too long" }, 400);
    }

    // 1. Check for duplicates (Deduplication)
    const existing = await turso.execute({
      sql: "SELECT * FROM urls WHERE original_url = ?",
      args: [url],
    });

    if (existing.rows.length > 0) {
      const record = existing.rows[0];
      if (record) {
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
            filename: filename,
          },
        });
      }
    }

    // --- New URL Logic with GET request ---
    let contentType = "application/octet-stream";
    let contentLength = "";
    let filename = "";
    let metadataFetched = false;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        redirect: "follow",
      });

      clearTimeout(timeoutId);

      // Extract metadata from response headers
      contentType = response.headers.get("content-type") || contentType;
      contentLength = response.headers.get("content-length") || "";

      const disposition = response.headers.get("content-disposition");
      if (disposition) {
        const star = disposition.match(/filename\*\s*=\s*[^']*'[^']*'([^;]+)/i);
        const plain = disposition.match(/filename\s*=\s*("([^"]*)"|[^;]+)/i);
        try {
          if (star?.[1]) filename = decodeURIComponent(star[1].trim());
          else if (plain) {
            const plainFilename = plain[2] ?? plain[1];
            if (plainFilename) filename = plainFilename.trim();
          }
        } catch {
          /* malformed encoding, fall through to URL-based name */
        }
      }

      // If no filename from content-disposition, extract from final URL (after redirects)
      if (!filename) {
        const finalUrl = response.url;
        const urlPath = new URL(finalUrl).pathname;
        // Remove query parameters and get the last segment
        const pathSegment = urlPath.split("/").pop() || "";
        const decodedSegment = pathSegment.split("?")[0] || "";
        filename = decodeURIComponent(decodedSegment) || "download";
      }

      metadataFetched = true;

      // Abort the request to stop downloading the body
      controller.abort();
    } catch (e) {
      // Ignore AbortError since we abort intentionally after getting headers
      if (e instanceof Error && e.name !== "AbortError") {
        console.error("Failed to fetch metadata:", e);
      }

      // Fallback filename if metadata fetch completely fails
      if (!filename) {
        try {
          const urlPath = new URL(url).pathname;
          const pathSegment = urlPath.split("/").pop() || "";
          const decodedSegment = pathSegment.split("?")[0] || "";
          filename = decodeURIComponent(decodedSegment) || "download.bin";
        } catch {
          filename = "download.bin";
        }
      }
    }

    // Sanitize filename: remove invalid characters
    filename =
      filename.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim() || "download.bin";

    // Ensure filename isn't empty after sanitization
    if (!filename || filename === "_") {
      filename = "download.bin";
    }

    const id = nanoid(10);

    // Store the ORIGINAL URL, not the final redirected URL
    await turso.execute({
      sql: `INSERT INTO urls (id, original_url, content_type, content_length, filename) 
            VALUES (?, ?, ?, ?, ?)`,
      args: [id, url, contentType, contentLength, filename],
    });

    const safeFilename = encodeURIComponent(filename);

    return c.json({
      success: true,
      id,
      download_url: `/download/${id}/${safeFilename}`,
      metadata: {
        content_type: contentType,
        content_length: contentLength,
        filename,
      },
    });
  } catch (error) {
    console.error("Error creating transload:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
});

app.get("/download/:id/:filename?", async (c) => {
  try {
    const turso = createClient({
      url: c.env.TURSO_DATABASE_URL,
      authToken: c.env.TURSO_AUTH_TOKEN,
    });

    const { id } = c.req.param();

    const result = await turso.execute({
      sql: "SELECT * FROM urls WHERE id = ?",
      args: [id],
    });

    if (result.rows.length === 0) {
      return c.text("Not found", 404);
    }

    const record = result.rows[0];
    if (!record) {
      return c.text("Not found", 404);
    }
    const originalUrl = record.original_url as string;
    const dbFilename = record.filename as string;

    // Get Range header from incoming request
    const rangeHeader = c.req.header("range");

    const fetchHeaders: HeadersInit = {};
    if (rangeHeader) {
      fetchHeaders["Range"] = rangeHeader;
    }

    const fileResponse = await fetch(originalUrl, {
      headers: fetchHeaders,
    });

    if (!fileResponse.ok && fileResponse.status !== 206) {
      return c.text("Failed to fetch original file", 502);
    }

    const upstreamLength = fileResponse.headers.get("content-length");
    const dbLength = record.content_length as string;
    const finalLength = upstreamLength || dbLength;

    const headers: Record<string, string> = {
      "Content-Type":
        fileResponse.headers.get("content-type") ||
        (record.content_type as string),
      "Access-Control-Allow-Origin": "*",
      "Accept-Ranges": "bytes",
    };

    if (finalLength) {
      headers["Content-Length"] = finalLength;
    }

    if (dbFilename) {
      headers["Content-Disposition"] = `attachment; filename="${dbFilename}"`;
    }

    // Pass through range-related headers
    const contentRange = fileResponse.headers.get("content-range");
    if (contentRange) {
      headers["Content-Range"] = contentRange;
    }

    const etag = fileResponse.headers.get("etag");
    if (etag) headers["ETag"] = etag;

    const lastModified = fileResponse.headers.get("last-modified");
    if (lastModified) headers["Last-Modified"] = lastModified;

    return new Response(fileResponse.body, {
      status: fileResponse.status, // 200 or 206 for partial content
      headers,
    });
  } catch (error) {
    console.error("Error streaming file:", error);
    return c.text("Internal server error", 500);
  }
});

app.delete("/api/urls/:id", async (c) => {
  try {
    const turso = createClient({
      url: c.env.TURSO_DATABASE_URL,
      authToken: c.env.TURSO_AUTH_TOKEN,
    });

    const { id } = c.req.param();

    const result = await turso.execute({
      sql: "DELETE FROM urls WHERE id = ?",
      args: [id],
    });

    if (result.rowsAffected === 0) {
      return c.json({ error: "Not found" }, 404);
    }

    return c.json({ success: true });
  } catch (error) {
    console.error("Error deleting URL:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
});

// API: List all URLs (newest first, paginated)
app.get("/api/urls", async (c) => {
  try {
    const turso = createClient({
      url: c.env.TURSO_DATABASE_URL,
      authToken: c.env.TURSO_AUTH_TOKEN,
    });

    const page = Math.max(1, parseInt(c.req.query("page") || "1"));
    const limit = Math.min(
      100,
      Math.max(1, parseInt(c.req.query("limit") || "50")),
    );
    const offset = (page - 1) * limit;

    const [rows, countResult] = await Promise.all([
      turso.execute({
        sql: `SELECT id, original_url, content_type, content_length, filename, created_at
              FROM urls
              ORDER BY created_at DESC
              LIMIT ? OFFSET ?`,
        args: [limit, offset],
      }),
      turso.execute("SELECT COUNT(*) as total FROM urls"),
    ]);

    const total = Number(countResult.rows[0]?.total ?? 0);

    return c.json({
      urls: rows.rows,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    });
  } catch (error) {
    console.error("Error listing URLs:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
});

// API: Get link info
app.get("/api/info/:id", async (c) => {
  try {
    // Get environment variables from context
    const turso = createClient({
      url: c.env.TURSO_DATABASE_URL,
      authToken: c.env.TURSO_AUTH_TOKEN,
    });

    const { id } = c.req.param();

    const result = await turso.execute({
      sql: "SELECT * FROM urls WHERE id = ?",
      args: [id],
    });

    if (result.rows.length === 0) {
      return c.json({ error: "Not found" }, 404);
    }

    return c.json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching info:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
});

export default app;
