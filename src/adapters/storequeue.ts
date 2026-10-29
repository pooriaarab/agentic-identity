// A Queue that keeps its messages in any Store, so it runs wherever a Store runs: D1 on
// Cloudflare, Firestore elsewhere. Nothing delivers by itself. Call `run()` from a cron
// trigger, a scheduled job, or a loop. It delivers every message that is due, retries included.
//
// A message is one doc. `run()` claims a message in a transaction: it adds 1 to `attempt`, and
// it moves `due` forward by the lease. Two runners on one Store cannot both claim a message,
// because the second transaction sees the new `due` or loses the race. A runner that crashes
// leaves the lease to expire, and the message returns with a higher attempt. Delivery is
// at-least-once, so a handler must cope with a repeat.
import { QUEUE_MAX_ATTEMPTS, assertTopic, parseRegion, type AdapterOptions, type Json, type Queue, type QueueHandler, type Store } from "../ports.js";

const COLLECTION = "queue_messages";
const PAGE = 50;

export interface StoreQueueOptions extends Pick<AdapterOptions, "now" | "region"> {
  /** How long a claim holds a message before another runner may take it. Defaults to 60 seconds. */
  leaseSeconds?: number;
}

interface Message {
  [key: string]: Json;
  topic: string;
  body: Json;
  /** Epoch milliseconds. A pending message is deliverable once `due` has passed. */
  due: number;
  /** Deliveries started so far. */
  attempt: number;
  state: "pending" | "dead";
  /** Send order. Equal to the doc id. The store sorts ties by id. */
  key: string;
  /** Names the runner that holds the claim. */
  claim: string;
}

const isMessage = (doc: unknown): doc is Message => {
  const m = doc as Message | null;
  return !!m && typeof m.topic === "string" && typeof m.due === "number" && Number.isFinite(m.due) && Number.isInteger(m.attempt) && (m.state === "pending" || m.state === "dead");
};

export function createStoreQueue(store: Store, options: StoreQueueOptions = {}): Queue & { run(): Promise<void>; dead(topic: string): Promise<Json[]> } {
  const now = options.now ?? Date.now;
  const lease = (options.leaseSeconds ?? 60) * 1000;
  if (!Number.isFinite(lease) || lease <= 0) throw new RangeError("leaseSeconds must be above 0");
  const handlers = new Map<string, QueueHandler>();
  const runner = crypto.randomUUID();
  let counter = 0;

  /** Takes the first due message of a topic, or returns null when none is due. */
  async function claim(topic: string): Promise<{ id: string; message: Message } | null> {
    for (;;) {
      const { items } = await store.query<Message>(COLLECTION, { where: { topic, state: "pending" }, orderBy: { field: "due" }, limit: 1 });
      const head = items[0];
      if (!head || !isMessage(head.data) || head.data.due > now()) return null;
      const outcome = await store.transaction(async (tx) => {
        const current = await tx.get<Message>(COLLECTION, head.id);
        // Another runner took it, or finished it, since the query.
        if (!isMessage(current) || current.state !== "pending" || current.due > now()) return "lost" as const;
        const attempt = current.attempt + 1;
        if (attempt > QUEUE_MAX_ATTEMPTS) {
          // The runners that held it crashed on every attempt.
          await tx.put(COLLECTION, head.id, { ...current, state: "dead", due: now() });
          return "lost" as const;
        }
        const taken: Message = { ...current, attempt, due: now() + lease, claim: `${runner}:${++counter}` };
        await tx.put(COLLECTION, head.id, taken);
        return { id: head.id, message: taken };
      });
      if (outcome !== "lost") return outcome;
    }
  }

  /** Records the result, but only while this runner still holds the claim. */
  async function settle(id: string, held: Message, failed: boolean): Promise<void> {
    await store.transaction(async (tx) => {
      const current = await tx.get<Message>(COLLECTION, id);
      if (!isMessage(current) || current.claim !== held.claim) return;
      if (!failed) await tx.delete(COLLECTION, id);
      else if (held.attempt >= QUEUE_MAX_ATTEMPTS) await tx.put(COLLECTION, id, { ...current, state: "dead", due: now() });
      else await tx.put(COLLECTION, id, { ...current, due: now() });
    });
  }

  return {
    region: options.region === undefined ? store.region : parseRegion(options.region),
    async send(topic, body, opts = {}) {
      assertTopic(topic);
      const delay = opts.delaySeconds ?? 0;
      if (!Number.isInteger(delay) || delay < 0 || delay > 86_400) throw new RangeError("delaySeconds must be an integer from 0 to 86400");
      const text = JSON.stringify(body);
      if (text === undefined) throw new TypeError("the body must be JSON");
      const at = now();
      const key = `${String(at).padStart(15, "0")}-${String(counter++).padStart(8, "0")}-${crypto.randomUUID()}`;
      const message: Message = { topic, body: JSON.parse(text) as Json, due: at + delay * 1000, attempt: 0, state: "pending", key, claim: "" };
      await store.put(COLLECTION, key, message);
    },
    consume(topic, handler) {
      assertTopic(topic);
      if (handlers.has(topic)) throw new Error(`topic "${topic}" already has a handler`);
      handlers.set(topic, handler);
    },
    async run() {
      for (const [topic, handler] of handlers) {
        for (let held = await claim(topic); held; held = await claim(topic)) {
          let failed = false;
          try {
            await handler(held.message.body, { attempt: held.message.attempt });
          } catch {
            failed = true;
          }
          await settle(held.id, held.message, failed);
        }
      }
    },
    async dead(topic) {
      assertTopic(topic);
      const bodies: Json[] = [];
      for (let cursor: string | undefined; ; ) {
        const page = await store.query<Message>(COLLECTION, { where: { topic, state: "dead" }, orderBy: { field: "key" }, limit: PAGE, ...(cursor === undefined ? {} : { cursor }) });
        bodies.push(...page.items.map((item) => item.data.body));
        if ((cursor = page.nextCursor) === undefined) return bodies;
      }
    },
  };
}
