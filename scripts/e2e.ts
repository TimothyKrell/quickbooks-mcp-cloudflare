// End-to-end test of the bundled Worker in workerd, with Intuit and the
// QuickBooks API mocked through Miniflare's outbound fetch hook. Run with
// `npm test`, which bundles src/worker.ts with rolldown (as alchemy does).
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { Miniflare, type MiniflareOptions, Request as MfRequest, Response as MfResponse } from "miniflare";
import { build } from "rolldown";

await build({
  input: "src/worker.ts",
  platform: "browser",
  external: [/^cloudflare:/, /^node:/],
  resolve: { conditionNames: ["workerd", "worker", "browser", "import", "default"] },
  output: { file: "dist/worker.js", format: "esm" },
  logLevel: "warn",
});

const BASE = "http://localhost:8787";
const CLIENT_REDIRECT = "http://localhost:9999/cb";
const REALM = "9130";

// ---- Mock Intuit ----------------------------------------------------------

interface Call {
  method: string;
  url: string;
  body: string;
  auth: string | null;
}
const calls: Call[] = [];
const revokedRefreshTokens = new Set<string>();
const users: Record<string, Record<string, unknown>> = {
  "at-owner-1": { sub: "owner-sub", email: "owner@example.com", emailVerified: true },
  "at-intruder": { sub: "intruder-sub", email: "intruder@example.com", emailVerified: true },
  "at-unverified": { sub: "unverified-sub", email: "owner@example.com", email_verified: "false" },
};
const codes: Record<string, string> = {
  "code-owner": "owner-1",
  "code-intruder": "intruder",
  "code-unverified": "unverified",
};

async function intuit(request: MfRequest): Promise<MfResponse> {
  const url = new URL(request.url);
  const body = request.method === "POST" ? await request.text() : "";
  calls.push({ method: request.method, url: url.href, body, auth: request.headers.get("authorization") });

  if (url.host === "oauth.platform.intuit.com") {
    assert.equal(request.headers.get("authorization"), `Basic ${btoa("cid:csecret")}`);
    const form = new URLSearchParams(body);
    if (form.get("grant_type") === "authorization_code") {
      assert.equal(form.get("redirect_uri"), `${BASE}/callback`);
      const id = codes[form.get("code") ?? ""];
      if (!id) return MfResponse.json({ error: "invalid_grant" }, { status: 400 });
      return tokens(`at-${id}`, `rt-${id}`);
    }
    const refresh = form.get("refresh_token") ?? "";
    if (revokedRefreshTokens.has(refresh)) return MfResponse.json({ error: "invalid_grant" }, { status: 400 });
    const n = Number(refresh.split("-").pop()) + 1;
    return tokens(`at-owner-${n}`, `rt-owner-${n}`);
  }

  if (url.host === "sandbox-accounts.platform.intuit.com") {
    const token = request.headers.get("authorization")?.replace("Bearer ", "") ?? "";
    return MfResponse.json(users[token] ?? users["at-owner-1"]);
  }

  if (url.host === "developer.api.intuit.com") return new MfResponse(null, { status: 200 });

  if (url.host === "sandbox-quickbooks.api.intuit.com") {
    assert.equal(url.searchParams.get("minorversion"), "75");
    assert.match(request.headers.get("authorization") ?? "", /^Bearer at-owner-\d+$/);
    const path = url.pathname.replace(`/v3/company/${REALM}/`, "");
    const op = url.searchParams.get("operation");
    if (path === `companyinfo/${REALM}`) return MfResponse.json({ CompanyInfo: { CompanyName: "Test Co" } });
    if (path === "query") {
      if (url.searchParams.get("query")?.includes("Bogus")) {
        return MfResponse.json(
          { Fault: { Error: [{ Message: "Invalid query", Detail: "Bogus is not an entity", code: "4000" }] } },
          { status: 400, headers: { intuit_tid: "tid-123" } },
        );
      }
      return MfResponse.json({ QueryResponse: { Invoice: [{ Id: "1", TotalAmt: 150 }], maxResults: 1 } });
    }
    if (path === "reports/ProfitAndLoss") return MfResponse.json(PNL);
    if (request.method === "GET" && /^(customer|invoice)\/\d+$/.test(path)) {
      const [entity, id] = path.split("/");
      const name = entity === "customer" ? "Customer" : "Invoice";
      return MfResponse.json({ [name]: { Id: id, SyncToken: "7" } });
    }
    if (request.method === "POST" && path === "customer") return MfResponse.json({ Customer: JSON.parse(body) });
    if (request.method === "POST" && path === "invoice" && op === "delete") {
      return MfResponse.json({ Invoice: { ...JSON.parse(body), status: "Deleted" } });
    }
    if (request.method === "POST" && path === "invoice" && op === "void") {
      return MfResponse.json({ Invoice: { ...JSON.parse(body), PrivateNote: "Voided" } });
    }
  }
  return new MfResponse(`Unexpected outbound request ${request.method} ${url.href}`, { status: 599 });
}

function tokens(access: string, refresh: string) {
  return MfResponse.json({
    token_type: "bearer",
    access_token: access,
    refresh_token: refresh,
    expires_in: 3600,
    x_refresh_token_expires_in: 8_726_400,
  });
}

const PNL = {
  Header: { ReportName: "ProfitAndLoss", StartPeriod: "2026-01-01", EndPeriod: "2026-09-30", Currency: "USD" },
  Columns: { Column: [{ ColTitle: "" }, { ColTitle: "Total" }] },
  Rows: {
    Row: [
      {
        type: "Section",
        Header: { ColData: [{ value: "Income" }, { value: "" }] },
        Rows: { Row: [{ type: "Data", ColData: [{ value: "Sales", id: "1" }, { value: "1500.00" }] }] },
        Summary: { ColData: [{ value: "Total Income" }, { value: "1500.00" }] },
      },
      { type: "Section", Summary: { ColData: [{ value: "Net Income" }, { value: "1500.00" }] } },
    ],
  },
};

// ---- Harness --------------------------------------------------------------

const options: MiniflareOptions = {
  modules: true,
  scriptPath: "dist/worker.js",
  // The standalone Miniflare 4 runtime lags wrangler's compatibility dates.
  compatibilityDate: "2026-08-01",
  compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
  kvNamespaces: ["OAUTH_KV"],
  // The same shapes alchemy.run.ts binds: plain text, JSON and secrets.
  bindings: {
    PUBLIC_URL: BASE,
    QBO_ENVIRONMENT: "sandbox",
    ALLOWED_EMAILS: [" Owner@Example.com", "someone@else.com"],
    ALLOWED_REALM_IDS: [],
    ALLOW_CREATE: true,
    ALLOW_UPDATE: true,
    ALLOW_DELETE: true,
    OPERATOR_NAME: "Acme <Co>",
    OPERATOR_CONTACT: "help@acme.example",
    INTUIT_CLIENT_ID: "cid",
    INTUIT_CLIENT_SECRET: "csecret",
  },
  outboundService: intuit,
};
const mf = new Miniflare(options);

const jar = new Map<string, string>();
async function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (jar.size) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
  const res = await mf.dispatchFetch(new URL(path, BASE), {
    ...(init as ConstructorParameters<typeof MfRequest>[1]),
    headers: Object.fromEntries(headers),
    redirect: "manual",
  });
  for (const cookie of res.headers.getSetCookie()) {
    const [pair, ...attrs] = cookie.split(";");
    const [name = "", value = ""] = (pair ?? "").split("=");
    if (attrs.some((a) => /max-age=0/i.test(a)) || value === "") jar.delete(name.trim());
    else jar.set(name.trim(), value);
  }
  return res;
}

const form = (fields: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (error) {
    console.log(`FAIL - ${name}`);
    throw error;
  }
}

async function registerClient() {
  const res = await request("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Test Client",
      redirect_uris: [CLIENT_REDIRECT],
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { client_id: string }).client_id;
}

/** Runs the browser half of the flow up to the Intuit redirect. */
async function startAuthorization(clientId: string) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CLIENT_REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "client-state",
    resource: `${BASE}/mcp`,
  });
  const consent = await request(`/authorize?${params}`);
  assert.equal(consent.status, 200, await consent.clone().text());
  const html = await consent.text();
  assert.match(html, /Allow Test Client to use your QuickBooks company\?/);
  assert.match(html, /This sends access to an app on your computer/);
  assert.equal(consent.headers.get("x-frame-options"), "DENY");
  const handle = html.match(/name="handle" value="([^"]+)"/)?.[1] ?? assert.fail("no consent handle");
  return { handle, verifier };
}

async function authorize(clientId: string, intuitCode: string) {
  const { handle, verifier } = await startAuthorization(clientId);
  const toIntuit = await request("/authorize", form({ handle, decision: "approve" }));
  assert.equal(toIntuit.status, 302);
  const intuitUrl = new URL(toIntuit.headers.get("location") ?? "");
  assert.equal(intuitUrl.origin + intuitUrl.pathname, "https://appcenter.intuit.com/connect/oauth2");
  assert.equal(intuitUrl.searchParams.get("client_id"), "cid");
  assert.equal(intuitUrl.searchParams.get("redirect_uri"), `${BASE}/callback`);
  assert.equal(intuitUrl.searchParams.get("scope"), "com.intuit.quickbooks.accounting openid email profile");
  const state = intuitUrl.searchParams.get("state") ?? "";
  const callback = await request(`/callback?${new URLSearchParams({ code: intuitCode, state, realmId: REALM })}`);
  return { callback, verifier };
}

interface Session {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

async function exchange(clientId: string, callback: MfResponse, verifier: string): Promise<Session> {
  assert.equal(callback.status, 302, await callback.clone().text());
  const back = new URL(callback.headers.get("location") ?? "");
  assert.equal(back.origin + back.pathname, CLIENT_REDIRECT);
  assert.equal(back.searchParams.get("state"), "client-state");
  const res = await request(
    "/token",
    form({
      grant_type: "authorization_code",
      code: back.searchParams.get("code") ?? "",
      redirect_uri: CLIENT_REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
      resource: `${BASE}/mcp`,
    }),
  );
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()) as Session;
}

// Loose views of the MCP results the tests read.
interface McpResult {
  content: { type: string; text: string }[];
  isError?: boolean;
  tools: { name: string; inputSchema: { type: string }; annotations: Record<string, boolean> }[];
  protocolVersion: string;
  serverInfo: { name: string };
}

let rpcId = 0;
async function mcp(token: string, method: string, params: object = {}): Promise<McpResult> {
  const res = await request("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
  const json = JSON.parse(text) as { result: McpResult; error?: unknown };
  assert.ok(!json.error, JSON.stringify(json.error));
  return json.result;
}

const callTool = async (token: string, name: string, args: object = {}) =>
  mcp(token, "tools/call", { name, arguments: args });
const textOf = (result: McpResult) => result.content.map((c) => c.text).join("\n");
const lastCall = (match: (call: Call) => boolean) => calls.findLast(match) ?? assert.fail("no matching call");

// ---- Tests ----------------------------------------------------------------

try {
  await test("unauthenticated /mcp gets a discovery challenge", async () => {
    const res = await request("/mcp", { method: "POST", body: "{}" });
    assert.equal(res.status, 401);
    assert.match(
      res.headers.get("www-authenticate") ?? "",
      /resource_metadata="http:\/\/localhost:8787\/\.well-known\/oauth-protected-resource\/mcp"/,
    );
    const meta = (await (await request("/.well-known/oauth-protected-resource/mcp")).json()) as { resource: string };
    assert.equal(meta.resource, `${BASE}/mcp`);
    const as = (await (await request("/.well-known/oauth-authorization-server")).json()) as Record<string, string>;
    assert.equal(as.authorization_endpoint, `${BASE}/authorize`);
    assert.equal(as.registration_endpoint, `${BASE}/register`);
  });

  await test("privacy policy and EULA pages are public", async () => {
    for (const [path, title] of [
      ["/privacy", "Privacy Policy"],
      ["/terms", "End-User License Agreement"],
    ] as const) {
      const res = await request(path);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, new RegExp(`<h1>${title}</h1>`));
      assert.match(html, /operated by Acme &#60;Co&#62;\./);
      assert.match(html, /<a href="mailto:help@acme\.example">help@acme\.example<\/a>/);
    }
  });

  const clientId = await registerClient();
  let session: Session = { access_token: "", refresh_token: "", expires_in: 0 };

  await test("full sign-in issues an MCP token aligned to the Intuit token", async () => {
    const { callback, verifier } = await authorize(clientId, "code-owner");
    session = await exchange(clientId, callback, verifier);
    assert.ok(session.access_token && session.refresh_token);
    assert.ok(session.expires_in > 3200 && session.expires_in <= 3300, `expires_in ${session.expires_in}`);
  });

  await test("tools/list honours the ALLOW_* flags", async () => {
    const { tools } = await mcp(session.access_token, "tools/list");
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      "create_entity",
      "delete_entity",
      "get_company_info",
      "get_entity",
      "get_preferences",
      "get_report",
      "query",
      "update_entity",
      "void_transaction",
    ]);
  });

  await test("initialize negotiates a protocol version without a session", async () => {
    const result = await mcp(session.access_token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    assert.equal(result.protocolVersion, "2025-06-18");
    assert.equal(result.serverInfo.name, "QuickBooks Online");
    const future = await mcp(session.access_token, "initialize", { protocolVersion: "2099-01-01" });
    assert.equal(future.protocolVersion, "2025-11-25");
  });

  await test("tool descriptors carry JSON Schema and safety hints", async () => {
    const { tools } = await mcp(session.access_token, "tools/list");
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    assert.equal(byName.get("get_entity")?.inputSchema.type, "object");
    assert.equal(byName.get("get_company_info")?.inputSchema.type, "object");
    assert.deepEqual(byName.get("query")?.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    assert.equal(byName.get("delete_entity")?.annotations.destructiveHint, true);
  });

  await test("the endpoint speaks plain JSON-RPC", async () => {
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      request("/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.access_token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers,
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
    const notification = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(notification.status, 202);
    const unknown = (await (await post({ jsonrpc: "2.0", id: 7, method: "resources/list" })).json()) as {
      id: number;
      error: { code: number };
    };
    assert.deepEqual([unknown.id, unknown.error.code], [7, -32601]);
    const garbage = await post("{nope");
    assert.equal(garbage.status, 400);
    const batch = (await (
      await post([
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "ping" },
      ])
    ).json()) as { id: number }[];
    assert.deepEqual(
      batch.map((r) => r.id),
      [1, 2],
    );
    const badVersion = await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { "mcp-protocol-version": "1999-01-01" });
    assert.equal(badVersion.status, 400);
    const otherSite = await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "https://evil.example" });
    assert.equal(otherSite.status, 403);
    const sse = await request("/mcp", { headers: { authorization: `Bearer ${session.access_token}` } });
    assert.equal(sse.status, 405);
  });

  await test("2026-07-28 clients work without a handshake", async () => {
    const modern = async (method: string, params: object = {}) => {
      const meta = {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
      };
      const res = await request("/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.access_token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": method,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params: { ...params, _meta: meta } }),
      });
      assert.equal(res.status, 200);
      return (await res.json()) as { result: Record<string, unknown> & McpResult; error?: { code: number } };
    };
    const discover = (await modern("server/discover")).result;
    assert.deepEqual(discover.supportedVersions, [
      "2026-07-28",
      "2025-11-25",
      "2025-06-18",
      "2025-03-26",
      "2024-11-05",
    ]);
    assert.equal(discover.resultType, "complete");
    assert.deepEqual(discover._meta, {
      "io.modelcontextprotocol/serverInfo": { name: "QuickBooks Online", version: "2.0.0" },
    });
    const list = (await modern("tools/list")).result;
    assert.equal(list.tools.length, 9);
    assert.deepEqual([list.ttlMs, list.cacheScope], [0, "private"]);
    const info = (await modern("tools/call", { name: "get_company_info", arguments: {} })).result;
    assert.match(textOf(info), /Test Co/);
    assert.equal(info.resultType, "complete");
    assert.equal((await modern("initialize", { protocolVersion: "2026-07-28" })).error?.code, -32601);

    const mismatch = await request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.access_token}`,
        "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2025-11-25" } },
      }),
    });
    assert.equal(((await mismatch.json()) as { error: { code: number } }).error.code, -32020);
  });

  await test("an unknown protocol version lists the supported ones", async () => {
    const res = await request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.access_token}`,
        "content-type": "application/json",
        "mcp-protocol-version": "2099-01-01",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(res.status, 400);
    const { error } = (await res.json()) as { error: { code: number; data: { supported: string[] } } };
    assert.equal(error.code, -32022);
    assert.ok(error.data.supported.includes("2026-07-28"));
  });

  await test("bad tool calls come back as errors the model can read", async () => {
    const unknown = await request("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${session.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "drop_tables" } }),
    });
    assert.equal(((await unknown.json()) as { error: { code: number } }).error.code, -32602);
    const before = calls.length;
    const invalid = await callTool(session.access_token, "get_entity", { entity: "Spaceship", id: "1" });
    assert.equal(invalid.isError, true);
    assert.match(textOf(invalid), /entity/);
    assert.equal(calls.length, before);
  });

  await test("read tools call QuickBooks with the Intuit token", async () => {
    assert.match(textOf(await callTool(session.access_token, "get_company_info")), /Test Co/);
    const q = JSON.parse(textOf(await callTool(session.access_token, "query", { query: "SELECT * FROM Invoice" })));
    assert.equal(q.Invoice[0].TotalAmt, 150);
    const last = lastCall((c) => c.url.includes("/query"));
    assert.equal(last.auth, "Bearer at-owner-1");
  });

  await test("query rejects non-SELECT statements without calling QuickBooks", async () => {
    const before = calls.length;
    const result = await callTool(session.access_token, "query", { query: "DELETE FROM Invoice" });
    assert.equal(result.isError, true);
    assert.equal(calls.length, before);
  });

  await test("QuickBooks faults come back as tool errors", async () => {
    const result = await callTool(session.access_token, "query", { query: "SELECT * FROM Bogus" });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /\[4000\] Invalid query Bogus is not an entity.*intuit_tid tid-123/);
  });

  await test("get_report renders a compact table", async () => {
    const text = textOf(
      await callTool(session.access_token, "get_report", {
        report: "ProfitAndLoss",
        params: { date_macro: "Year to Date" },
      }),
    );
    assert.equal(
      text,
      [
        "ProfitAndLoss 2026-01-01 to 2026-09-30 (USD)",
        " | Total",
        "Income",
        "  Sales | 1500.00",
        "Total Income | 1500.00",
        "Net Income | 1500.00",
      ].join("\n"),
    );
    assert.ok(lastCall((c) => c.url.includes("/reports/")).url.includes("date_macro=Year+to+Date"));
  });

  await test("get_report can return the raw JSON", async () => {
    const json = JSON.parse(
      textOf(await callTool(session.access_token, "get_report", { report: "ProfitAndLoss", format: "json" })),
    ) as typeof PNL;
    assert.equal(json.Header.ReportName, "ProfitAndLoss");
  });

  await test("update_entity looks up the SyncToken and sends a sparse update", async () => {
    await callTool(session.access_token, "update_entity", {
      entity: "Customer",
      data: { Id: "5", DisplayName: "New" },
    });
    const update = lastCall((c) => c.method === "POST" && c.url.includes("/customer?"));
    assert.deepEqual(JSON.parse(update.body), { Id: "5", DisplayName: "New", SyncToken: "7", sparse: true });
  });

  await test("void_transaction voids with the right operation", async () => {
    const voided = JSON.parse(
      textOf(await callTool(session.access_token, "void_transaction", { entity: "Invoice", id: "9" })),
    ) as { PrivateNote: string };
    assert.equal(voided.PrivateNote, "Voided");
    assert.ok(lastCall((c) => c.url.includes("operation=void")).url.includes("/invoice?"));
  });

  await test("delete_entity deactivates list entities and deletes transactions", async () => {
    await callTool(session.access_token, "delete_entity", { entity: "Customer", id: "5" });
    const deactivate = lastCall((c) => c.method === "POST" && c.url.includes("/customer?"));
    assert.deepEqual(JSON.parse(deactivate.body), { Id: "5", Active: false, SyncToken: "7", sparse: true });

    const deleted = JSON.parse(
      textOf(await callTool(session.access_token, "delete_entity", { entity: "Invoice", id: "9" })),
    );
    assert.equal(deleted.status, "Deleted");
    assert.deepEqual(JSON.parse(lastCall((c) => c.url.includes("operation=delete")).body), {
      Id: "9",
      SyncToken: "7",
    });
  });

  await test("ALLOW_* flags hide write tools", async () => {
    await mf.setOptions({
      ...options,
      bindings: { ...options.bindings, ALLOW_CREATE: false, ALLOW_UPDATE: false, ALLOW_DELETE: false },
    });
    const { tools } = await mcp(session.access_token, "tools/list");
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      "get_company_info",
      "get_entity",
      "get_preferences",
      "get_report",
      "query",
    ]);
    await mf.setOptions(options);
  });

  await test("refreshing the MCP token rotates the Intuit tokens", async () => {
    const res = await request(
      "/token",
      form({ grant_type: "refresh_token", refresh_token: session.refresh_token, client_id: clientId }),
    );
    assert.equal(res.status, 200, await res.clone().text());
    session = (await res.json()) as Session;
    const refresh = lastCall((c) => c.url.includes("tokens/bearer"));
    assert.equal(new URLSearchParams(refresh.body).get("refresh_token"), "rt-owner-1");
    await callTool(session.access_token, "get_company_info");
    assert.equal(lastCall((c) => c.url.includes("companyinfo")).auth, "Bearer at-owner-2");
  });

  await test("a revoked Intuit refresh token revokes the MCP grant", async () => {
    revokedRefreshTokens.add("rt-owner-2");
    const res = await request(
      "/token",
      form({ grant_type: "refresh_token", refresh_token: session.refresh_token, client_id: clientId }),
    );
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, "invalid_grant");
    const after = await request("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${session.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(after.status, 401);
  });

  await test("users outside ALLOWED_EMAILS are refused and their Intuit token revoked", async () => {
    const { callback } = await authorize(clientId, "code-intruder");
    assert.equal(callback.status, 403);
    assert.match(await callback.text(), /intruder@example\.com.*isn&#39;t in ALLOWED_EMAILS/);
    await new Promise((r) => setTimeout(r, 100));
    const revoke = lastCall((c) => c.url.includes("tokens/revoke"));
    assert.deepEqual(JSON.parse(revoke.body), { token: "rt-intruder" });
  });

  await test("an allowed email Intuit hasn't verified is refused", async () => {
    const { callback } = await authorize(clientId, "code-unverified");
    assert.equal(callback.status, 403);
    assert.match(await callback.text(), /owner@example\.com.*isn&#39;t verified.*ALLOWED_REALM_IDS/);
  });

  await test("an unverified email is accepted when its company is pinned", async () => {
    await mf.setOptions({ ...options, bindings: { ...options.bindings, ALLOWED_REALM_IDS: [REALM] } });
    jar.clear();
    const id = await registerClient();
    const { callback, verifier } = await authorize(id, "code-unverified");
    await exchange(id, callback, verifier);

    await mf.setOptions({ ...options, bindings: { ...options.bindings, ALLOWED_REALM_IDS: ["1"] } });
    const other = await registerClient();
    const refused = await authorize(other, "code-owner");
    assert.equal(refused.callback.status, 403);
    assert.match(await refused.callback.text(), /isn&#39;t in ALLOWED_REALM_IDS/);
    await mf.setOptions(options);
  });

  await test("Deny sends access_denied back to the client", async () => {
    const { handle } = await startAuthorization(clientId);
    const res = await request("/authorize", form({ handle, decision: "deny" }));
    assert.equal(res.status, 302);
    const back = new URL(res.headers.get("location") ?? "");
    assert.equal(back.searchParams.get("error"), "access_denied");
    assert.equal(back.searchParams.get("state"), "client-state");
  });

  await test("a consent handle can't be replayed", async () => {
    const { handle } = await startAuthorization(clientId);
    await request("/authorize", form({ handle, decision: "approve" }));
    const replay = await request("/authorize", form({ handle, decision: "approve" }));
    assert.equal(replay.status, 400);
  });

  console.log(`\n${passed} passed`);
} finally {
  await mf.dispose();
}
