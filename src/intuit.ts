import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { AppConfig, type QboEnvironment } from "./config.ts";
import type { IntuitTokens } from "./grant.ts";

// Intuit OAuth 2.0 endpoints, from
// https://developer.api.intuit.com/.well-known/openid_configuration
const AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
const USERINFO_URL: Record<QboEnvironment, string> = {
  production: "https://accounts.platform.intuit.com/v1/openid_connect/userinfo",
  sandbox: "https://sandbox-accounts.platform.intuit.com/v1/openid_connect/userinfo",
};

const SCOPES = "com.intuit.quickbooks.accounting openid email profile";

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_in: Schema.optional(Schema.Number),
  x_refresh_token_expires_in: Schema.optional(Schema.Number),
});

const TokenErrorResponse = Schema.Struct({
  error: Schema.String,
  error_description: Schema.optional(Schema.String),
});

// Intuit documents camelCase claims; accept the OIDC spelling and string booleans too.
const Flag = Schema.optional(Schema.Union([Schema.Boolean, Schema.Literals(["true", "false"])]));
const UserInfoResponse = Schema.Struct({
  sub: Schema.String,
  email: Schema.optional(Schema.NullOr(Schema.String)),
  emailVerified: Flag,
  email_verified: Flag,
});

export interface IntuitUser {
  readonly sub: string;
  readonly email: string | undefined;
  readonly emailVerified: boolean;
}

/** Intuit answered a token request with an OAuth error, e.g. invalid_grant. */
export class IntuitTokenError extends Schema.TaggedError<IntuitTokenError>()("IntuitTokenError", {
  status: Schema.Number,
  code: Schema.String,
  description: Schema.optional(Schema.String),
}) {
  override get message() {
    return `Intuit token request failed (${this.status} ${this.code})${this.description ? `: ${this.description}` : ""}`;
  }
}

/** Intuit couldn't be reached or answered with something unexpected. */
export class IntuitUnavailable extends Schema.TaggedError<IntuitUnavailable>()("IntuitUnavailable", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class Intuit extends Context.Service<
  Intuit,
  {
    readonly authorizeUrl: (state: string) => string;
    readonly callbackUrl: string;
    readonly exchangeCode: (code: string) => Effect.Effect<IntuitTokens, IntuitTokenError | IntuitUnavailable>;
    readonly refreshTokens: (refreshToken: string) => Effect.Effect<IntuitTokens, IntuitTokenError | IntuitUnavailable>;
    readonly userInfo: (accessToken: string) => Effect.Effect<IntuitUser, IntuitUnavailable>;
    /** Best effort: a failure only leaves a token Intuit will expire on its own. */
    readonly revoke: (token: string) => Effect.Effect<void>;
  }
>()("qbo-mcp/Intuit") {
  static readonly layer = Layer.effect(
    Intuit,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const http = yield* HttpClient.HttpClient;
      const callbackUrl = `${config.publicUrl}/callback`;
      const withClientAuth = HttpClientRequest.basicAuth(config.intuitClientId, config.intuitClientSecret);

      const unavailable = (what: string) => (cause: unknown) =>
        new IntuitUnavailable({ message: `Intuit ${what} request failed`, cause });

      const tokenRequest = Effect.fn("Intuit.tokenRequest")(function* (params: Record<string, string>) {
        const response = yield* HttpClientRequest.post(TOKEN_URL).pipe(
          withClientAuth,
          HttpClientRequest.acceptJson,
          HttpClientRequest.bodyUrlParams(params),
          http.execute,
          Effect.mapError(unavailable("token")),
        );
        const body = yield* response.json.pipe(Effect.orElseSucceed(() => ({})));
        if (response.status >= 400) {
          const error = Schema.decodeUnknownOption(TokenErrorResponse)(body);
          return yield* new IntuitTokenError({
            status: response.status,
            code: error.pipe(
              Option.map((e) => e.error),
              Option.getOrElse(() => "invalid_response"),
            ),
            description: Option.getOrUndefined(Option.flatMapNullishOr(error, (e) => e.error_description)),
          });
        }
        const tokens = yield* Schema.decodeUnknownEffect(TokenResponse)(body).pipe(
          Effect.mapError(() => new IntuitTokenError({ status: response.status, code: "invalid_response" })),
        );
        const now = yield* Clock.currentTimeMillis;
        return {
          accessToken: tokens.access_token,
          accessTokenExpiresAt: now + (tokens.expires_in ?? 3600) * 1000,
          refreshToken: tokens.refresh_token,
          refreshTokenExpiresAt: now + (tokens.x_refresh_token_expires_in ?? 8_640_000) * 1000,
        } satisfies IntuitTokens;
      });

      const userInfo = Effect.fn("Intuit.userInfo")(function* (accessToken: string) {
        const claims = yield* HttpClientRequest.get(USERINFO_URL[config.environment]).pipe(
          HttpClientRequest.bearerToken(accessToken),
          HttpClientRequest.acceptJson,
          http.execute,
          Effect.flatMap(okJson),
          Effect.flatMap(Schema.decodeUnknownEffect(UserInfoResponse)),
          Effect.mapError(unavailable("userinfo")),
        );
        const verified = claims.emailVerified ?? claims.email_verified;
        return {
          sub: claims.sub,
          email: claims.email ?? undefined,
          emailVerified: verified === true || verified === "true",
        };
      });

      const revoke = (token: string) =>
        HttpClientRequest.post(REVOKE_URL).pipe(
          withClientAuth,
          HttpClientRequest.acceptJson,
          HttpClientRequest.bodyJsonUnsafe({ token }),
          http.execute,
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.asVoid,
          Effect.catchCause((cause) => Effect.logWarning("Failed to revoke Intuit token", cause)),
        );

      return Intuit.of({
        callbackUrl,
        authorizeUrl: (state) => {
          const url = new URL(AUTHORIZE_URL);
          url.searchParams.set("client_id", config.intuitClientId);
          url.searchParams.set("response_type", "code");
          url.searchParams.set("scope", SCOPES);
          url.searchParams.set("redirect_uri", callbackUrl);
          url.searchParams.set("state", state);
          return url.href;
        },
        exchangeCode: (code) => tokenRequest({ grant_type: "authorization_code", code, redirect_uri: callbackUrl }),
        refreshTokens: (refreshToken) => tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken }),
        userInfo,
        revoke,
      });
    }),
  );
}

/** The response's JSON body, failing on a non-2xx status. */
const okJson = (response: HttpClientResponse.HttpClientResponse) =>
  response.status >= 400 ? Effect.fail(new Error(`HTTP ${response.status}`)) : response.json;
