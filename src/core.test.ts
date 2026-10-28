import { createServer, type Server } from "node:http";
import { describe, expect, test } from "vitest";
import {
  createDryRunResult,
  createGuards,
  createLogger,
  defineBrand,
  dispatchText,
  getCostReport,
  GuardError,
  HttpRouterAdapter,
  LocalRouterAdapter,
  recordCost,
  resetCosts,
  summarizeText,
  VendorError,
  type RouterAdapter,
} from "./core.js";

describe("defineBrand", () => {
  test("freezes the brand", () => {
    const brand = defineBrand({
      name: "Pack",
      command: "pack",
      description: "A pack.",
      keywords: ["a"],
      version: "0.1.0",
    });
    expect(Object.isFrozen(brand)).toBe(true);
    expect(brand.command).toBe("pack");
  });

  test("rejects an empty name", () => {
    expect(() =>
      defineBrand({ name: "  ", command: "pack", description: "", keywords: [], version: "0.1.0" }),
    ).toThrow("brand name must not be empty");
  });
});

describe("createLogger", () => {
  test("quiet mode emits nothing", () => {
    const lines: string[] = [];
    const logger = createLogger({ quiet: true, sink: (line) => lines.push(line) });
    logger.debug("a");
    logger.info("b");
    logger.warn("c");
    logger.error("d");
    expect(lines).toEqual([]);
  });

  test("level filters lower severities", () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "warn", sink: (line) => lines.push(line) });
    logger.debug("a");
    logger.info("b");
    logger.warn("c");
    logger.error("d");
    expect(lines).toEqual(["[warn] c", "[error] d"]);
  });
});

describe("createGuards", () => {
  test("blocklist matches without regard to case", () => {
    const guards = createGuards({ blocklist: ["SeCrEt"] });
    expect(() => guards.checkDispatch("this holds a secret term")).toThrow(GuardError);
    expect(() => guards.checkDispatch("this text is clean")).not.toThrow();
  });

  test("quiet hours block inside the window and pass outside it", () => {
    const at = (hour: number) =>
      createGuards({
        quietHours: { startHour: 1, endHour: 5 },
        now: () => new Date(Date.UTC(2026, 0, 1, hour, 0, 0)),
      });
    expect(() => at(3).checkDispatch("hi")).toThrow(/quiet hours/);
    expect(() => at(6).checkDispatch("hi")).not.toThrow();
  });

  test("quiet hours wrap past midnight", () => {
    const at = (hour: number) =>
      createGuards({
        quietHours: { startHour: 22, endHour: 6 },
        now: () => new Date(Date.UTC(2026, 0, 1, hour, 0, 0)),
      });
    expect(() => at(23).checkDispatch("hi")).toThrow(GuardError);
    expect(() => at(12).checkDispatch("hi")).not.toThrow();
  });

  test("caps count real dispatches", () => {
    const guards = createGuards({ caps: { maxDispatches: 1 } });
    guards.checkDispatch("first");
    guards.recordDispatch();
    expect(guards.dispatchCount).toBe(1);
    expect(() => guards.checkDispatch("second")).toThrow(/cap reached/);
  });
});

describe("summarizeText", () => {
  test("empty text yields zeros", () => {
    expect(summarizeText("")).toEqual({ chars: 0, words: 0, lines: 0, topWords: [] });
  });

  test("counts and ranks words", () => {
    const summary = summarizeText("hello world hello");
    expect(summary.words).toBe(3);
    expect(summary.chars).toBe(17);
    expect(summary.lines).toBe(1);
    expect(summary.topWords[0]).toEqual({ word: "hello", count: 2 });
  });

  test("topN bounds the list", () => {
    const summary = summarizeText("a b c d e f", { topN: 2 });
    expect(summary.topWords).toHaveLength(2);
  });
});

describe("LocalRouterAdapter", () => {
  test("returns a receipt", async () => {
    const receipt = await new LocalRouterAdapter().dispatch("hi");
    expect(receipt.adapter).toBe("local");
    expect(receipt.chars).toBe(2);
    expect(receipt.id.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(receipt.at))).toBe(false);
  });
});

describe("HttpRouterAdapter", () => {
  async function withServer(
    status: number,
    run: (url: string) => Promise<void>,
  ): Promise<void> {
    const server: Server = createServer((_req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      await run(`http://127.0.0.1:${port}/hook`);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }

  test("succeeds on 2xx", async () => {
    await withServer(200, async (url) => {
      const receipt = await new HttpRouterAdapter(url).dispatch("hi");
      expect(receipt.adapter).toBe("http");
      expect(receipt.chars).toBe(2);
    });
  });

  test("throws VendorError on non-2xx, never resolves", async () => {
    await withServer(500, async (url) => {
      const adapter = new HttpRouterAdapter(url);
      const error = await adapter.dispatch("hi").then(
        () => null,
        (value: unknown) => value,
      );
      expect(error).toBeInstanceOf(VendorError);
      expect((error as VendorError).status).toBe(500);
    });
  });

  test("throws VendorError when the host refuses the connection", async () => {
    const adapter = new HttpRouterAdapter("http://127.0.0.1:1/closed", { timeoutMs: 2000 });
    await expect(adapter.dispatch("hi")).rejects.toBeInstanceOf(VendorError);
  });
});

describe("dispatchText", () => {
  test("dry run calls no adapter and records no cost", async () => {
    resetCosts();
    let calls = 0;
    const spy: RouterAdapter = {
      name: "spy",
      dispatch: async () => {
        calls += 1;
        throw new Error("must not run");
      },
    };
    const guards = createGuards();
    const result = await dispatchText("hi", { adapter: spy, guards, dryRun: true });
    expect(result).toEqual({ dryRun: true, adapter: "spy", chars: 2 });
    expect(calls).toBe(0);
    expect(guards.dispatchCount).toBe(0);
    expect(getCostReport().dispatches).toBe(0);
  });

  test("real dispatch records cost and counts the guard", async () => {
    resetCosts();
    const guards = createGuards();
    const result = await dispatchText("hi", { guards });
    expect(result.dryRun).toBe(false);
    expect(result.receipt?.adapter).toBe("local");
    expect(guards.dispatchCount).toBe(1);
    const report = getCostReport();
    expect(report.dispatches).toBe(1);
    expect(report.units).toBe(2);
  });

  test("a denied guard stops the adapter", async () => {
    resetCosts();
    let calls = 0;
    const spy: RouterAdapter = {
      name: "spy",
      dispatch: async (text) => {
        calls += 1;
        return { adapter: "spy", id: "x", chars: text.length, at: new Date().toISOString() };
      },
    };
    const guards = createGuards({ blocklist: ["nope"] });
    await expect(dispatchText("nope nope", { adapter: spy, guards })).rejects.toBeInstanceOf(
      GuardError,
    );
    expect(calls).toBe(0);
    expect(getCostReport().dispatches).toBe(0);
  });

  test("an adapter failure propagates and records no cost", async () => {
    resetCosts();
    const failing: RouterAdapter = {
      name: "failing",
      dispatch: async () => {
        throw new VendorError("downstream is down", { status: 503 });
      },
    };
    await expect(dispatchText("hi", { adapter: failing })).rejects.toThrow("downstream is down");
    expect(getCostReport().dispatches).toBe(0);
  });

  test("createDryRunResult shapes the preview", () => {
    expect(createDryRunResult("hey", "local")).toEqual({
      dryRun: true,
      adapter: "local",
      chars: 3,
    });
  });
});

describe("cost report", () => {
  test("resetCosts clears entries", () => {
    recordCost({ kind: "dispatch", adapter: "local", units: 4 });
    expect(getCostReport().units).toBeGreaterThanOrEqual(4);
    resetCosts();
    expect(getCostReport()).toEqual({ entries: [], dispatches: 0, units: 0 });
  });
});
