import { Context, Effect, Layer, Redacted, Schema } from "effect";
import type { Operator } from "./legal.ts";

// The Worker's settings, decoded once per isolate from its bindings. The
// bindings themselves are declared in alchemy.run.ts.

export const QboEnvironment = Schema.Literals(["sandbox", "production"]);
export type QboEnvironment = typeof QboEnvironment.Type;

const Bindings = Schema.Struct({
  PUBLIC_URL: Schema.String.check(Schema.isPattern(/^https?:\/\/[^/]+$/, { message: "an origin with no path" })),
  QBO_ENVIRONMENT: QboEnvironment,
  ALLOWED_EMAILS: Schema.Array(Schema.String),
  ALLOWED_REALM_IDS: Schema.Array(Schema.String),
  ALLOW_CREATE: Schema.Boolean,
  ALLOW_UPDATE: Schema.Boolean,
  ALLOW_DELETE: Schema.Boolean,
  OPERATOR_NAME: Schema.NonEmptyString,
  OPERATOR_CONTACT: Schema.NonEmptyString,
  INTUIT_CLIENT_ID: Schema.NonEmptyString,
  INTUIT_CLIENT_SECRET: Schema.NonEmptyString,
});

export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  message: Schema.String,
}) {}

export class AppConfig extends Context.Service<
  AppConfig,
  {
    /** Origin the Worker is served from, e.g. https://qbo.example.org. */
    readonly publicUrl: string;
    readonly environment: QboEnvironment;
    /** Lowercased. Nobody can connect while it's empty. */
    readonly allowedEmails: ReadonlyArray<string>;
    /** Empty means any company. */
    readonly allowedRealmIds: ReadonlyArray<string>;
    readonly allowCreate: boolean;
    readonly allowUpdate: boolean;
    readonly allowDelete: boolean;
    /** Who runs this deployment, for the legal pages. */
    readonly operator: Operator;
    readonly intuitClientId: string;
    readonly intuitClientSecret: Redacted.Redacted<string>;
  }
>()("qbo-mcp/AppConfig") {
  static readonly fromBindings = (env: unknown) =>
    Layer.effect(
      AppConfig,
      Schema.decodeUnknownEffect(Bindings)(env, { onExcessProperty: "ignore" }).pipe(
        Effect.map((bindings) =>
          AppConfig.of({
            publicUrl: bindings.PUBLIC_URL,
            environment: bindings.QBO_ENVIRONMENT,
            allowedEmails: normalize(bindings.ALLOWED_EMAILS),
            allowedRealmIds: normalize(bindings.ALLOWED_REALM_IDS),
            allowCreate: bindings.ALLOW_CREATE,
            allowUpdate: bindings.ALLOW_UPDATE,
            allowDelete: bindings.ALLOW_DELETE,
            operator: { name: bindings.OPERATOR_NAME, contact: bindings.OPERATOR_CONTACT },
            intuitClientId: bindings.INTUIT_CLIENT_ID,
            intuitClientSecret: Redacted.make(bindings.INTUIT_CLIENT_SECRET),
          }),
        ),
        Effect.mapError((error) => new ConfigError({ message: `Invalid Worker bindings: ${error.message}` })),
      ),
    );
}

const normalize = (values: ReadonlyArray<string>) => values.map((value) => value.trim().toLowerCase()).filter(Boolean);
