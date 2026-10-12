import {
  AuthorizationError,
  authorizationErrorRedirect,
  CimdFetchError,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { Cause, Context, Effect, Layer, Option, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { AppConfig } from "./config.ts";
import type { Grant } from "./grant.ts";
import { Intuit } from "./intuit.ts";
import { privacyPolicy, termsOfUse } from "./legal.ts";
import { consentPage, errorPage } from "./pages.ts";

// The MCP client authorizes against this Worker, which asks for consent and
// then sends the user to Intuit. Intuit's callback finishes the MCP grant with
// the Intuit tokens stored in its props. The consent and state helpers bind
// every step to the browser that started it; see the OAuth provider's
// docs/upstream-sign-in.md.

/** The OAuth provider's helpers for the current request. */
export class OAuth extends Context.Service<OAuth, OAuthHelpers>()("qbo-mcp/OAuth") {}

/** Keeps the Worker alive for work that finishes after the response. */
export class WaitUntil extends Context.Service<WaitUntil, (promise: Promise<unknown>) => void>()("qbo-mcp/WaitUntil") {}

class AuthorizationFailed extends Schema.TaggedError<AuthorizationFailed>()("AuthorizationFailed", {
  description: Schema.String,
  redirectTo: Schema.optional(Schema.String),
}) {}

class ClientNotVerified extends Schema.TaggedError<ClientNotVerified>()("ClientNotVerified", {
  detail: Schema.String,
}) {}

/** Turns the OAuth helpers' documented errors into typed failures. */
const classify = (error: unknown): Effect.Effect<never, AuthorizationFailed | ClientNotVerified> =>
  error instanceof AuthorizationError
    ? Effect.fail(new AuthorizationFailed({ description: error.description, redirectTo: error.redirectTo }))
    : error instanceof CimdFetchError
      ? Effect.fail(new ClientNotVerified({ detail: error.detail }))
      : Effect.die(error);

const oauth = <A>(
  f: (helpers: OAuthHelpers) => Promise<A>,
): Effect.Effect<A, AuthorizationFailed | ClientNotVerified, OAuth> =>
  OAuth.use((helpers) =>
    Effect.tryPromise({ try: () => f(helpers), catch: (error) => error }).pipe(Effect.catch(classify)),
  );

/** The OAuth helpers read cookies and query parameters from the original Request. */
const rawRequest = HttpServerRequest.HttpServerRequest.useSync((request) => request.source as Request);

const redirect = (location: string, headers: Headers) => {
  headers.set("Location", location);
  return HttpServerResponse.fromWeb(new Response(null, { status: 302, headers }));
};

const ConsentForm = Schema.Struct({ handle: Schema.String, decision: Schema.optional(Schema.String) });
const CallbackParams = Schema.Struct({
  code: Schema.optional(Schema.String),
  realmId: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});

/** Turns sign-in failures into the page or redirect the browser should get. */
const rendered = <E, R>(
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R> =>
  Effect.catchCause(handler, (cause) => {
    const error = Option.getOrUndefined(Cause.findErrorOption(cause));
    if (error instanceof AuthorizationFailed) {
      return Effect.succeed(
        error.redirectTo
          ? HttpServerResponse.redirect(error.redirectTo)
          : errorPage(400, "Authorization failed", error.description),
      );
    }
    if (error instanceof ClientNotVerified) {
      return Effect.succeed(errorPage(400, "Authorization failed", "This app could not be verified."));
    }
    return Effect.logError("Sign-in failed", cause).pipe(
      Effect.as(errorPage(500, "Something went wrong", "The sign-in failed. Check the Worker logs for details.")),
    );
  });

/** Sign-in pages and the legal pages Intuit links to. Each request needs OAuth and WaitUntil. */
export const AuthRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const intuit = yield* Intuit;

    const authorizeGet = Effect.gen(function* () {
      const request = yield* rawRequest;
      const authRequest = yield* oauth((helpers) => helpers.parseAuthRequest(request));
      const details = yield* oauth((helpers) => helpers.describeConsent(authRequest));
      const consent = yield* oauth((helpers) => helpers.beginConsent(authRequest));
      consent.headers.set("Content-Type", "text/html; charset=utf-8");
      return HttpServerResponse.fromWeb(
        new Response(consentPage(details, consent.handle), { headers: consent.headers }),
      );
    });

    const authorizePost = Effect.gen(function* () {
      const request = yield* rawRequest;
      const form = yield* HttpServerRequest.schemaBodyUrlParams(ConsentForm);
      if (form.decision !== "approve") {
        const denied = yield* oauth((helpers) => helpers.denyConsent(request, form.handle));
        return HttpServerResponse.fromWeb(new Response(null, { status: 302, headers: denied.headers }));
      }
      const approved = yield* oauth((helpers) => helpers.approveConsent(request, form.handle));
      const { state, headers } = yield* oauth((helpers) =>
        helpers.beginUpstream(approved.request, { headers: approved.headers }),
      );
      return redirect(intuit.authorizeUrl(state), headers);
    });

    const callback = Effect.gen(function* () {
      const request = yield* rawRequest;
      const { request: authRequest, headers } = yield* oauth((helpers) => helpers.finishUpstream(request));
      const params = yield* HttpServerRequest.schemaSearchParams(CallbackParams);
      if (params.error !== undefined || params.code === undefined || params.realmId === undefined) {
        return redirect(authorizationErrorRedirect(authRequest, "access_denied"), headers);
      }
      const { code, realmId } = params;

      const tokens = yield* intuit.exchangeCode(code);
      const user = yield* intuit.userInfo(tokens.accessToken);
      const refusal = checkAllowed(config, user.email, user.emailVerified, realmId);
      if (Option.isSome(refusal) || user.email === undefined) {
        const waitUntil = yield* WaitUntil;
        waitUntil(Effect.runPromise(intuit.revoke(tokens.refreshToken)));
        return errorPage(
          403,
          "Not allowed",
          Option.getOrElse(refusal, () => "Intuit didn't share an email."),
        );
      }

      const props: Grant = { ...tokens, realmId, email: user.email };
      const { redirectTo } = yield* oauth((helpers) =>
        helpers.completeAuthorization({
          request: authRequest,
          // User IDs can't contain ":".
          userId: user.sub.replaceAll(":", "_"),
          metadata: { email: user.email, realmId },
          scope: authRequest.scope,
          props,
        }),
      );
      return redirect(redirectTo, headers);
    });

    return Layer.mergeAll(
      HttpRouter.add(
        "GET",
        "/",
        HttpServerResponse.text(`QuickBooks Online MCP server. Connect an MCP client to ${config.publicUrl}/mcp`),
      ),
      HttpRouter.add("GET", "/privacy", HttpServerResponse.html(privacyPolicy(config.operator))),
      HttpRouter.add("GET", "/terms", HttpServerResponse.html(termsOfUse(config.operator))),
      HttpRouter.add("GET", "/authorize", rendered(authorizeGet)),
      HttpRouter.add("POST", "/authorize", rendered(authorizePost)),
      HttpRouter.add("GET", "/callback", rendered(callback)),
    );
  }),
);

/** Why this Intuit user and company can't connect, if they can't. */
export function checkAllowed(
  config: AppConfig["Service"],
  email: string | undefined,
  verified: boolean,
  realmId: string,
): Option.Option<string> {
  const who = `Signed in as ${email ?? "an account with no email"}, company (realm) ID ${realmId}.`;
  if (!config.allowedEmails.length) {
    return Option.some(
      `${who} ALLOWED_EMAILS is empty, so nobody can connect. Add your Intuit email to it and redeploy.`,
    );
  }
  if (!email || !config.allowedEmails.includes(email.toLowerCase())) {
    return Option.some(`${who} That email isn't in ALLOWED_EMAILS.`);
  }
  if (config.allowedRealmIds.length && !config.allowedRealmIds.includes(realmId.toLowerCase())) {
    return Option.some(`${who} That company isn't in ALLOWED_REALM_IDS.`);
  }
  // Anyone can create an Intuit login with an email they don't own, so an
  // unverified email only counts when the company is pinned: Intuit itself
  // decides who can sign in to a given company.
  if (!verified && !config.allowedRealmIds.length) {
    return Option.some(
      `${who} Intuit says this email isn't verified. Verify it in your Intuit account settings, or add this company ID to ALLOWED_REALM_IDS, then connect again.`,
    );
  }
  return Option.none();
}
