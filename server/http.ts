import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { LARGE_MAX_TTL_SECONDS, MAX_BLOB_BYTES, MAX_FILE_BYTES, MAX_LARGE_STORED_BYTES, MAX_STORED_BYTES, MAX_TEXT_BLOB_BYTES } from "../src/shared/limits";
import { API_HEADERS, blobLimit, handle } from "../src/worker/index";
import type { Site } from "./static";
import type { ManagedStore } from "./store-sqlite";

export interface AppDeps {
  store: ManagedStore;
  site: Site;
  maxStored: number;
  /** Defaults are the hosted limits: MAX_STORED_BYTES, MAX_LARGE_STORED_BYTES, MAX_FILE_BYTES, 1 hour for files, and 16 uploads at once. */
  maxStoredBytes?: number;
  maxLargeBytes?: number;
  maxFileBytes?: number;
  maxFileTtl?: number;
  maxUploads?: number;
}

export interface App {
  server: Server;
  /** Resolves when the background work started by requests (purges) has finished. */
  drain(): Promise<void>;
}

/** The only thing logged for a failure: an error code or name. Never a URL, id, body or message (they could hold request data). */
function logFailure(error: unknown): void {
  const e = error as { code?: unknown; name?: unknown } | null;
  const label = typeof e?.code === "string" ? e.code : typeof e?.name === "string" ? e.name : "error";
  process.stderr.write(`onetime: request failed (${label.replace(/[^\w.-]/g, "").slice(0, 60)})\n`);
}

export interface BoundedBody {
  stream: ReadableStream<Uint8Array>;
  /** True once the request body was read to its end. */
  complete(): boolean;
}

/**
 * The request body as a Web stream that hands out at most `maxBlobBytes` + 1 bytes (default MAX_BLOB_BYTES), then ends.
 * Not Readable.toWeb(req): its cancel() destroys the socket, so the router's 413 could not be written.
 * Cancelling here only pauses the request.
 */
export function boundedBody(req: IncomingMessage, maxBlobBytes: number = MAX_BLOB_BYTES): BoundedBody {
  const limit = maxBlobBytes + 1;
  let total = 0;
  let complete = false;
  let detach = (): void => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const onData = (chunk: Buffer): void => {
        const room = limit - total;
        const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
        total += piece.length;
        controller.enqueue(new Uint8Array(piece));
        if (total >= limit) {
          detach();
          req.pause();
          controller.close();
        } else if ((controller.desiredSize ?? 0) <= 0) {
          req.pause();
        }
      };
      const onEnd = (): void => {
        complete = true;
        detach();
        controller.close();
      };
      const onError = (error: Error): void => {
        detach();
        controller.error(error);
      };
      const onClose = (): void => {
        if (!req.complete) onError(new Error("request closed early"));
      };
      detach = () => {
        req.off("data", onData);
        req.off("end", onEnd);
        req.off("error", onError);
        req.off("close", onClose);
      };
      req.on("data", onData);
      req.on("end", onEnd);
      req.on("error", onError);
      req.on("close", onClose);
    },
    pull() {
      req.resume();
    },
    cancel() {
      detach();
      req.pause();
    },
  });
  return { stream, complete: () => complete };
}

const SKIPPED_REQUEST_HEADERS = new Set(["host", "connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "te"]);

function webRequest(req: IncomingMessage, url: URL, maxBlobBytes: number): { request: Request; body: BoundedBody | null } {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || SKIPPED_REQUEST_HEADERS.has(name)) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const method = req.method ?? "GET";
  if (method === "GET" || method === "HEAD") {
    req.resume();
    return { request: new Request(url, { method, headers }), body: null };
  }
  const body = boundedBody(req, maxBlobBytes);
  return { request: new Request(url, { method, headers, body: body.stream, duplex: "half" } as RequestInit), body };
}

function send(res: ServerResponse, status: number, headers: Iterable<[string, string]>, body: Uint8Array | null): void {
  res.statusCode = status;
  for (const [name, value] of headers) res.setHeader(name, value);
  res.end(body === null ? undefined : body);
}

/** What is read and thrown away from the rest of an over-limit body before the response goes out: at most this long, this many bytes. */
const DRAIN_MS = 1000;
const DRAIN_BYTES = 2 * 1024 * 1024;

/**
 * Reads and discards the rest of the request body, up to DRAIN_MS and DRAIN_BYTES. Nothing of it is kept or handed to
 * the router. Needed because Node destroys the socket as soon as a `Connection: close` response is flushed, and closing
 * with unread data makes the kernel send a reset that can swallow the response while the client is still writing.
 */
function drainRequest(req: IncomingMessage): Promise<void> {
  return new Promise((resolve) => {
    let seen = 0;
    const done = (): void => {
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", done);
      req.off("close", done);
      req.off("error", done);
      resolve();
    };
    const onData = (chunk: Buffer): void => {
      seen += chunk.length;
      if (seen >= DRAIN_BYTES) done();
    };
    const timer = setTimeout(done, DRAIN_MS);
    req.on("data", onData);
    req.once("end", done);
    req.once("close", done);
    req.once("error", done);
    req.resume();
  });
}

/**
 * How long a request may take to arrive: 60 s, plus 1 s per 32 KiB of blob above a text blob (a 262 kbit/s line), so a file
 * at the limit can still be sent on a slow connection (220 s for 5 MiB). Uploads are bounded by ONETIME_MAX_UPLOADS.
 */
export function requestTimeoutMs(maxBlobBytes: number): number {
  return 60_000 + Math.ceil(Math.max(0, maxBlobBytes - MAX_TEXT_BLOB_BYTES) / (32 * 1024)) * 1000;
}

export function createApp({
  store,
  site,
  maxStored,
  maxStoredBytes = MAX_STORED_BYTES,
  maxLargeBytes = MAX_LARGE_STORED_BYTES,
  maxFileBytes = MAX_FILE_BYTES,
  maxFileTtl = LARGE_MAX_TTL_SECONDS,
  maxUploads = 16,
}: AppDeps): App {
  const maxBlobBytes = blobLimit({ maxLargeBytes, maxFileBytes });
  // Uploads being read and stored right now. Each holds up to about 3 x maxBlobBytes in memory (chunks, joined copy, driver copy).
  let uploads = 0;
  const pending = new Set<Promise<unknown>>();
  const ctx = {
    waitUntil(promise: Promise<unknown>): void {
      const tracked: Promise<unknown> = promise.catch(logFailure).finally(() => pending.delete(tracked));
      pending.add(tracked);
    },
  };

  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const { request, body } = webRequest(req, url, maxBlobBytes);
    const isUpload = req.method === "POST" && url.pathname === "/api/secrets";
    let response: Response;
    if (isUpload && uploads >= maxUploads) {
      // Refused before anything is read; the unread body is drained below like for a 413.
      response = Response.json({ error: "The server is busy, try again in a few seconds" }, { status: 503, headers: { ...API_HEADERS, "Retry-After": "5" } });
    } else {
      if (isUpload) uploads++;
      try {
        response = await handle(request, store, ctx, { maxStored, maxStoredBytes, maxLargeBytes, maxFileBytes, maxFileTtl, maxBlobBytes });
      } catch (error) {
        logFailure(error);
        response = Response.json({ error: "Internal error" }, { status: 500, headers: API_HEADERS });
      } finally {
        if (isUpload) uploads--;
      }
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (body !== null && !body.complete()) {
      res.setHeader("Connection", "close");
      await drainRequest(req);
    }
    const headers: [string, string][] = [...response.headers];
    headers.push(["Content-Length", String(bytes.length)]);
    send(res, response.status, headers, req.method === "HEAD" ? null : bytes);
  }

  async function health(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const base: [string, string][] = [
      ["Cache-Control", "no-store"],
      ["X-Robots-Tag", "noindex"],
      ["Content-Type", "text/plain; charset=utf-8"],
    ];
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, [...base, ["Allow", "GET, HEAD"]], null);
    let ok = true;
    try {
      await store.ping();
    } catch (error) {
      logFailure(error);
      ok = false;
    }
    const text = new TextEncoder().encode(ok ? "ok" : "unavailable");
    send(res, ok ? 200 : 503, [...base, ["Content-Length", String(text.length)]], req.method === "HEAD" ? null : text);
  }

  function serve(req: IncomingMessage, res: ServerResponse): void {
    const target = req.url ?? "";
    if (!target.startsWith("/")) {
      req.resume();
      return send(res, 400, [["Cache-Control", "no-store"], ["Content-Length", "0"]], null);
    }
    const cut = target.search(/[?#]/);
    const rawPath = cut === -1 ? target : target.slice(0, cut);

    if (rawPath === "/api" || rawPath.startsWith("/api/")) {
      // The Host header is never read: the router only needs the path and query.
      void api(req, res, new URL(target, "http://localhost")).catch((error: unknown) => {
        logFailure(error);
        if (!res.headersSent) send(res, 500, Object.entries(API_HEADERS), null);
        else res.destroy();
      });
      return;
    }
    req.resume();
    if (rawPath === "/healthz") {
      void health(req, res);
      return;
    }
    const header = req.headers["if-none-match"];
    const result = site.resolve(target, req.method ?? "GET", Array.isArray(header) ? header.join(",") : header);
    send(res, result.status, result.headers, result.body);
  }

  const server = createServer(
    {
      requestTimeout: requestTimeoutMs(maxBlobBytes),
      headersTimeout: 10_000,
      keepAliveTimeout: 5_000,
      maxHeaderSize: 8192,
      connectionsCheckingInterval: 2_000,
    },
    (req, res) => {
      try {
        serve(req, res);
      } catch (error) {
        logFailure(error);
        if (!res.headersSent) send(res, 500, [["Cache-Control", "no-store"]], null);
        else res.destroy();
      }
    },
  );
  server.maxRequestsPerSocket = 100;
  server.on("clientError", (error: NodeJS.ErrnoException, socket) => {
    // headersTimeout and requestTimeout both arrive here with this code; Node's own default answers them with 408.
    const line = error.code === "ERR_HTTP_REQUEST_TIMEOUT" ? "408 Request Timeout" : "400 Bad Request";
    if (socket.writable) socket.end(`HTTP/1.1 ${line}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    else socket.destroy();
  });

  return { server, drain: async () => void (await Promise.allSettled([...pending])) };
}

/** Stops accepting connections, lets requests in flight finish for up to `graceMs`, then cuts what is left. */
export function closeGracefully(server: Server, graceMs: number): Promise<void> {
  return new Promise((resolve) => {
    let closed = false;
    server.close(() => {
      closed = true;
    });
    const started = Date.now();
    const tick = (): void => {
      if (closed) return resolve();
      if (Date.now() - started >= graceMs) {
        server.closeAllConnections();
      } else {
        server.closeIdleConnections();
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}
