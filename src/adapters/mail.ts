// Mail adapters. `createHttpMail` posts a message to any HTTP mail API through an injected
// `fetch`. `createCloudflareMail` sends through a Cloudflare Email Workers `send_email` binding.
// Neither one logs, and neither puts an address or a body in an error.
import { assertMailMessage, parseRegion, type AdapterOptions, type Mail, type MailMessage } from "../ports.js";

const ADDRESS = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
const encoder = new TextEncoder();

function assertSender(from: unknown): asserts from is string {
  if (typeof from !== "string" || from.length > 254 || !ADDRESS.test(from)) throw new Error("invalid sender address");
}

/** The HTTP mail API refused a message. It holds the status only, never the message or the reply. */
export class MailError extends Error {
  constructor(readonly httpStatus: number) {
    super(`mail request failed: ${httpStatus}`);
    this.name = "MailError";
  }
}

export interface HttpMailOptions extends AdapterOptions {
  /** The endpoint. It must use https. */
  url: string;
  /** The `fetch` to call. Pass `globalThis.fetch`, or a wrapper that adds retries or tracing. */
  fetch: typeof fetch;
  /** The sender address. */
  from: string;
  /** Sent as `Authorization: Bearer <token>`. Needed by most APIs. */
  token?: string | (() => string | Promise<string>);
  /** Builds the JSON body. Defaults to `{ from, to, subject, text, html? }`. */
  body?: (message: MailMessage, from: string) => unknown;
  /** Gives up on a call after this many milliseconds. Defaults to 10000. */
  timeoutMs?: number;
}

export function createHttpMail(options: HttpMailOptions): Mail {
  const url = new URL(options.url);
  if (url.protocol !== "https:") throw new Error("the mail URL must use https");
  assertSender(options.from);
  const { from } = options;
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError("timeoutMs must be above 0");
  return {
    region: options.region === undefined ? "unknown" : parseRegion(options.region),
    async send(message) {
      assertMailMessage(message);
      const token = typeof options.token === "function" ? await options.token() : options.token;
      const payload = options.body ? options.body(message, from) : { from, to: message.to, subject: message.subject, text: message.text, ...(message.html === undefined ? {} : { html: message.html }) };
      const response = await options.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(payload),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new MailError(response.status);
      // Use the id the API gives, when it gives one. Else make one.
      const reply = (await response.json().catch(() => null)) as { id?: unknown } | null;
      return { id: typeof reply?.id === "string" && reply.id !== "" && reply.id.length <= 256 ? reply.id : crypto.randomUUID() };
    },
  };
}

/** The `send_email` binding of a Worker. */
export interface EmailBindingLike {
  send(message: unknown): Promise<void>;
}

export interface CloudflareMailOptions extends AdapterOptions {
  /** The sender address. Its domain must have Email Routing on. */
  from: string;
  /** The `EmailMessage` class from `cloudflare:email`. It is a parameter so this file stays free of Cloudflare imports. */
  EmailMessage: new (from: string, to: string, raw: string) => unknown;
}

const base64 = (text: string) => (Buffer.from(encoder.encode(text)).toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");

/** An RFC 2047 subject: plain when it is ASCII, else encoded words of at most 45 bytes. */
function encodeSubject(subject: string): string {
  if (/^[\x20-\x7e]*$/.test(subject)) return subject;
  const words: string[] = [];
  let chunk = "";
  for (const char of subject) {
    if (encoder.encode(chunk + char).length > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(encoder.encode(w)).toString("base64")}?=`).join("\r\n ");
}

/** The raw MIME text of a message. `assertMailMessage` and the sender check keep CR and LF out of every header. */
export function buildMime(message: MailMessage, from: string, id: string): string {
  const domain = from.slice(from.indexOf("@") + 1);
  const head = [`From: ${from}`, `To: ${message.to}`, `Subject: ${encodeSubject(message.subject)}`, `Message-ID: <${id}@${domain}>`, "MIME-Version: 1.0"];
  const part = (type: string, text: string) => [`Content-Type: ${type}; charset=utf-8`, "Content-Transfer-Encoding: base64", "", base64(text)].join("\r\n");
  if (message.html === undefined) return [...head, part("text/plain", message.text), ""].join("\r\n");
  const boundary = `=_${crypto.randomUUID()}`;
  return [
    ...head,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    part("text/plain", message.text),
    `--${boundary}`,
    part("text/html", message.html),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

export function createCloudflareMail(binding: EmailBindingLike, options: CloudflareMailOptions): Mail {
  assertSender(options.from);
  const { from } = options;
  return {
    region: options.region === undefined ? "unknown" : parseRegion(options.region),
    async send(message) {
      assertMailMessage(message);
      const id = crypto.randomUUID();
      await binding.send(new options.EmailMessage(from, message.to, buildMime(message, from, id)));
      return { id };
    },
  };
}
