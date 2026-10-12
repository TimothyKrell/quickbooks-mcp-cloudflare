import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";
import { HttpServerResponse } from "effect/http";

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const STYLE = `<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 34rem; margin: 3rem auto; padding: 0 1rem; color: #1f2328; }
  .warn { background: #fff8c5; border: 1px solid #d4a72c; border-radius: 6px; padding: .75rem 1rem; }
  button { font: inherit; padding: .5rem 1.25rem; border-radius: 6px; border: 1px solid #d0d7de; background: #f6f8fa; cursor: pointer; }
  button[value=approve] { background: #1f883d; border-color: #1f883d; color: #fff; }
</style>`;

export function consentPage(details: ConsentDescription, handle: string): string {
  const name = escape(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escape(details.clientDomain)}</strong>.`
    : "This app registered itself, so its name isn't verified.";
  const loopback = details.redirectIsLoopback
    ? `<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>`
    : "";
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect ${name} to QuickBooks</title>
${STYLE}
<h1>Allow ${name} to use your QuickBooks company?</h1>
<p>${origin} Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
${loopback}
<p>Next you'll sign in to Intuit and pick a company. ${name} will then be able to use this server's QuickBooks tools on it.</p>
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <p><button name="decision" value="approve">Continue to Intuit</button> <button name="decision" value="deny">Deny</button></p>
</form>`;
}

export function errorPage(status: number, title: string, message: string): HttpServerResponse.HttpServerResponse {
  return HttpServerResponse.html(
    `<!doctype html><meta charset="utf-8"><title>${escape(title)}</title>${STYLE}<h1>${escape(title)}</h1><p>${escape(message)}</p>`,
  ).pipe(HttpServerResponse.setStatus(status));
}
