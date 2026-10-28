// Room tokens signed with HMAC-SHA256. It needs only WebCrypto, so it runs the
// same on Workers, Node, and Deno.
//
// Token: `<key id>.<base64url payload>.<base64url signature>`. The signature
// covers the key id and the payload. The first key signs. Every key verifies.
import { parseRegion, type AdapterOptions, type Realtime, RoomAccess, RoomGrant, RoomKey } from "../ports.js";

const MAX_TOKEN_LENGTH = 2048;
const encoder = new TextEncoder();
const b64 = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64url");

export function createHmacRealtime(options: AdapterOptions & { keys: RoomKey[] }): Realtime {
  const now = options.now ?? Date.now;
  const ids = new Set<string>();
  for (const key of options.keys) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(key.id) || ids.has(key.id)) throw new Error(`invalid or repeated room key id "${key.id}"`);
    if (key.secret.length < 16) throw new Error("a room key secret needs 16 characters or more");
    ids.add(key.id);
  }
  if (options.keys.length === 0) throw new Error("at least one room key is required");
  const [signer] = options.keys as [RoomKey, ...RoomKey[]];
  const hmac = (secret: string, usage: "sign" | "verify") =>
    crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);

  return {
    region: options.region === undefined ? "unknown" : parseRegion(options.region),
    async issueRoomToken({ room, principalId, access, ttlSeconds }) {
      if (room === "" || principalId === "" || (access !== "read" && access !== "write")) throw new Error("invalid room grant");
      if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 86_400) throw new RangeError("ttlSeconds must be an integer from 1 to 86400");
      const payload = b64(encoder.encode(JSON.stringify({ room, principalId, access, exp: now() + ttlSeconds * 1000 })));
      const signed = `${signer.id}.${payload}`;
      return `${signed}.${b64(await crypto.subtle.sign("HMAC", await hmac(signer.secret, "sign"), encoder.encode(signed)))}`;
    },
    async verifyRoomToken(token, room) {
      try {
        const parts = token.split(".");
        const key = options.keys.find((k) => k.id === parts[0]);
        if (token.length > MAX_TOKEN_LENGTH || parts.length !== 3 || !key) return null;
        const signature = Buffer.from(parts[2]!, "base64url");
        const signed = encoder.encode(`${parts[0]}.${parts[1]}`);
        if (!(await crypto.subtle.verify("HMAC", await hmac(key.secret, "verify"), signature, signed))) return null;
        const p = JSON.parse(Buffer.from(parts[1]!, "base64url").toString()) as Record<string, unknown>;
        const valid = typeof p.principalId === "string" && (p.access === "read" || p.access === "write") && typeof p.exp === "number";
        if (!valid || p.room !== room || (p.exp as number) <= now()) return null;
        return { room, principalId: p.principalId as string, access: p.access as RoomAccess, expiresAt: p.exp as number } satisfies RoomGrant;
      } catch {
        return null;
      }
    },
  };
}
