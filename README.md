# QuickBooks Online MCP server for Cloudflare Workers

A remote [MCP](https://modelcontextprotocol.io) server that gives AI assistants access to your QuickBooks Online company: Claude Code, claude.ai, Claude Desktop, or any client that supports remote MCP servers with OAuth. You deploy it to your own Cloudflare account with your own Intuit app, so your QuickBooks data and tokens never pass through anyone else's service.

By Timothy Krell. It started from Intuit's [quickbooks-online-mcp-server](https://github.com/intuit/quickbooks-online-mcp-server) and is rewritten for Workers in [Effect](https://effect.website), deployed with [Alchemy](https://alchemy.run).

## What you get

- **Generic tools that cover the whole API.** Instead of one tool per entity and action, there are a few tools that work on every entity and report:

  | Tool               | Enabled by     | What it does                                                                               |
  | ------------------ | -------------- | ------------------------------------------------------------------------------------------ |
  | `get_company_info` | always         | Company name, address, fiscal year, ...                                                    |
  | `get_preferences`  | always         | Accounting method, enabled features, defaults                                              |
  | `query`            | always         | QuickBooks query language (`SELECT * FROM Invoice WHERE Balance > '0'`), any entity        |
  | `get_entity`       | always         | One record by Id                                                                           |
  | `get_report`       | always         | Any report (ProfitAndLoss, BalanceSheet, AgedReceivables, ...), as a compact table or JSON |
  | `create_entity`    | `ALLOW_CREATE` | Create any writable entity from its API JSON body                                          |
  | `update_entity`    | `ALLOW_UPDATE` | Sparse update; looks up SyncToken if omitted                                               |
  | `delete_entity`    | `ALLOW_DELETE` | Delete a transaction, or deactivate a list entity (customer, vendor, item, ...)            |
  | `void_transaction` | `ALLOW_DELETE` | Void an Invoice, SalesReceipt, Payment or BillPayment                                      |

  Write tools are off until you turn them on.

- **Sign-in with Intuit, limited to people and companies you choose.** The Worker is its own OAuth server for MCP clients. Users approve the client, sign in to Intuit and pick a company. Only logins in `ALLOWED_EMAILS` and companies in `ALLOWED_REALM_IDS` get through.
- **Tokens that refresh themselves.** Intuit's tokens are stored encrypted with each connection. MCP access tokens expire just before the Intuit token they carry, so refreshing one refreshes the other. If Intuit revokes access, the connection is revoked and the client signs in again.
- **A stateless MCP endpoint.** `/mcp` keeps no sessions, so any Worker instance can answer any request. It speaks MCP 2026-07-28 and the earlier versions that start with `initialize` (2024-11-05 to 2025-11-25).
- **The privacy policy and EULA pages Intuit asks for,** at `/privacy` and `/terms`, naming you as the operator.

## Setting it up

You need a Cloudflare account and an Intuit developer account. Both are free.

### 1. Create an Intuit app

1. At [developer.intuit.com](https://developer.intuit.com), create an app for QuickBooks Online with the **Accounting** scope.
2. Under **Keys and credentials**, copy the Development client ID and secret.
3. Add the redirect URI `https://<your worker's host>/callback`. You'll know the host after the first deploy: `https://qbo.example.com` with a custom domain, or the `workers.dev` URL Alchemy prints.

Development keys only work with sandbox companies, which Intuit creates for you. To connect your real company, you need **Production keys**. Intuit asks for app details first: the privacy policy and EULA URLs (`https://<host>/privacy` and `/terms`), the host domain, and an assessment questionnaire about how the app handles data. Then switch `QBO_ENVIRONMENT` to `production`, use the Production keys, and add the redirect URI on the Production settings too.

### 2. Configure

| Name                                           | Required | What                                                                                                                                                   |
| ---------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CLOUDFLARE_ACCOUNT_ID`                        | yes      | The Cloudflare account to deploy to                                                                                                                    |
| `CLOUDFLARE_API_TOKEN`                         | yes      | An account API token: start from the **Edit Cloudflare Workers** template and add **Secrets Store: Edit** (Alchemy's state store keeps its keys there) |
| `INTUIT_CLIENT_ID` / `INTUIT_CLIENT_SECRET`    | yes      | The Intuit app's keys                                                                                                                                  |
| `QBO_ENVIRONMENT`                              |          | `sandbox` (default) or `production`                                                                                                                    |
| `ALLOWED_EMAILS`                               | yes      | Intuit logins allowed to connect, comma-separated                                                                                                      |
| `ALLOWED_REALM_IDS`                            |          | QuickBooks company IDs allowed, comma-separated. Empty allows any company the user can authorize. The "Not allowed" page shows a company's ID          |
| `ALLOW_CREATE`, `ALLOW_UPDATE`, `ALLOW_DELETE` |          | `true` to turn on the write tools. Default `false`                                                                                                     |
| `OPERATOR_NAME`, `OPERATOR_CONTACT`            | yes      | Who runs the server, and a URL or email to reach them. Shown on the legal pages                                                                        |
| `QBO_DOMAIN`                                   |          | A custom domain (its zone must be in the Cloudflare account). Without it the Worker is on `workers.dev`                                                |
| `WORKER_NAME`                                  |          | The Worker's script name. Defaults to one Alchemy generates                                                                                            |

Pin `ALLOWED_REALM_IDS` to your company once you know its ID. Intuit reports some logins' emails as unverified, and the server only accepts an unverified email when the company is pinned, because then Intuit itself decides who can sign in to it.

### 3a. Deploy with GitHub Actions

1. Fork this repository and enable Actions in the fork's **Actions** tab. Or copy it into a private repository if you'd rather keep your deployment's Actions logs private: they show the non-secret settings.
2. In the repository's **Settings → Environments**, create an environment named `production`, and limit its deployment branches to `main`.
3. Add `CLOUDFLARE_API_TOKEN`, `INTUIT_CLIENT_ID` and `INTUIT_CLIENT_SECRET` as environment **secrets**, and the other settings as environment **variables**.
4. Add a repository variable `DEPLOY` set to `true`.
5. Push to `main`, or run the **Deploy** workflow by hand. Its **plan** option shows what would change without deploying.

Every push and pull request is typechecked and tested. Pushes to `main` deploy.

### 3b. Or deploy from your machine

```sh
npm install
cp .env.example .env   # fill it in
npm run deploy         # alchemy deploy --stage prod
```

`npm run plan` previews changes and `npm run logs` tails the Worker's logs.

Alchemy keeps its state in your Cloudflare account (`Cloudflare.state()`). The first deploy offers to set up its state store Worker. Deploys from CI and from your machine share it.

### 4. Connect a client

- Claude Code: `claude mcp add --transport http quickbooks https://<host>/mcp`, then `/mcp` to sign in.
- claude.ai: Settings → Connectors → Add custom connector → `https://<host>/mcp`.

Each connection is for one company. To use several companies, add the server once per company under different names (`qbo-acme`, `qbo-other`) and pick a different company when signing in to each.

## Code

| File             | What's in it                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| `alchemy.run.ts` | The infrastructure (KV namespace, Worker, domain) and its settings                             |
| `src/worker.ts`  | Entry point. Wires the OAuth provider to the Effect handlers; rotates Intuit tokens on refresh |
| `src/auth.ts`    | Consent page, Intuit redirect and callback, allow-list check                                   |
| `src/mcp.ts`     | The MCP JSON-RPC endpoint                                                                      |
| `src/tools.ts`   | Tool definitions (Effect `Tool`/`Toolkit`, Schema-typed parameters) and handlers               |
| `src/qbo.ts`     | QuickBooks API client                                                                          |
| `src/intuit.ts`  | Intuit OAuth client                                                                            |
| `src/config.ts`  | The Worker's bindings, decoded and validated                                                   |
| `src/grant.ts`   | What's stored with each connection                                                             |
| `src/report.ts`  | Renders report JSON as a compact table                                                         |
| `src/legal.ts`   | Privacy policy and EULA pages                                                                  |

The Worker's `env` type comes from `alchemy.run.ts` (`Cloudflare.InferEnv`), so the code can't drift from the deployed bindings. Responses from Intuit and QuickBooks are decoded with `Schema`, and failures are tagged errors in the type system.

```sh
npm test            # bundles the Worker and runs scripts/e2e.ts in workerd, with Intuit and QuickBooks mocked
npm run typecheck
npx prettier --write .
```

Alchemy 2 is in beta and pinned to an exact version; expect to adjust when upgrading it.

## License

[Apache 2.0](LICENSE). Not affiliated with or endorsed by Intuit. QuickBooks is a trademark of Intuit Inc.
