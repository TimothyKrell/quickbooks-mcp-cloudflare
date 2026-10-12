import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";
import { AppConfig, type QboEnvironment } from "./config.ts";
import { CurrentGrant } from "./grant.ts";

const API_BASE: Record<QboEnvironment, string> = {
  production: "https://quickbooks.api.intuit.com",
  sandbox: "https://sandbox-quickbooks.api.intuit.com",
};

// Intuit retired minor versions below 75 in August 2025.
const MINOR_VERSION = "75";

/**
 * Entities the generic tools accept. "list" entities can't be deleted in
 * QuickBooks, only made inactive; "transaction" entities are deleted outright;
 * "readonly" entities can't be written through the API.
 */
export const ENTITIES = {
  Account: "list",
  Attachable: "transaction",
  Bill: "transaction",
  BillPayment: "transaction",
  Class: "list",
  CreditMemo: "transaction",
  Customer: "list",
  Department: "list",
  Deposit: "transaction",
  Employee: "list",
  Estimate: "transaction",
  Invoice: "transaction",
  Item: "list",
  JournalEntry: "transaction",
  Payment: "transaction",
  PaymentMethod: "list",
  Purchase: "transaction",
  PurchaseOrder: "transaction",
  RefundReceipt: "transaction",
  SalesReceipt: "transaction",
  TaxAgency: "readonly",
  TaxCode: "readonly",
  TaxRate: "readonly",
  Term: "list",
  TimeActivity: "transaction",
  Transfer: "transaction",
  Vendor: "list",
  VendorCredit: "transaction",
} as const satisfies Record<string, "list" | "transaction" | "readonly">;

export type Entity = keyof typeof ENTITIES;
export type WritableEntity = { [K in Entity]: (typeof ENTITIES)[K] extends "readonly" ? never : K }[Entity];

const entityNames = Object.keys(ENTITIES) as Array<Entity>;

export const EntitySchema = Schema.Literals(entityNames as [Entity, ...Array<Entity>]);
export const WritableEntitySchema = Schema.Literals(
  entityNames.filter((name): name is WritableEntity => ENTITIES[name] !== "readonly") as [
    WritableEntity,
    ...Array<WritableEntity>,
  ],
);

/** How each voidable entity is voided; QuickBooks is inconsistent here. */
export const VOIDABLE = {
  Invoice: { operation: "void" },
  SalesReceipt: { operation: "void" },
  Payment: { operation: "update", include: "void" },
  BillPayment: { operation: "update", include: "void" },
} as const satisfies Partial<Record<Entity, Record<string, string>>>;

export type VoidableEntity = keyof typeof VOIDABLE;
export const VoidableEntitySchema = Schema.Literals(
  Object.keys(VOIDABLE) as [VoidableEntity, ...Array<VoidableEntity>],
);

/** A QuickBooks record or response body, as the API's JSON. */
export const QboRecord = Schema.Record(Schema.String, Schema.Unknown);
export type QboRecord = typeof QboRecord.Type;

const decodeRecord = Schema.decodeUnknownOption(QboRecord);
const Fault = Schema.Struct({
  Error: Schema.optional(
    Schema.Array(
      Schema.Struct({
        Message: Schema.optional(Schema.String),
        Detail: Schema.optional(Schema.String),
        code: Schema.optional(Schema.String),
      }),
    ),
  ),
});
const decodeFault = Schema.decodeUnknownOption(Fault);

/** A failed QuickBooks call, worded for the model to read. */
export class QboError extends Schema.TaggedError<QboError>()("QboError", {
  message: Schema.String,
  status: Schema.Number,
}) {}

export class QuickBooks extends Context.Service<
  QuickBooks,
  {
    readonly query: (statement: string) => Effect.Effect<QboRecord, QboError>;
    readonly get: (entity: Entity, id: string) => Effect.Effect<QboRecord, QboError>;
    readonly create: (entity: WritableEntity, data: QboRecord) => Effect.Effect<QboRecord, QboError>;
    /** Sparse by default, so only the fields given change. Fills in SyncToken if omitted. */
    readonly update: (entity: WritableEntity, data: QboRecord, sparse: boolean) => Effect.Effect<QboRecord, QboError>;
    /** Deletes a transaction, or makes a list entity (customer, vendor, ...) inactive. */
    readonly delete: (entity: WritableEntity, id: string) => Effect.Effect<QboRecord, QboError>;
    readonly void: (entity: VoidableEntity, id: string) => Effect.Effect<QboRecord, QboError>;
    readonly report: (name: string, params: Readonly<Record<string, string>>) => Effect.Effect<QboRecord, QboError>;
    readonly companyInfo: Effect.Effect<QboRecord, QboError>;
    readonly preferences: Effect.Effect<QboRecord, QboError>;
  }
>()("qbo-mcp/QuickBooks") {
  /** A client for the company and tokens of the current grant. */
  static readonly layer = Layer.effect(
    QuickBooks,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const grant = yield* CurrentGrant;
      const http = yield* HttpClient.HttpClient;
      const companyUrl = `${API_BASE[config.environment]}/v3/company/${encodeURIComponent(grant.realmId)}`;

      const request = Effect.fn("QuickBooks.request")(function* (
        method: "GET" | "POST",
        path: string,
        options: { readonly query?: Readonly<Record<string, string>>; readonly body?: QboRecord } = {},
      ) {
        if ((yield* Clock.currentTimeMillis) >= grant.accessTokenExpiresAt) {
          return yield* new QboError({
            message: "The QuickBooks session expired. Reconnect this MCP server to sign in again.",
            status: 401,
          });
        }
        const response = yield* HttpClientRequest.make(method)(`${companyUrl}/${path}`).pipe(
          HttpClientRequest.setUrlParams({ ...options.query, minorversion: MINOR_VERSION }),
          HttpClientRequest.bearerToken(grant.accessToken),
          HttpClientRequest.acceptJson,
          options.body === undefined ? (r) => r : HttpClientRequest.bodyJsonUnsafe(options.body),
          http.execute,
          Effect.mapError(
            (cause) => new QboError({ message: `Couldn't reach QuickBooks: ${cause.message}`, status: 502 }),
          ),
        );
        const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
        // Intuit returns XML or HTML for some auth and gateway errors.
        const body = Option.getOrElse(
          Option.flatMap(Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(text), decodeRecord),
          (): QboRecord => ({}),
        );
        // Some validation errors come back with a 200 status and a Fault body.
        const fault = Option.flatMap(Option.fromNullishOr(body.Fault ?? body.fault), decodeFault);
        if (response.status >= 400 || Option.isSome(fault)) {
          const message = describeFailure(response, Option.getOrUndefined(fault), text);
          // Kept in Workers Logs for troubleshooting with Intuit support (includes intuit_tid).
          yield* Effect.logError("QuickBooks API error").pipe(
            Effect.annotateLogs({ method, path, realmId: grant.realmId, message }),
          );
          return yield* new QboError({ message, status: response.status });
        }
        return body;
      });

      /** The record under `key` in a response body, e.g. body.Invoice. */
      const field = (key: string) => (body: QboRecord) =>
        Option.match(decodeRecord(body[key]), {
          onNone: () => Effect.fail(new QboError({ message: `QuickBooks returned no ${key}.`, status: 502 })),
          onSome: Effect.succeed,
        });

      const get = (entity: Entity, id: string) =>
        request("GET", `${entity.toLowerCase()}/${encodeURIComponent(id)}`).pipe(Effect.flatMap(field(entity)));

      const syncToken = (entity: Entity, id: string) => get(entity, id).pipe(Effect.map((record) => record.SyncToken));

      const update = Effect.fn("QuickBooks.update")(function* (
        entity: WritableEntity,
        data: QboRecord,
        sparse: boolean,
      ) {
        if (typeof data.Id !== "string") {
          return yield* new QboError({ message: "Updates need the entity's Id.", status: 400 });
        }
        const token = data.SyncToken ?? (yield* syncToken(entity, data.Id));
        return yield* request("POST", entity.toLowerCase(), { body: { ...data, SyncToken: token, sparse } }).pipe(
          Effect.flatMap(field(entity)),
        );
      });

      return QuickBooks.of({
        query: (statement) =>
          request("GET", "query", { query: { query: statement } }).pipe(
            Effect.map((body) => Option.getOrElse(decodeRecord(body.QueryResponse), (): QboRecord => ({}))),
          ),
        get,
        create: (entity, data) =>
          request("POST", entity.toLowerCase(), { body: data }).pipe(Effect.flatMap(field(entity))),
        update,
        delete: Effect.fn("QuickBooks.delete")(function* (entity: WritableEntity, id: string) {
          if (ENTITIES[entity] === "list") return yield* update(entity, { Id: id, Active: false }, true);
          const token = yield* syncToken(entity, id);
          return yield* request("POST", entity.toLowerCase(), {
            query: { operation: "delete" },
            body: { Id: id, SyncToken: token },
          }).pipe(Effect.flatMap(field(entity)));
        }),
        void: Effect.fn("QuickBooks.void")(function* (entity: VoidableEntity, id: string) {
          const token = yield* syncToken(entity, id);
          return yield* request("POST", entity.toLowerCase(), {
            query: VOIDABLE[entity],
            body: { Id: id, SyncToken: token, sparse: true },
          }).pipe(Effect.flatMap(field(entity)));
        }),
        report: (name, params) => request("GET", `reports/${encodeURIComponent(name)}`, { query: params }),
        companyInfo: request("GET", `companyinfo/${encodeURIComponent(grant.realmId)}`).pipe(
          Effect.flatMap(field("CompanyInfo")),
        ),
        preferences: request("GET", "preferences").pipe(Effect.flatMap(field("Preferences"))),
      });
    }),
  );
}

function describeFailure(
  response: HttpClientResponse.HttpClientResponse,
  fault: typeof Fault.Type | undefined,
  text: string,
): string {
  const tid = response.headers["intuit_tid"];
  const details = fault?.Error?.map((e) => [e.code && `[${e.code}]`, e.Message, e.Detail].filter(Boolean).join(" "));
  const summary = details?.length ? details.join("; ") : text.slice(0, 500) || `HTTP ${response.status}`;
  const hint =
    response.status === 401
      ? " QuickBooks rejected the access token; disconnect and reconnect this MCP server to sign in again."
      : "";
  return `QuickBooks API error ${response.status}: ${summary}${hint}${tid ? ` (intuit_tid ${tid})` : ""}`;
}
