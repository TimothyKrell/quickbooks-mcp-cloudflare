import { Context, Effect, Layer, Option, Schema, Stream } from "effect";
import { Tool } from "effect/ai";
import { HttpClient, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { AppConfig } from "./config.ts";
import { QuickBooks } from "./qbo.ts";
import { isEnabled, QboToolkit, QboToolkitHandlers, type ToolName } from "./tools.ts";

// A stateless Streamable HTTP MCP endpoint. Every POST is answered on its own
// with plain JSON and no session id, so it doesn't matter which Worker isolate
// serves the next request. (Effect's McpServer keeps sessions in memory, which
// breaks as soon as Cloudflare routes a client to another isolate.) Tools are
// defined with Effect's Tool and Toolkit modules in tools.ts.
//
// Two protocol generations are served:
// - 2026-07-28 has no handshake: each request names the version in the
//   MCP-Protocol-Version header and in params._meta, clients learn about the
//   server with server/discover, and results carry resultType and serverInfo.
// - Earlier versions start with initialize. The server never issues a session
//   id, which the spec allows, so those clients are stateless too.

const SERVER_INFO = { name: "QuickBooks Online", version: "2.0.0" };
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const HANDSHAKE_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
const SUPPORTED_PROTOCOL_VERSIONS: ReadonlyArray<string> = [MODERN_PROTOCOL_VERSION, ...HANDSHAKE_PROTOCOL_VERSIONS];
const CAPABILITIES = { tools: { listChanged: false } };

// https://www.jsonrpc.org/specification#error_object
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
// MCP 2026-07-28 error codes.
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

const RequestId = Schema.Union([Schema.String, Schema.Number]);
type RequestId = typeof RequestId.Type;

const Message = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optional(Schema.NullOr(RequestId)),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Unknown),
});

const InitializeParams = Schema.Struct({ protocolVersion: Schema.String });
/**
 * 2026-07-28 requests repeat the protocol version in params._meta. Only that is
 * checked: the server doesn't use the client capabilities sent alongside it,
 * so a client that leaves them out still works.
 */
const ModernRequestMeta = Schema.Struct({
  _meta: Schema.optional(Schema.Struct({ "io.modelcontextprotocol/protocolVersion": Schema.optional(Schema.String) })),
});
const CallToolParams = Schema.Struct({
  name: Schema.String,
  arguments: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
const ToolFailure = Schema.Struct({ message: Schema.String });

type JsonRpcResponse =
  | { readonly jsonrpc: "2.0"; readonly id: RequestId | null; readonly result: object }
  | {
      readonly jsonrpc: "2.0";
      readonly id: RequestId | null;
      readonly error: { readonly code: number; readonly message: string; readonly data?: unknown };
    };

class RpcError extends Schema.TaggedError<RpcError>()("RpcError", {
  code: Schema.Number,
  message: Schema.String,
}) {}

/** 2026-07-28 results say they're complete and who answered; list-like results also say how long to cache. */
const modernResult = (result: object, cacheable: boolean) => ({
  ...result,
  ...(cacheable ? { ttlMs: 0, cacheScope: "private" } : {}),
  resultType: "complete",
  _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO },
});

interface CallToolResult {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  readonly isError?: boolean;
}

const textResult = (text: string, isError = false): CallToolResult => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError } : {}),
});

const isToolName = (name: string): name is ToolName => Object.hasOwn(QboToolkit.tools, name);

const descriptor = (tool: Tool.Any) => ({
  name: tool.name,
  description: Tool.getDescription(tool),
  inputSchema: Tool.getJsonSchema(tool),
  annotations: {
    readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
    destructiveHint: Context.get(tool.annotations, Tool.Destructive),
    idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
    openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
  },
});

/** POST/GET/DELETE /mcp. Each request needs the caller's grant (CurrentGrant). */
export const McpRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const toolkit = yield* QboToolkit;
    // QuickBooks is built per call from the caller's grant and these services.
    const services = yield* Effect.context<AppConfig | HttpClient.HttpClient>();
    const tools = Object.values(QboToolkit.tools)
      .filter((tool) => isEnabled(config, tool.name))
      .map(descriptor);

    const callTool = Effect.fn("mcp.callTool")(function* (params: unknown) {
      const { name, arguments: args = {} } = yield* Schema.decodeUnknownEffect(CallToolParams)(params).pipe(
        Effect.mapError(() => new RpcError({ code: INVALID_PARAMS, message: "tools/call needs a tool name" })),
      );
      if (!isToolName(name) || !isEnabled(config, name)) {
        return yield* new RpcError({ code: INVALID_PARAMS, message: `Unknown tool: ${name}` });
      }
      return yield* toolkit.handle(name, args as never).pipe(
        Effect.flatMap(Stream.runLast),
        Effect.map(
          Option.match({
            onNone: () => textResult("The tool returned nothing.", true),
            onSome: ({ isFailure, encodedResult }) =>
              isFailure
                ? textResult(
                    Option.match(Schema.decodeUnknownOption(ToolFailure)(encodedResult), {
                      onNone: () => JSON.stringify(encodedResult),
                      onSome: (failure) => failure.message,
                    }),
                    true,
                  )
                : textResult(typeof encodedResult === "string" ? encodedResult : JSON.stringify(encodedResult)),
          }),
        ),
        // Bad arguments go back to the model as a tool error so it can retry.
        Effect.catchTag("AiError", (error) => Effect.succeed(textResult(error.message, true))),
        Effect.catchCause((cause) =>
          Effect.logError("Tool call failed", { tool: name }, cause).pipe(
            Effect.as(textResult("The tool failed with an internal error.", true)),
          ),
        ),
        Effect.provide(QuickBooks.layer),
        Effect.provideContext(services),
      );
    });

    type Services = Effect.Services<ReturnType<typeof callTool>>;

    /** Methods of the versions that start with initialize. */
    const dispatchHandshake = (method: string, params: unknown): Effect.Effect<object, RpcError, Services> => {
      switch (method) {
        case "initialize":
          return Schema.decodeUnknownEffect(InitializeParams)(params).pipe(
            Effect.mapError(
              () => new RpcError({ code: INVALID_PARAMS, message: "initialize needs a protocolVersion" }),
            ),
            Effect.map(({ protocolVersion }) => ({
              protocolVersion: (HANDSHAKE_PROTOCOL_VERSIONS as ReadonlyArray<string>).includes(protocolVersion)
                ? protocolVersion
                : HANDSHAKE_PROTOCOL_VERSIONS[0],
              capabilities: CAPABILITIES,
              serverInfo: SERVER_INFO,
            })),
          );
        case "ping":
          return Effect.succeed({});
        case "tools/list":
          return Effect.succeed({ tools });
        case "tools/call":
          return callTool(params);
        default:
          return Effect.fail(new RpcError({ code: METHOD_NOT_FOUND, message: `Method not found: ${method}` }));
      }
    };

    /** Methods of 2026-07-28, after checking the request metadata it requires. */
    const dispatchModern = (method: string, params: unknown): Effect.Effect<object, RpcError, Services> =>
      Effect.gen(function* () {
        const claimed = Option.getOrUndefined(Schema.decodeUnknownOption(ModernRequestMeta)(params ?? {}))?._meta?.[
          "io.modelcontextprotocol/protocolVersion"
        ];
        if (claimed !== undefined && claimed !== MODERN_PROTOCOL_VERSION) {
          return yield* new RpcError({
            code: HEADER_MISMATCH,
            message: "MCP-Protocol-Version header does not match request metadata",
          });
        }
        switch (method) {
          case "server/discover":
            return modernResult({ supportedVersions: SUPPORTED_PROTOCOL_VERSIONS, capabilities: CAPABILITIES }, true);
          case "ping":
            return modernResult({}, false);
          case "tools/list":
            return modernResult({ tools }, true);
          case "tools/call":
            return modernResult(yield* callTool(params), false);
          default:
            return yield* new RpcError({ code: METHOD_NOT_FOUND, message: `Method not found: ${method}` });
        }
      });

    /** The response to one message, or None for notifications and client responses. */
    const handleMessage = (raw: unknown, modern: boolean) =>
      Effect.gen(function* () {
        const message = Schema.decodeUnknownOption(Message)(raw);
        if (Option.isNone(message)) {
          return Option.some(errorResponse(null, INVALID_REQUEST, "Invalid JSON-RPC message"));
        }
        const { id, method, params } = message.value;
        if (method === undefined || id === undefined) return Option.none();
        return yield* (modern ? dispatchModern : dispatchHandshake)(method, params).pipe(
          Effect.map((result): JsonRpcResponse => ({ jsonrpc: "2.0", id, result })),
          Effect.catchTag("RpcError", (error) => Effect.succeed(errorResponse(id, error.code, error.message))),
          Effect.map(Option.some),
        );
      });

    const post = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const protocolVersion = request.headers["mcp-protocol-version"];
      if (protocolVersion !== undefined && !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
        // Tells the client which versions to fall back to.
        return HttpServerResponse.jsonUnsafe(
          errorResponse(null, UNSUPPORTED_PROTOCOL_VERSION, `Unsupported protocol version '${protocolVersion}'`, {
            supported: SUPPORTED_PROTOCOL_VERSIONS,
            requested: protocolVersion,
          }),
          { status: 400 },
        );
      }
      const modern = protocolVersion === MODERN_PROTOCOL_VERSION;
      const body = yield* request.text.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))),
        Effect.option,
      );
      if (Option.isNone(body)) {
        return HttpServerResponse.jsonUnsafe(errorResponse(null, PARSE_ERROR, "Parse error"), { status: 400 });
      }
      const batch = Array.isArray(body.value);
      // 2026-07-28 has no batches.
      if (batch && modern) {
        return HttpServerResponse.jsonUnsafe(errorResponse(null, INVALID_REQUEST, "Batches are not supported"), {
          status: 400,
        });
      }
      const messages = batch ? (body.value as Array<unknown>) : [body.value];
      const responses = (yield* Effect.forEach(messages, (message) => handleMessage(message, modern)))
        .filter(Option.isSome)
        .map((response) => response.value);
      if (responses.length === 0) return HttpServerResponse.empty({ status: 202 });
      return HttpServerResponse.jsonUnsafe(batch ? responses : responses[0]);
    });

    // Rejects browsers on other sites (DNS rebinding); MCP clients send no Origin.
    const checkOrigin = <E, R>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
      HttpServerRequest.HttpServerRequest.use((request) => {
        const origin = request.headers["origin"];
        return origin === undefined || origin === config.publicUrl
          ? handler
          : Effect.succeed(HttpServerResponse.empty({ status: 403 }));
      });

    // No server-initiated stream (GET) and no sessions to end (DELETE).
    const notAllowed = HttpServerResponse.empty({ status: 405, headers: { allow: "POST" } });

    return Layer.mergeAll(
      HttpRouter.add("POST", "/mcp", checkOrigin(post)),
      HttpRouter.add("GET", "/mcp", notAllowed),
      HttpRouter.add("DELETE", "/mcp", notAllowed),
    );
  }),
).pipe(Layer.provide(QboToolkitHandlers));

function errorResponse(id: RequestId | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}
