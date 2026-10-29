// Failure-mode list for account export and erase. Written before the code.
//  1. A bad app id (empty, upper case, a slash, "manifest.json") or a repeated id is refused.
//  2. A bad file path (absolute, "..", empty part, backslash) or a repeated path is refused.
//  3. One exporter that throws aborts the export with the app id. No zip comes out.
//  4. The same files and the same clock give the same zip bytes, whatever the order of the apps
//     and of the files.
//  5. The zip is a real zip: `unzip -t` accepts it, and the manifest hashes match the content.
//  6. An app with no files still appears in the manifest.
//  7. Erase runs every app. A failing eraser does not stop the rest, and is reported.
//  8. Each app gets one audit entry, `denied` for a failure. The entry holds no subject id.
//  9. A failing audit write is reported, and the erase goes on.
// 10. An empty subject is refused.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createMemoryStore } from "./adapters/memory.js";
import { AccountExportError, eraseAccount, exportAccount, type AccountApp, type AccountFile } from "./account.js";

const app = (id: string, files: AccountFile[] = [], erased: string[] = [], fail = false): AccountApp => ({
  id,
  exportFor: async () => files,
  eraseFor: async (subject) => {
    if (fail) throw new Error("boom");
    erased.push(`${id}:${subject}`);
  },
});
const now = () => 1_700_000_000_000;

describe("exportAccount", () => {
  test("refuses bad app ids and repeats", async () => {
    for (const id of ["", "Docs", "a/b", "manifest.json", "../x"]) await expect(exportAccount("ana", [app(id)], { now })).rejects.toThrow("invalid app id");
    await expect(exportAccount("ana", [app("a"), app("a")], { now })).rejects.toThrow("duplicate app id");
  });

  test("refuses bad file paths and repeats", async () => {
    for (const path of ["", "/etc/x", "../x", "a//b", "a\\b", "./x"]) await expect(exportAccount("ana", [app("a", [{ path, content: "x" }])], { now })).rejects.toThrow("invalid file path");
    await expect(exportAccount("ana", [app("a", [{ path: "x", content: "1" }, { path: "x", content: "2" }])], { now })).rejects.toThrow("duplicate file path");
  });

  test("a failing exporter aborts and names the app", async () => {
    const bad: AccountApp = { id: "tasks", exportFor: async () => { throw new Error("db down"); }, eraseFor: async () => {} };
    const err = await exportAccount("ana", [app("docs", [{ path: "a.json", content: "{}" }]), bad], { now }).catch((e) => e);
    expect(err).toBeInstanceOf(AccountExportError);
    expect(err.appId).toBe("tasks");
    expect(err.message).not.toContain("db down");
  });

  test("is deterministic whatever the order", async () => {
    const files = [{ path: "b.json", content: "2" }, { path: "a/x.txt", content: new Uint8Array([1, 2, 3]) }];
    const one = await exportAccount("ana", [app("docs", files), app("tasks", [{ path: "t.json", content: "[]" }])], { now });
    const two = await exportAccount("ana", [app("tasks", [{ path: "t.json", content: "[]" }]), app("docs", [...files].reverse())], { now });
    expect(Buffer.from(one.zip).equals(Buffer.from(two.zip))).toBe(true);
    expect(one.manifest).toEqual(two.manifest);
  });

  test("makes a real zip whose manifest matches", async () => {
    const { zip, manifest } = await exportAccount("ana", [app("docs", [{ path: "é/doc.json", content: '{"title":"héllo"}' }]), app("empty")], { now });
    expect(manifest.apps.map((a) => a.id)).toEqual(["docs", "empty"]);
    expect(manifest.apps[1]!.files).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), "acct-"));
    const file = join(dir, "out.zip");
    writeFileSync(file, zip);
    expect(execFileSync("unzip", ["-tq", file]).toString()).toContain("No errors");
    const read = (name: string) => execFileSync("unzip", ["-p", file, name]);
    expect(read("docs/é/doc.json").toString()).toBe('{"title":"héllo"}');
    const disk = JSON.parse(read("manifest.json").toString());
    expect(disk).toEqual(manifest);
    expect(manifest.apps[0]!.files[0]).toEqual({
      path: "é/doc.json",
      bytes: 18,
      sha256: (await import("node:crypto")).createHash("sha256").update('{"title":"héllo"}').digest("hex"),
    });
    expect(readFileSync(file).length).toBe(zip.length);
  });

  test("refuses an empty subject", async () => {
    await expect(exportAccount("", [], { now })).rejects.toThrow("subject is required");
  });
});

describe("eraseAccount", () => {
  const entries = async (store: ReturnType<typeof createMemoryStore>) => (await store.query("audit", {})).items.map((i) => i.data);

  test("erases every app and audits each one", async () => {
    const store = createMemoryStore();
    const erased: string[] = [];
    const report = await eraseAccount("ana", [app("docs", [], erased), app("tasks", [], erased)], store, { now });
    expect(report).toEqual({ ok: true, results: [{ appId: "docs", ok: true, audited: true }, { appId: "tasks", ok: true, audited: true }] });
    expect(erased).toEqual(["docs:ana", "tasks:ana"]);
    const log = await entries(store);
    expect(log.map((e) => [e.action, e.targetKind, e.targetId, e.outcome]).sort()).toEqual([
      ["person.erase", "app", "docs", "allowed"],
      ["person.erase", "app", "tasks", "allowed"],
    ]);
    expect(JSON.stringify(log)).not.toContain("ana");
  });

  test("a failing eraser is reported and the rest still run", async () => {
    const store = createMemoryStore();
    const erased: string[] = [];
    const report = await eraseAccount("ana", [app("docs", [], erased, true), app("tasks", [], erased)], store, { now });
    expect(report.ok).toBe(false);
    expect(report.results.map((r) => [r.appId, r.ok])).toEqual([["docs", false], ["tasks", true]]);
    expect(report.results[0]!.error).toBe("boom");
    expect(erased).toEqual(["tasks:ana"]);
    const denied = (await entries(store)).filter((e) => e.outcome === "denied");
    expect(denied.map((e) => e.targetId)).toEqual(["docs"]);
  });

  test("a failing audit write is reported and the erase goes on", async () => {
    const erased: string[] = [];
    const store = { put: async () => { throw new Error("audit down"); } };
    const report = await eraseAccount("ana", [app("docs", [], erased), app("tasks", [], erased)], store, { now });
    expect(report.ok).toBe(false);
    expect(report.results.map((r) => [r.ok, r.audited])).toEqual([[true, false], [true, false]]);
    expect(erased).toHaveLength(2);
  });

  test("refuses an empty subject and bad apps before any erase", async () => {
    const erased: string[] = [];
    await expect(eraseAccount("", [app("docs", [], erased)], createMemoryStore(), { now })).rejects.toThrow("subject is required");
    await expect(eraseAccount("ana", [app("docs", [], erased), app("Bad", [], erased)], createMemoryStore(), { now })).rejects.toThrow("invalid app id");
    expect(erased).toEqual([]);
  });
});
