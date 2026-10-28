// Starts the real Worker under `wrangler dev` with a local D1 database, for the end-to-end tests.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Ask the OS for a free port, so a run never meets a server left from another run.
const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

export async function startWorker(): Promise<{ origin: string; stop(): void }> {
  const port = await freePort();
  const args = ["wrangler", "dev", "--port", String(port), "--persist-to", mkdtempSync(join(tmpdir(), "ai-")), "--var", "IDENTITY_UNSAFE_TEST_MINT:1", "--var", "REGION:unknown"];
  const wrangler: ChildProcess = spawn("npx", args, { stdio: "pipe", detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  let log = "";
  wrangler.stdout?.on("data", (d) => (log += d));
  wrangler.stderr?.on("data", (d) => (log += d));
  // Stop the whole process group, so the local runtime does not outlive the test.
  const stop = () => void (wrangler.pid && process.kill(-wrangler.pid));
  for (let i = 0; i < 120 && !log.includes("Ready on"); i++) await new Promise((r) => setTimeout(r, 500));
  if (!log.includes("Ready on")) {
    stop();
    throw new Error(`wrangler did not start:\n${log}`);
  }
  return { origin: `http://127.0.0.1:${port}`, stop };
}
