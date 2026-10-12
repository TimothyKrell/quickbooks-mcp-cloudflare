import { Context, Schema } from "effect";

/** Intuit's tokens for one sign-in. Times are epoch milliseconds. */
export const IntuitTokens = Schema.Struct({
  accessToken: Schema.String,
  accessTokenExpiresAt: Schema.Number,
  refreshToken: Schema.String,
  refreshTokenExpiresAt: Schema.Number,
});
export type IntuitTokens = typeof IntuitTokens.Type;

/**
 * Stored encrypted with each MCP grant (the OAuth provider's "props") and
 * handed to the MCP endpoint with every request. The Intuit tokens are rotated
 * whenever the MCP client refreshes its own token. Keep the shape compatible
 * with grants already in KV.
 */
export const Grant = Schema.Struct({
  ...IntuitTokens.fields,
  realmId: Schema.String,
  email: Schema.String,
});
export type Grant = typeof Grant.Type;

export const decodeGrant = Schema.decodeUnknownEffect(Grant);

/** The grant behind the current MCP request. */
export class CurrentGrant extends Context.Service<CurrentGrant, Grant>()("qbo-mcp/CurrentGrant") {}
