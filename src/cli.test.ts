import { describe, expect, test } from "vitest";
import { parseArgs, runCli, UsageError, type CliIo } from "./cli.js";
import { LocalRouterAdapter } from "./core.js";

function testIo(overrides: Partial<CliIo> = {}): CliIo & { outLines: string[]; errLines: string[] } {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    out: (line) => outLines.push(line),
    err: (line) => errLines.push(line),
    readFile: (path) => `file:${path}`,
    router: new LocalRouterAdapter(),
    ...overrides,
  };
}

describe("parseArgs", () => {
  test("empty args print help", () => {
    expect(parseArgs([]).command).toBe("help");
  });

  test("--version selects version", () => {
    expect(parseArgs(["--version"]).command).toBe("version");
  });

  test("summary takes text and top", () => {
    expect(parseArgs(["summary", "--text", "hi", "--top", "2"])).toEqual({
      command: "summary",
      text: "hi",
      topN: 2,
      dryRun: false,
    });
  });

  test("dispatch takes dry run", () => {
    const request = parseArgs(["dispatch", "--text", "hi", "--dry-run"]);
    expect(request.command).toBe("dispatch");
    expect(request.dryRun).toBe(true);
  });

  test("unknown command throws UsageError", () => {
    expect(() => parseArgs(["frobnicate"])).toThrow(UsageError);
  });

  test("summary without input throws", () => {
    expect(() => parseArgs(["summary"])).toThrow(/needs --text or --file/);
  });

  test("bad top value throws", () => {
    expect(() => parseArgs(["summary", "--text", "hi", "--top", "many"])).toThrow(/--top/);
  });
});

describe("runCli", () => {
  test("summary prints JSON stats", async () => {
    const io = testIo();
    const code = await runCli(["summary", "--text", "hello world hello"], io);
    expect(code).toBe(0);
    expect(JSON.parse(io.outLines[0])).toMatchObject({ words: 3 });
  });

  test("summary reads a file when asked", async () => {
    const io = testIo();
    const code = await runCli(["summary", "--file", "note.txt"], io);
    expect(code).toBe(0);
    expect(JSON.parse(io.outLines[0])).toMatchObject({ words: 1 });
  });

  test("dispatch dry run prints a preview", async () => {
    const io = testIo();
    const code = await runCli(["dispatch", "--text", "hi", "--dry-run"], io);
    expect(code).toBe(0);
    expect(JSON.parse(io.outLines[0])).toMatchObject({ dryRun: true, chars: 2 });
  });

  test("bad usage exits 2", async () => {
    const io = testIo();
    const code = await runCli(["bogus"], io);
    expect(code).toBe(2);
    expect(io.errLines.length).toBeGreaterThan(0);
  });

  test("version prints a version string", async () => {
    const io = testIo();
    const code = await runCli(["--version"], io);
    expect(code).toBe(0);
    expect(io.outLines[0]).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
