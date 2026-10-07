import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { createClient, type Client, type Row } from "@libsql/client";
import { nanoid } from "nanoid";
import type { HeadersInit } from "bun";

// Define environment type
type Bindings = {
  TURSO_DATABASE_URL: string;
  TURSO_AUTH_TOKEN: string;
  APP_PASSWORD: string;
  AUTH_SECRET: string;
  LOGIN_LIMITER: {
    limit(opts: { key: string }): Promise<{ success: boolean }>;
  };
};

const COOKIE_NAME = "tl_session";
const SESSION_SECONDS = 60 * 60 * 24 * 30; // 30 days
const enc = new TextEncoder();

function b64url(buf: ArrayBuffer) {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret: string, data: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", key, enc.encode(data));
}

async function safeEqual(a: string, b: string) {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

async function makeToken(secret: string) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const sig = b64url(await hmac(secret, String(exp)));
  return `${exp}.${sig}`;
}

async function verifyToken(secret: string, token: string | undefined) {
  if (!token) return false;
  const [expStr, sig] = token.split(".");
  if (!expStr || !sig) return false;

  const exp = Number(expStr);
  if (!Number.isInteger(exp) || exp < Math.floor(Date.now() / 1000))
    return false;

  const expected = b64url(await hmac(secret, expStr));
  return safeEqual(sig, expected);
}

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

async function findByUrl(db: Client, url: string) {
  const res = await db.execute({
    sql: "SELECT * FROM urls WHERE original_url = ?",
    args: [url],
  });
  return res.rows[0] ?? null;
}

function toResponse(r: Row, isExisting: boolean) {
  const filename = (r.filename as string) || "download.bin";
  return {
    success: true,
    id: r.id,
    download_url: `/download/${r.id}/${encodeURIComponent(filename)}`,
    ...(isExisting && { is_existing: true }),
    metadata: {
      content_type: r.content_type,
      content_length: r.content_length,
      filename,
    },
  };
}

function filenameFromUrl(u: string) {
  try {
    const seg = new URL(u).pathname.split("/").pop() || "";
    return decodeURIComponent(seg);
  } catch {
    return "";
  }
}

const app = new Hono<{ Bindings: Bindings }>();

// Initialize database schema

// // HTML page
// app.get('/', async (c) => {
//   const file = Bun.file('./index.html');
//   return new Response(file.stream(), {
//     headers: { 'Content-Type': 'text/html' }
//   });
// })

app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/login" || c.req.path === "/api/logout")
    return next();

  if (!c.env.AUTH_SECRET || !c.env.APP_PASSWORD) {
    console.error("AUTH_SECRET / APP_PASSWORD not set");
    return c.json({ error: "Server auth is not configured" }, 500);
  }

  const ok = await verifyToken(c.env.AUTH_SECRET, getCookie(c, COOKIE_NAME));
  if (!ok) return c.json({ error: "Unauthorized" }, 401);

  return next();
});

app.post("/api/login", async (c) => {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const { success } = await c.env.LOGIN_LIMITER.limit({ key: ip });
  if (!success) {
    return c.json({ error: "Too many attempts, try again in a minute" }, 429);
  }
  if (!c.env.AUTH_SECRET || !c.env.APP_PASSWORD) {
    console.error("AUTH_SECRET / APP_PASSWORD not set");
    return c.json({ error: "Server auth is not configured" }, 500);
  }

  const body = await c.req.json().catch(() => null);
  const password = typeof body?.password === "string" ? body.password : "";

  if (
    password.length > 512 ||
    !(await safeEqual(password, c.env.APP_PASSWORD))
  ) {
    return c.json<{ error: string }>({ error: "Wrong password" }, 401);
  }

  const token = await makeToken(c.env.AUTH_SECRET);
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "Strict",
    path: "/",
    maxAge: SESSION_SECONDS,
    secure: new URL(c.req.url).protocol === "https:", // off on http://localhost so Safari keeps it
  });
  return c.json({ success: true });
});

app.post("/api/logout", (c) => {
  deleteCookie(c, COOKIE_NAME, { path: "/" });
  return c.json({ success: true });
});

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
    const turso = createClient({
      url: c.env.TURSO_DATABASE_URL,
      authToken: c.env.TURSO_AUTH_TOKEN,
    });

    const body = await c.req.json().catch(() => null);
    const url = typeof body?.url === "string" ? body.url.trim() : "";

    if (!url) return c.json({ error: "URL is required" }, 400);
    if (url.length > 2048) return c.json({ error: "URL too long" }, 400);

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return c.json({ error: "Invalid URL" }, 400);
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return c.json({ error: "Only http(s) URLs are allowed" }, 400);
    }

    // Dedupe
    const existing = await findByUrl(turso, url);
    if (existing) return c.json(toResponse(existing, true));

    // Fetch headers only
    let response: Response;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    try {
      response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        redirect: "follow",
      });
    } catch {
      return c.json({ error: "Could not reach that URL" }, 502);
    } finally {
      clearTimeout(timeoutId);
    }

    const status = response.status;
    const contentType =
      response.headers.get("content-type") || "application/octet-stream";
    const contentLength = response.headers.get("content-length") || "";
    const disposition = response.headers.get("content-disposition");
    const finalUrl = response.url || url;

    // We only wanted headers; stop the body from downloading
    await response.body?.cancel().catch(() => {});

    if (status < 200 || status >= 300) {
      return c.json({ error: `That URL returned HTTP ${status}` }, 400);
    }

    // Filename: prefer filename*=, then filename=, then the URL path
    let filename = "";
    if (disposition) {
      const star = disposition.match(/filename\*\s*=\s*[^']*'[^']*'([^;]+)/i);
      const plain = disposition.match(/filename\s*=\s*("([^"]*)"|[^;]+)/i);
      try {
        if (star?.[1]) filename = decodeURIComponent(star[1].trim());
        else if (plain) filename = (plain[2] ?? plain[1] ?? "").trim();
      } catch {
        /* malformed encoding, fall through */
      }
    }
    if (!filename) filename = filenameFromUrl(finalUrl) || filenameFromUrl(url);

    filename = filename
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
      .trim()
      .slice(0, 200);
    if (!filename || filename === "_") filename = "download.bin";

    // Insert; if a concurrent request won the race, ON CONFLICT skips ours
    const id = nanoid(10);
    await turso.execute({
      sql: `INSERT INTO urls (id, original_url, content_type, content_length, filename)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(original_url) DO NOTHING`,
      args: [id, url, contentType, contentLength, filename],
    });

    const row = await findByUrl(turso, url);
    if (!row) return c.json({ error: "Internal server error" }, 500);

    return c.json(toResponse(row, row.id !== id));
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

    const fetchHeaders = new Headers();
    if (rangeHeader) fetchHeaders.set("Range", rangeHeader);

    const fileResponse = await fetch(originalUrl, { headers: fetchHeaders });

    // Pass 416 through so clients know the file is already complete
    if (fileResponse.status === 416) {
      const h = new Headers();
      const cr = fileResponse.headers.get("content-range");
      if (cr) h.set("Content-Range", cr);
      return new Response(null, { status: 416, headers: h });
    }

    if (!fileResponse.ok) {
      return c.text("Failed to fetch original file", 502);
    }

    const headers = new Headers({
      "Content-Type":
        fileResponse.headers.get("content-type") ||
        (record.content_type as string),
      "Access-Control-Allow-Origin": "*",
    });

    // Only pass through what upstream actually said. No DB fallback.
    for (const name of [
      "content-length",
      "content-range",
      "accept-ranges",
      "etag",
      "last-modified",
    ]) {
      const v = fileResponse.headers.get(name);
      if (v) headers.set(name, v);
    }

    if (dbFilename) {
      const ascii = dbFilename.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "");
      headers.set(
        "Content-Disposition",
        `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(dbFilename)}`,
      );
    }

    return new Response(fileResponse.body, {
      status: fileResponse.status,
      headers,
    });
  } catch (error) {
    console.error("Error streaming file:", error);
    return c.text("Internal server error", 500);
  }
});

app.post("/api/urls/delete", async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    const ids: unknown[] = Array.isArray(body?.ids)
      ? [...new Set(body.ids)]
      : [];

    const valid =
      ids.length >= 1 &&
      ids.length <= 100 &&
      ids.every((x) => typeof x === "string" && x.length > 0 && x.length <= 64);
    if (!valid) return c.json({ error: "ids must be 1-100 strings" }, 400);

    const turso = createClient({
      url: c.env.TURSO_DATABASE_URL,
      authToken: c.env.TURSO_AUTH_TOKEN,
    });

    const result = await turso.execute({
      sql: `DELETE FROM urls WHERE id IN (${ids.map(() => "?").join(",")})`,
      args: ids as string[],
    });

    return c.json({ success: true, deleted: result.rowsAffected });
  } catch (error) {
    console.error("Error deleting URLs:", error);
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
