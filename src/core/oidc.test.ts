// Failure cases for the documented OIDC exports:
//  1. `googleProvider` uses the Google issuer and the default scopes, and refuses an empty id or secret.
//  2. `finishLogin` throws `OidcError` (exported from the package root) when the provider refuses the code.
//  3. A discovery answer that is not JSON, is `null`, is an error status, or does not arrive is an `OidcError`
//     from `beginLogin` and `finishLogin`. So is a token endpoint that does not arrive, and an id token with bad parts.
import { expect, test } from "vitest";
import { OidcError as RootOidcError, googleProvider } from "../index.js";
import { OidcError, beginLogin, finishLogin } from "./oidc.js";

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

const discovery = (provider: { issuer: string }) => ({ issuer: provider.issuer, authorization_endpoint: "https://a.test/auth", token_endpoint: "https://a.test/token", jwks_uri: "https://a.test/jwks" });
const input = { redirectUri: "https://app.test/cb", code: "c", nonce: "n", verifier: "v", now: 1 };

test("a provider that is down or sends a bad discovery document gives an OidcError, never a raw error", async () => {
  const provider = googleProvider("id", "secret");
  const answers: (() => Response | Promise<Response>)[] = [
    () => new Response("<html>502</html>", { status: 502 }),
    () => new Response("<html>not json</html>", { status: 200 }),
    () => new Response("null", { status: 200 }),
    () => Response.json(discovery(provider), { status: 500 }),
    () => Response.json({ ...discovery(provider), issuer: "https://evil.test" }),
    () => Promise.reject(new TypeError("fetch failed")),
  ];
  for (const answer of answers) {
    const fetchImpl = (async () => answer()) as unknown as typeof fetch;
    await expect(beginLogin(provider, "https://app.test/cb", fetchImpl)).rejects.toThrow(new OidcError("bad discovery document"));
    await expect(finishLogin(provider, input, fetchImpl)).rejects.toThrow(new OidcError("bad discovery document"));
  }
});

test("a token endpoint that does not answer, and an id token with bad parts, give an OidcError", async () => {
  const provider = googleProvider("id", "secret");
  const serve = (token: () => Response | Promise<Response>) => (async (url: string | URL | Request) => (String(url).endsWith("openid-configuration") ? Response.json(discovery(provider)) : token())) as unknown as typeof fetch;
  await expect(finishLogin(provider, input, serve(() => Promise.reject(new TypeError("fetch failed"))))).rejects.toThrow(new OidcError("the provider refused the code"));
  await expect(finishLogin(provider, input, serve(() => new Response("null")))).rejects.toThrow(new OidcError("the provider refused the code"));
  await expect(finishLogin(provider, input, serve(() => Response.json({ id_token: "a.b" })))).rejects.toThrow(new OidcError("bad id token"));
  await expect(finishLogin(provider, input, serve(() => Response.json({ id_token: "x.y.z" })))).rejects.toThrow(OidcError);
});
