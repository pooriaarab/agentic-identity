// One contract for a package's personal data, and a registry that runs every registered package.
// A package owns its storage layout. The host never reads the layout: it calls the package.
import type { Json, Store } from "./ports.js";
import { PRINCIPAL_KINDS, type PrincipalKind } from "./core/principals.js";
import { eraseAccount, exportAccount, type AccountApp, type AccountManifest, type AccountOptions, type EraseReport } from "./account.js";

/** Who the account is. The kind is part of the subject: a person and an agent can share an id. */
export interface AccountSubject {
  id: string;
  kind: PrincipalKind;
}

/** What a package holds about a subject: collection name to records. Every record is plain JSON. */
export type AccountRecords = Record<string, Json[]>;

/** What an erase removed: collection name to a count of records. */
export type AccountCounts = Record<string, number>;

/**
 * The contract a package fulfils. `deps` is whatever the package needs to reach its data (a store,
 * a client, a context): the host builds it and the registry passes it through unchanged.
 * `exportAccount` returns `{}` when the package holds nothing. `eraseAccount` must be safe to run twice.
 */
export interface AccountPackage<Deps = unknown> {
  /** A short stable id: lower case letters, digits, `.`, `_`, `-`. It names the package's folder in the zip. */
  id: string;
  exportAccount(subject: AccountSubject, deps: Deps): Promise<AccountRecords>;
  eraseAccount(subject: AccountSubject, deps: Deps): Promise<AccountCounts>;
}

export interface PackageEraseReport extends EraseReport {
  /** For each package that finished, what it removed. A failed package has no entry. */
  counts: Record<string, AccountCounts>;
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DEPTH_LIMIT = 64;

function checkSubject(subject: unknown): asserts subject is AccountSubject {
  const s = subject as Partial<AccountSubject> | null | undefined;
  if (typeof s?.id !== "string" || s.id === "") throw new Error("subject needs an id");
  if (!(PRINCIPAL_KINDS as readonly unknown[]).includes(s.kind)) throw new Error("subject needs a valid kind");
}

function isJson(value: unknown, seen: Set<object>, depth: number): value is Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || depth > DEPTH_LIMIT || seen.has(value)) return false;
  seen.add(value);
  let ok: boolean;
  if (Array.isArray(value)) {
    ok = value.every((item) => isJson(item, seen, depth + 1));
  } else {
    const proto = Object.getPrototypeOf(value);
    ok = (proto === Object.prototype || proto === null) && Object.values(value).every((item) => isJson(item, seen, depth + 1));
  }
  seen.delete(value); // a shared child is fine: only a loop is not
  return ok;
}

function checkRecords(records: unknown): asserts records is AccountRecords {
  if (typeof records !== "object" || records === null || Array.isArray(records)) throw new Error("export must be an object of collections");
  for (const [name, list] of Object.entries(records)) {
    if (!NAME.test(name)) throw new Error("invalid collection name");
    if (!Array.isArray(list)) throw new Error("a collection must be a list");
    if (!isJson(list, new Set(), 0)) throw new Error("records must be plain JSON");
  }
}

function checkCounts(counts: unknown): asserts counts is AccountCounts {
  if (typeof counts !== "object" || counts === null || Array.isArray(counts)) throw new Error("erase must return an object of counts");
  for (const [name, n] of Object.entries(counts)) {
    if (!NAME.test(name)) throw new Error("invalid collection name");
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new Error("a count must be a whole number, zero or more");
  }
}

export interface AccountRegistry {
  /** Adds a package with the deps it needs. A repeated id throws. */
  register<Deps>(pkg: AccountPackage<Deps>, deps: Deps): AccountRegistry;
  /** The registered ids, in order of registration. */
  ids(): string[];
  /**
   * Runs every package's `exportAccount` and returns one zip. Each package's collections are files
   * `<package id>/<collection>.json`. One failing package aborts the export, as in `exportAccount`.
   */
  export(subject: AccountSubject, options?: AccountOptions): Promise<{ zip: Uint8Array; manifest: AccountManifest }>;
  /** Runs every package's `eraseAccount`, audits each, and adds what each one removed. Same rules as `eraseAccount`. */
  erase(subject: AccountSubject, store: Pick<Store, "put" | "get">, options?: AccountOptions): Promise<PackageEraseReport>;
}

export function createAccountRegistry(): AccountRegistry {
  const entries: { pkg: AccountPackage<never>; deps: unknown }[] = [];

  const apps = (subject: AccountSubject, counts?: Record<string, AccountCounts>): AccountApp[] => {
    checkSubject(subject);
    const who = Object.freeze({ id: subject.id, kind: subject.kind }); // a package must not change the subject for the next one
    const sameSubject = (id: string) => {
      if (id !== who.id) throw new Error("subject does not match");
    };
    return entries.map(({ pkg, deps }) => ({
      id: pkg.id,
      async exportFor(id) {
        sameSubject(id);
        const records = await pkg.exportAccount(who, deps as never);
        checkRecords(records);
        return Object.entries(records).map(([name, list]) => ({ path: `${name}.json`, content: JSON.stringify(list, null, 2) }));
      },
      async eraseFor(id) {
        sameSubject(id);
        const done = await pkg.eraseAccount(who, deps as never);
        checkCounts(done);
        if (counts) counts[pkg.id] = { ...done };
      },
    }));
  };

  const registry: AccountRegistry = {
    register(pkg, deps) {
      if (typeof pkg?.id !== "string" || !NAME.test(pkg.id) || pkg.id === "manifest.json") throw new Error("invalid package id");
      if (typeof pkg.exportAccount !== "function" || typeof pkg.eraseAccount !== "function") throw new Error("package needs exportAccount and eraseAccount");
      if (entries.some((e) => e.pkg.id === pkg.id)) throw new Error(`duplicate package id "${pkg.id}"`);
      entries.push({ pkg: pkg as AccountPackage<never>, deps });
      return registry;
    },
    ids: () => entries.map((e) => e.pkg.id),
    async export(subject, options) {
      checkSubject(subject);
      return exportAccount(subject.id, apps(subject), options);
    },
    async erase(subject, store, options) {
      checkSubject(subject);
      const counts: Record<string, AccountCounts> = {};
      const report = await eraseAccount(subject.id, apps(subject, counts), store, options);
      return { ...report, counts };
    },
  };
  return registry;
}
