// Failure-mode list for the package contract and the registry. Written before the code.
//  1. A bad package id, a repeated id, or a package with a missing method is refused at register.
//  2. A subject with an empty id, or a missing or unknown kind, is refused. The kind is never defaulted.
//  3. An export that is not plain JSON fails the export and names the package: undefined, NaN,
//     Infinity, a Date, a bigint, a function, a class instance, a loop.
//  4. A bad export shape fails: not an object, a collection that is not a list, a bad collection name
//     (`__proto__`, a slash, upper case).
//  5. One failing exporter aborts the export. No zip is made.
//  6. A package that returns nothing still shows in the manifest. Collections become `<id>/<name>.json`.
//  7. Erase counts that are not whole numbers (negative, fraction, NaN, string) fail that package. The
//     others still run, and the failure is reported.
//  8. Each package gets one audit entry. The entry holds no subject id.
//  9. A package that changes the subject it was given does not change it for the next package.
// 10. Counts are reported for each package that finished, and a failed package has none.
// 11. An empty registry is refused, as an empty app list is.
// 12. A package given the deps it was registered with gets those same deps.
// 13. What JSON would change or drop fails the export: a sparse array, an extra key on an array, a hidden
//     `toJSON`, a symbol key, a getter. The zip holds what the check saw (a getter runs once).
// 14. The subject kind reaches every package unchanged, for export and erase. Nesting past 64 levels fails.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createMemoryStore } from "./adapters/memory.js";
import { AccountExportError, createAccountRegistry, type AccountCounts, type AccountPackage, type AccountRecords, type AccountSubject } from "./account.js";

const ana: AccountSubject = { id: "ana", kind: "human" };
const now = () => 1_700_000_000_000;
const pkg = (id: string, records: unknown = {}, counts: unknown = {}): AccountPackage<unknown> => ({
  id,
  exportAccount: async () => records as AccountRecords,
  eraseAccount: async () => counts as AccountCounts,
});

describe("register", () => {
  test("refuses bad ids, repeats, and missing methods", () => {
    const r = createAccountRegistry();
    for (const id of ["", "Tasks", "a/b", "manifest.json", "../x"]) expect(() => r.register(pkg(id), {})).toThrow("invalid package id");
    expect(() => r.register({ id: "x" } as never, {})).toThrow("needs exportAccount and eraseAccount");
    r.register(pkg("tasks"), {});
    expect(() => r.register(pkg("tasks"), {})).toThrow("duplicate package id");
    expect(r.ids()).toEqual(["tasks"]);
  });
});

describe("subject", () => {
  test("needs an id and a valid kind", async () => {
    const r = createAccountRegistry().register(pkg("tasks"), {});
    for (const bad of [{ id: "", kind: "human" }, { id: "ana" }, { id: "ana", kind: "wizard" }, null, "ana"]) {
      await expect(r.export(bad as never, { now })).rejects.toThrow(/subject/);
      await expect(r.erase(bad as never, createMemoryStore(), { actor: null })).rejects.toThrow(/subject/);
    }
  });
});

describe("export", () => {
  test("writes each collection as a file under the package id", async () => {
    const r = createAccountRegistry()
      .register(pkg("tasks", { boards: [{ id: "b1", title: "x" }], notes: [] }), {})
      .register(pkg("tables"), {});
    const { zip, manifest } = await r.export(ana, { now });
    expect(manifest.apps.map((a) => [a.id, a.files.map((f) => f.path)])).toEqual([["tables", []], ["tasks", ["boards.json", "notes.json"]]]);
    const file = join(mkdtempSync(join(tmpdir(), "reg-")), "a.zip");
    writeFileSync(file, zip);
    expect(execFileSync("unzip", ["-tq", file]).toString()).toContain("No errors");
    expect(JSON.parse(execFileSync("unzip", ["-p", file, "tasks/boards.json"]).toString())).toEqual([{ id: "b1", title: "x" }]);
  });

  test("passes the registered deps through", async () => {
    const seen: unknown[] = [];
    const deps = { marker: 1 };
    const p: AccountPackage<typeof deps> = { id: "a", exportAccount: async (_s, d) => (seen.push(d), {}), eraseAccount: async (_s, d) => (seen.push(d), {}) };
    const r = createAccountRegistry().register(p, deps);
    await r.export(ana, { now });
    await r.erase(ana, createMemoryStore(), { actor: null, now });
    expect(seen).toEqual([deps, deps]);
  });

  test("refuses records that are not plain JSON, and names the package", async () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    class Thing {}
    const shared = { a: 1 };
    const bad: unknown[] = [{ v: undefined }, { v: NaN }, { v: Infinity }, { v: new Date() }, { v: 1n }, { v: () => 1 }, { v: new Thing() }, loop];
    for (const record of bad) {
      const err = await createAccountRegistry().register(pkg("tasks", { rows: [record] }), {}).export(ana, { now }).catch((e) => e);
      expect(err).toBeInstanceOf(AccountExportError);
      expect(err.appId).toBe("tasks");
    }
    const hidden = { a: 1 };
    Object.defineProperty(hidden, "toJSON", { value: () => "swapped", enumerable: false });
    let reads = 0;
    const getter = { get v() { return ++reads === 1 ? 1 : undefined; } };
    class Swap extends Array { toJSON() { return "swapped"; } }
    const sneaky: unknown[] = [Swap.from([1]), new Array(2), Object.assign([1], { secret: "x" }), hidden, { [Symbol("s")]: 1 }, getter];
    for (const record of sneaky) {
      await expect(createAccountRegistry().register(pkg("tasks", { rows: [record] }), {}).export(ana, { now })).rejects.toBeInstanceOf(AccountExportError);
    }
    const ok = await createAccountRegistry().register(pkg("tasks", { rows: [{ x: shared, y: shared }, null, "s", 1.5, [true]] }), {}).export(ana, { now });
    expect(ok.manifest.apps[0]!.files).toHaveLength(1);
  });

  test("limits nesting to 64 levels", async () => {
    const nest = (n: number) => { let v: unknown = 1; for (let i = 0; i < n; i++) v = [v]; return v; };
    await createAccountRegistry().register(pkg("tasks", { rows: [nest(64)] }), {}).export(ana, { now });
    await expect(createAccountRegistry().register(pkg("tasks", { rows: [nest(65)] }), {}).export(ana, { now })).rejects.toBeInstanceOf(AccountExportError);
  });

  test("gives every package the subject's kind unchanged", async () => {
    const seen: AccountSubject[] = [];
    const spy: AccountPackage = { id: "a", exportAccount: async (s) => (seen.push({ ...s }), {}), eraseAccount: async (s) => (seen.push({ ...s }), {}) };
    const bot: AccountSubject = { id: "ana", kind: "agent" };
    const r = createAccountRegistry().register(spy, {});
    await r.export(bot, { now });
    await r.erase(bot, createMemoryStore(), { actor: null, now });
    expect(seen).toEqual([bot, bot]);
  });

  test("refuses a bad shape or collection name", async () => {
    const shapes: unknown[] = [null, [], new Map([["rows", [{ id: 1 }]]]), new Date(), Object.assign(Object.create({ rows: [] }), {}), "x", { rows: {} }, { rows: "x" }, { Rows: [] }, { "a/b": [] }, JSON.parse('{"__proto__": []}')];
    for (const shape of shapes) {
      await expect(createAccountRegistry().register(pkg("tasks", shape), {}).export(ana, { now })).rejects.toBeInstanceOf(AccountExportError);
    }
  });

  test("one failing package aborts the export", async () => {
    const boom: AccountPackage = { id: "tables", exportAccount: async () => { throw new Error("db down"); }, eraseAccount: async () => ({}) };
    const err = await createAccountRegistry().register(pkg("tasks"), {}).register(boom, {}).export(ana, { now }).catch((e) => e);
    expect(err).toBeInstanceOf(AccountExportError);
    expect(err.appId).toBe("tables");
  });

  test("a package id that changes between reads is read once", async () => {
    let reads = 0;
    const flip: AccountPackage = { get id() { return ++reads <= 1 ? "tasks" : "other"; }, exportAccount: async () => ({}), eraseAccount: async () => ({ rows: 1 }) };
    const r = createAccountRegistry().register(flip, {});
    expect(r.ids()).toEqual(["tasks"]);
    const report = await r.erase(ana, createMemoryStore(), { actor: null, now });
    expect([report.results[0]!.appId, Object.keys(report.counts)]).toEqual(["tasks", ["tasks"]]);
  });

  test("an empty registry is refused", async () => {
    await expect(createAccountRegistry().erase(ana, createMemoryStore(), { actor: null, now })).rejects.toThrow("apps are required");
    await expect(createAccountRegistry().export(ana, { now })).rejects.toThrow("apps are required");
  });
});

describe("erase", () => {
  const entries = async (store: ReturnType<typeof createMemoryStore>) => (await store.query("audit", {})).items.map((i) => i.data);

  test("reports counts per package and audits each without the subject id", async () => {
    const store = createMemoryStore();
    const r = createAccountRegistry().register(pkg("tasks", {}, { boards: 2, tasks: 0 }), {}).register(pkg("tables", {}, { rows: 5 }), {});
    const report = await r.erase(ana, store, { actor: null, now });
    expect(report.ok).toBe(true);
    expect(report.counts).toEqual({ tasks: { boards: 2, tasks: 0 }, tables: { rows: 5 } });
    const audit = await entries(store);
    expect(audit.map((e) => e.targetId).sort()).toEqual(["tables", "tasks"]); // keys are random ids, so the order of reads is not the order of writes
    expect(JSON.stringify(audit)).not.toContain(ana.id);
  });

  test("bad counts fail that package and the rest still run", async () => {
    const store = createMemoryStore();
    for (const counts of [new Map([["rows", 3]]), { rows: -1 }, { rows: 1.5 }, { rows: NaN }, { rows: "2" }, { Rows: 1 }, null, [] , 3]) {
      const r = createAccountRegistry().register(pkg("tasks", {}, counts), {}).register(pkg("tables", {}, { rows: 1 }), {});
      const report = await r.erase(ana, store, { actor: null, now });
      expect(report.ok).toBe(false);
      expect(report.results.map((x) => [x.appId, x.ok])).toEqual([["tasks", false], ["tables", true]]);
      expect(report.counts).toEqual({ tables: { rows: 1 } });
    }
    expect((await entries(store)).filter((e) => e.outcome === "denied")).toHaveLength(9);
  });

  test("a throwing eraser is reported and has no counts", async () => {
    const boom: AccountPackage = { id: "tasks", exportAccount: async () => ({}), eraseAccount: async () => { throw new Error("db down"); } };
    const report = await createAccountRegistry().register(boom, {}).register(pkg("tables", {}, { rows: 1 }), {}).erase(ana, createMemoryStore(), { actor: null, now });
    expect(report.results.map((x) => x.ok)).toEqual([false, true]);
    expect(Object.keys(report.counts)).toEqual(["tables"]);
  });

  test("a package cannot change the subject for the next one", async () => {
    const seen: AccountSubject[] = [];
    const mutator: AccountPackage = {
      id: "a",
      exportAccount: async () => ({}),
      eraseAccount: async (s) => {
        try { (s as { id: string }).id = "bob"; } catch { /* frozen */ }
        return {};
      },
    };
    const spy: AccountPackage = { id: "b", exportAccount: async () => ({}), eraseAccount: async (s) => (seen.push({ ...s }), {}) };
    await createAccountRegistry().register(mutator, {}).register(spy, {}).erase(ana, createMemoryStore(), { actor: null, now });
    expect(seen).toEqual([ana]);
  });
});
