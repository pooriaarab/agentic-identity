// Test support: a `fetch` for the real `@netlify/blobs` client that makes the local `BlobsServer`
// behave like the Netlify service, where the adapters depend on it. The server checks a condition
// and then writes in two steps, builds an ETag from the file mtime (two writes in one millisecond
// share one), and sends no ETag on a read. This wrapper does what the service does instead:
//   - A write or delete runs alone, and a condition (`If-Match`, `If-None-Match: *`) is checked
//     in the same step as the write, against an ETag that this wrapper gives and remembers.
//   - Every write gives the key a new ETag, even for equal bytes. With `contentEtags`, the ETag is
//     an MD5 of the bytes instead.
//   - A read of a key that exists returns its ETag.
// With `retryAfterLanding`, a conditional write lands and then answers 412, as the real client does
// when it retries a request that had landed.
// Every byte still goes through the real client and the real server. Use one wrapper per store name.
import { createHash } from "node:crypto";

export interface LocalServiceOptions {
  retryAfterLanding?: boolean;
  contentEtags?: boolean;
}

export function createLocalServiceFetch(options: LocalServiceOptions = {}, inner: typeof fetch = fetch): typeof fetch {
  const etags = new Map<string, string>();
  let counter = 0;
  let chain: Promise<unknown> = Promise.resolve();
  const alone = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn);
    chain = run.catch(() => undefined);
    return run;
  };
  const withEtag = (response: Response, etag: string | undefined) => {
    if (!etag) return response;
    const headers = new Headers(response.headers);
    headers.set("etag", etag);
    return new Response(response.body, { status: response.status, headers });
  };

  return async (input, init) => {
    const request = new Request(input as RequestInfo, init);
    const path = new URL(request.url).pathname;
    const method = request.method.toUpperCase();
    if (path.startsWith("/api/")) return inner(request);

    if (method === "PUT") {
      const bytes = Buffer.from(await request.arrayBuffer());
      return alone(async () => {
        const current = etags.get(path);
        const ifMatch = request.headers.get("if-match");
        const ifNoneMatch = request.headers.get("if-none-match");
        if ((ifNoneMatch === "*" && current !== undefined) || (ifMatch && current !== ifMatch)) return new Response(null, { status: 412 });
        const headers = new Headers(request.headers);
        headers.delete("if-match");
        headers.delete("if-none-match");
        const response = await inner(request.url, { method, headers, body: bytes });
        if (!response.ok) return response;
        const etag = options.contentEtags ? `"${createHash("md5").update(bytes).digest("hex")}"` : `"e${++counter}"`;
        etags.set(path, etag);
        if (options.retryAfterLanding && (ifMatch || ifNoneMatch)) return new Response(null, { status: 412 });
        return new Response(null, { status: 200, headers: { etag } });
      });
    }
    if (method === "DELETE") {
      return alone(async () => {
        const response = await inner(request);
        if (response.ok) etags.delete(path);
        return response;
      });
    }
    const response = await alone(() => inner(request));
    return response.ok && (method === "GET" || method === "HEAD") ? withEtag(response, etags.get(path)) : response;
  };
}
