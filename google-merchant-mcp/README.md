# Google Merchant MCP for ChatGPT Web

A remote, OAuth-protected MCP server for the `layaldress.com` Google Merchant Center account.

## Remote endpoint

`https://google-merchant-mcp.google-merchant-mcp.workers.dev/mcp`

## Included tools

- Read Merchant account details.
- List product data sources.
- List processed products and their issues.
- Get a single product.
- List account-level issues.
- Run Merchant Query Language reports.
- Add or replace a product in an API data source.
- Partially update selected product fields without replacing the full input.
- Delete a product input from a specific data source.
- Read and safely replace complete shipping settings using etag protection.
- Read return policies and promotions, plus approved promotion writes.
- Discover the full Merchant management capability catalog.
- Read any Merchant API route scoped to the configured account.
- Write any Merchant API route scoped to the configured account after explicit approval.
- Run an approved batch of up to 20 Merchant writes with bounded concurrency.

The universal scoped routes cover account settings, products, data sources, inventories, promotions, shipping, returns, regions, diagnostics, quotas, reports, conversion sources, reviews, local feeds partnership, loyalty, order tracking, Product Studio, and YouTube Shopping endpoints supported by Google Merchant API.

## Security model

- The MCP endpoint uses OAuth 2.1-compatible authorization through Cloudflare's official OAuth Provider library.
- Google login is restricted to `a.3ayoty89@gmail.com`.
- Merchant API calls use the dedicated service account.
- The service-account JSON, OAuth client secret, and cookie encryption key are Cloudflare Worker secrets and are not stored in this repository.
- Product writes are restricted to data sources belonging to Merchant account `5844649008`.
- Every read tool is annotated read-only.
- Every write tool, including non-destructive updates, is annotated destructive so ChatGPT requests approval before execution.
- Universal API paths are allowlisted to Google Merchant sub-APIs and must contain only account `5844649008`; cross-account paths, external hosts, traversal, and hidden query strings are rejected.
- Batch writes are capped at 20 operations and five concurrent requests.
- Shipping replacement re-reads and verifies the current etag before sending the full replacement.

## Local checks

```sh
npm install
npm run type-check
npm run dev
```

## Deploy

```sh
npm run deploy
```

Required Worker secrets:

- `GOOGLE_SERVICE_ACCOUNT_JSON`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `COOKIE_ENCRYPTION_KEY`

The Google OAuth Web client must allow this callback:

`https://google-merchant-mcp.google-merchant-mcp.workers.dev/callback`
