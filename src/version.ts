import pkg from "../package.json" with { type: "json" };

if (typeof pkg.version !== "string" || pkg.version.length === 0) {
  throw new Error("package.json carries no version string");
}

export const VERSION: string = pkg.version;
