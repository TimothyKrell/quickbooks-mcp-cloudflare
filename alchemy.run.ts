import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Config, Effect, Option, Schema } from "effect";

// The infrastructure: a KV namespace for OAuth state and the Worker. Every
// setting comes from the environment (.env locally, the GitHub environment in
// CI), so a deployment's configuration lives outside the code. See README.md.

/** A comma-separated list, trimmed. */
const list = (name: string) =>
  Config.Array(Schema.String, name).pipe(
    Config.map((items) => items.map((item) => item.trim()).filter((item) => item !== "")),
  );

/** Deploy-time settings, read from the environment. */
const settings = Config.all({
  /** Serve on this custom domain (its zone must be in the Cloudflare account) instead of workers.dev. */
  domain: Config.String("QBO_DOMAIN").pipe(Config.option),
  /** Script name for the Worker. Defaults to a name generated from the stack and stage. */
  workerName: Config.String("WORKER_NAME").pipe(Config.option),
  environment: Config.Literals(["sandbox", "production"], "QBO_ENVIRONMENT").pipe(Config.withDefault("sandbox")),
  /** Intuit logins allowed to connect, comma-separated. */
  allowedEmails: list("ALLOWED_EMAILS"),
  /** QuickBooks company IDs allowed, comma-separated. Empty allows any company. */
  allowedRealmIds: list("ALLOWED_REALM_IDS").pipe(Config.withDefault([])),
  // Write tools are off unless turned on.
  allowCreate: Config.Boolean("ALLOW_CREATE").pipe(Config.withDefault(false)),
  allowUpdate: Config.Boolean("ALLOW_UPDATE").pipe(Config.withDefault(false)),
  allowDelete: Config.Boolean("ALLOW_DELETE").pipe(Config.withDefault(false)),
  /** Who runs this server, named on the privacy policy and terms pages Intuit asks for. */
  operatorName: Config.String("OPERATOR_NAME"),
  /** How to reach the operator: a URL or an email address. */
  operatorContact: Config.String("OPERATOR_CONTACT"),
});

const workerEnv = (kv: Cloudflare.KV.Namespace, s: Config.Success<typeof settings>) => ({
  OAUTH_KV: kv,
  PUBLIC_URL: Cloudflare.Worker.URL,
  QBO_ENVIRONMENT: s.environment as "sandbox" | "production",
  ALLOWED_EMAILS: s.allowedEmails,
  ALLOWED_REALM_IDS: s.allowedRealmIds,
  ALLOW_CREATE: s.allowCreate,
  ALLOW_UPDATE: s.allowUpdate,
  ALLOW_DELETE: s.allowDelete,
  OPERATOR_NAME: s.operatorName,
  OPERATOR_CONTACT: s.operatorContact,
  // The Intuit app's keys: Production keys with QBO_ENVIRONMENT=production, Development keys otherwise.
  INTUIT_CLIENT_ID: Config.Redacted("INTUIT_CLIENT_ID"),
  INTUIT_CLIENT_SECRET: Config.Redacted("INTUIT_CLIENT_SECRET"),
});

/** The Worker's bindings, as src/worker.ts sees them. */
export type WorkerEnv = Cloudflare.InferEnv<ReturnType<typeof workerEnv>>;

export default Alchemy.Stack(
  "qbo-mcp",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const s = yield* settings;
    if (s.allowedEmails.length === 0) {
      return yield* Effect.die("Set ALLOWED_EMAILS to the Intuit logins allowed to connect.");
    }

    // Holds MCP clients, grants and tokens, with the Intuit tokens encrypted.
    const kv = yield* Cloudflare.KV.Namespace("OAuthKv");

    const worker = yield* Cloudflare.Worker("Worker", {
      main: "./src/worker.ts",
      ...Option.match(s.workerName, { onNone: () => ({}), onSome: (name) => ({ name }) }),
      ...Option.match(s.domain, { onNone: () => ({}), onSome: (domain) => ({ domain, workersDev: false }) }),
      compatibility: { date: "2026-10-01", flags: ["nodejs_compat", "global_fetch_strictly_public"] },
      env: workerEnv(kv, s),
    });

    return { url: worker.url };
  }),
);
