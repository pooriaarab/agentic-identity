// Failure cases for the documented OIDC exports:
//  1. `googleProvider` uses the Google issuer and the default scopes, and refuses an empty id or secret.
//  2. `finishLogin` throws `OidcError` (exported from the package root) when the provider refuses the code.
import { expect, test } from "vitest";
import { OidcError as RootOidcError, googleProvider } from "../index.js";
import { OidcError, finishLogin } from "./oidc.js";

test("googleProvider is the Google issuer, and needs a client id and secret", () => {
  expect(googleProvider("id", "secret")).toEqual({ issuer: "https://accounts.google.com", clientId: "id", clientSecret: "secret", scopes: ["openid", "email", "profile"] });
  expect(() => googleProvider("", "secret")).toThrow("clientId and clientSecret");
  expect(() => googleProvider("id", "")).toThrow("clientId and clientSecret");
});

test("finishLogin throws OidcError when the provider refuses the code, and the root exports the same class", async () => {
  const provider = googleProvider("id", "secret");
  const fetchImpl = (async (url: string | URL | Request) => {
    const href = String(url);
    if (href.endsWith("/.well-known/openid-configuration")) return Response.json({ issuer: provider.issuer, authorization_endpoint: "https://a.test/auth", token_endpoint: "https://a.test/token", jwks_uri: "https://a.test/jwks" });
    return Response.json({ error: "invalid_grant" }, { status: 400 });
  }) as typeof fetch;
  const error = await finishLogin(provider, { redirectUri: "https://app.test/cb", code: "c", nonce: "n", verifier: "v", now: 1 }, fetchImpl).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(OidcError);
  expect(error).toBeInstanceOf(RootOidcError);
  expect((error as Error).message).toBe("the provider refused the code");
});
