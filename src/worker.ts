import {
  getOAuthApi,
  OAuthError,
  OAuthProvider,
  type OAuthProviderOptions,
  type TokenExchangeCallbackOptions,
} from "@cloudflare/workers-oauth-provider";
import { Cause, Clock, Context, Effect, Exit, Layer, ManagedRuntime, Option, Schema } from "effect";
import { FetchHttpClient, HttpRouter } from "effect/http";
import type { WorkerEnv } from "../alchemy.run.ts";
import { AuthRoutes, OAuth, WaitUntil } from "./auth.ts";
import { AppConfig } from "./config.ts";
import { CurrentGrant, decodeGrant, Grant } from "./grant.ts";
import { Intuit } from "./intuit.ts";
import { McpRoutes } from "./mcp.ts";

// The Worker's entry point. The OAuth provider (a plain async library) owns the
// request: it serves discovery, registration and /token itself, checks the MCP
// access token on /mcp, and hands everything else to the sign-in routes. Both
// handlers and the token callback are Effect programs over one set of services
// built once per isolate.

// Intuit access tokens last an hour. MCP access tokens expire a few minutes
// before the Intuit token they carry, so the client refreshes (and we rotate
// the Intuit tokens) before a tool call could hit an expired one.
const EXPIRY_MARGIN_SECONDS = 300;

let app: ReturnType<typeof makeApp> | undefined;

export default {
  fetch(request, env, ctx) {
    app ??= makeApp(env);
    return app.provider.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<WorkerEnv>;

function makeApp(env: WorkerEnv) {
  const memoMap = Layer.makeMemoMapUnsafe();
  const services = Intuit.layer.pipe(
    Layer.provideMerge(AppConfig.fromBindings(env)),
    Layer.provideMerge(FetchHttpClient.layer),
  );
  const runtime = ManagedRuntime.make(services, { memoMap });
  const routerOptions = { memoMap, disableLogger: true };
  const auth = HttpRouter.toWebHandler(AuthRoutes.pipe(Layer.provide(services)), routerOptions);
  const mcp = HttpRouter.toWebHandler(McpRoutes.pipe(Layer.provide(services)), routerOptions);
  const publicUrl = env.PUBLIC_URL;

  const options: OAuthProviderOptions<WorkerEnv> = {
    apiRoute: "/mcp",
    apiHandler: {
      fetch: (request, _env, ctx) =>
        Option.match(Schema.decodeUnknownOption(Grant)((ctx as ExecutionContext<unknown>).props), {
          onNone: () => Promise.resolve(Response.json({ error: "invalid_token" }, { status: 401 })),
          onSome: (grant) => mcp.handler(request, Context.make(CurrentGrant, grant)),
        }),
    },
    defaultHandler: {
      fetch: (request, env, ctx) =>
        auth.handler(
          request,
          Context.make(OAuth, getOAuthApi(options, env)).pipe(
            Context.add(WaitUntil, (promise) => ctx.waitUntil(promise)),
          ),
        ),
    },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    // Newer MCP clients identify themselves with a metadata URL instead of registering.
    clientIdMetadataDocumentEnabled: true,
    resourceMetadata: {
      resource: `${publicUrl}/mcp`,
      authorization_servers: [publicUrl],
      resource_name: "QuickBooks Online",
    },
    tokenExchangeCallback: async (options) => {
      const exit = await runtime.runPromiseExit(rotateIntuitTokens(options));
      if (Exit.isSuccess(exit)) return exit.value;
      const error = Cause.findErrorOption(exit.cause);
      if (Option.isSome(error) && error.value._tag === "IntuitTokenError" && error.value.code === "invalid_grant") {
        // Revokes this grant, so the client signs in again instead of retrying.
        throw new OAuthError("invalid_grant", { description: "QuickBooks access was revoked or has expired." });
      }
      await runtime.runPromise(Effect.logError("Intuit token refresh failed", exit.cause));
      throw new OAuthError("temporarily_unavailable", { description: "Intuit is unavailable.", statusCode: 503 });
    },
  };

  return { provider: new OAuthProvider(options) };
}

const rotateIntuitTokens = Effect.fn("rotateIntuitTokens")(function* ({
  grantType,
  props,
}: TokenExchangeCallbackOptions<WorkerEnv>) {
  const current = yield* decodeGrant(props).pipe(Effect.orDie);
  if (grantType === "authorization_code") {
    return {
      accessTokenTTL: (yield* secondsUntil(current.accessTokenExpiresAt)) - EXPIRY_MARGIN_SECONDS,
      refreshTokenTTL: yield* secondsUntil(current.refreshTokenExpiresAt),
    };
  }
  if (grantType !== "refresh_token") return undefined;

  const intuit = yield* Intuit;
  const tokens = yield* intuit.refreshTokens(current.refreshToken);
  return {
    newProps: { ...current, ...tokens } satisfies Grant,
    accessTokenTTL: (yield* secondsUntil(tokens.accessTokenExpiresAt)) - EXPIRY_MARGIN_SECONDS,
    refreshTokenIdleTTL: yield* secondsUntil(tokens.refreshTokenExpiresAt),
  };
});

const secondsUntil = (epochMs: number) =>
  Clock.currentTimeMillis.pipe(
    Effect.map((now) => Math.max(60 + EXPIRY_MARGIN_SECONDS, Math.floor((epochMs - now) / 1000))),
  );
