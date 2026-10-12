// Privacy policy and end-user license agreement, which Intuit requires before
// it issues Production keys. They name the deployment's operator, from the
// OPERATOR_NAME and OPERATOR_CONTACT settings.

const UPDATED = "October 9, 2026";

const STYLE = `<style>
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 42rem; margin: 3rem auto; padding: 0 1rem; color: #1f2328; }
  h2 { font-size: 1.1rem; margin-top: 2rem; }
  .muted { color: #59636e; }
</style>`;

export interface Operator {
  readonly name: string;
  /** A URL or an email address. */
  readonly contact: string;
}

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function contactLink(contact: string): string {
  if (/^[^@\s/]+@[^@\s/]+$/.test(contact)) return `<a href="mailto:${escape(contact)}">${escape(contact)}</a>`;
  const label = URL.canParse(contact) ? new URL(contact).host + new URL(contact).pathname.replace(/\/$/, "") : contact;
  return `<a href="${escape(contact)}">${escape(label)}</a>`;
}

function legalPage(operator: Operator, title: string, body: (name: string, contact: string) => string): string {
  const name = escape(operator.name);
  const product = `${name} QuickBooks Connector`;
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · ${product}</title>
${STYLE}
<h1>${title}</h1>
<p class="muted">${product} · Last updated ${UPDATED}</p>
${body(name, contactLink(operator.contact))}`;
}

export const privacyPolicy = (operator: Operator) =>
  legalPage(
    operator,
    "Privacy Policy",
    (
      name,
      contact,
    ) => `<p>The ${name} QuickBooks Connector (“the Connector”) is an internal tool operated by ${name}. It lets people authorized by ${name} use AI assistants with ${name}'s QuickBooks Online companies. It is not offered to the public.</p>

<h2>What the Connector accesses</h2>
<p>When an authorized user connects an AI assistant, the Connector signs them in through Intuit. With the user's permission, it then accesses the QuickBooks Online company they choose, only to carry out requests made through that assistant.</p>

<h2>What the Connector stores</h2>
<p>For each connection, the Connector stores, encrypted: the Intuit access and refresh tokens, the QuickBooks company ID, and the email address of the user who connected. These are kept while the connection is in use and deleted when it is revoked or expires. The Connector does not keep copies of QuickBooks data; it passes data to the user's AI assistant in response to their requests. Cloudflare, which hosts the Connector, keeps operational request logs for a limited period.</p>

<h2>How data is shared</h2>
<p>QuickBooks data is sent only to the AI assistant the user connected, and is handled under that assistant provider's terms. The Connector relies on Intuit and Cloudflare to operate. ${name} does not sell this data or use it for advertising.</p>

<h2>Disconnecting</h2>
<p>Users can disconnect at any time by removing the connection in their AI assistant, or in QuickBooks Online under Apps → Connected apps. Either revokes the Connector's access.</p>

<h2>Contact</h2>
<p>Questions about this policy can be sent to ${name} at ${contact}.</p>`,
  );

export const termsOfUse = (operator: Operator) =>
  legalPage(
    operator,
    "End-User License Agreement",
    (
      name,
      contact,
    ) => `<p>The ${name} QuickBooks Connector (“the Connector”) is an internal tool operated by ${name}. By connecting to it, you agree to these terms.</p>

<h2>Who may use it</h2>
<p>Only people authorized by ${name} may use the Connector, and only for ${name}'s business. Access is limited to approved Intuit accounts and QuickBooks companies.</p>

<h2>Your responsibilities</h2>
<p>AI assistants can make mistakes. You are responsible for the requests you make through the Connector and for reviewing any records it creates, changes, voids or deletes in QuickBooks Online.</p>

<h2>No warranty</h2>
<p>The Connector is provided “as is”, without warranties of any kind. To the extent permitted by law, ${name} is not liable for any loss arising from its use.</p>

<h2>Changes</h2>
<p>${name} may change these terms, or change or end the Connector, at any time.</p>

<h2>Contact</h2>
<p>Questions about these terms can be sent to ${name} at ${contact}.</p>`,
  );
