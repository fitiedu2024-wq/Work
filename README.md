# Google Merchant MCP

A remote, OAuth-protected MCP server for the `layaldress.com` Google Merchant Center account. Works with any MCP client that supports remote OAuth servers (Cursor, ChatGPT, Claude, and others).

## Remote endpoint

`https://google-merchant-mcp.google-merchant-mcp.workers.dev/mcp`

## Included tools

### Account and settings

- `get_merchant_account` — account details.
- `get_business_info`, `get_business_identity`, `get_homepage` — business profile, identity attributes, homepage claim status.
- `list_users`, `list_account_relationships`, `list_account_services` — access and third-party links.
- `get_automatic_improvements`, `get_autofeed_settings`, `list_programs` — account-level settings and program participation.
- `list_merchant_capabilities` — the full management capability catalog.

### Catalog

- `list_data_sources` — product data sources and which accept API writes.
- `list_products`, `get_product` — processed products with status and issues.
- `upsert_product`, `patch_product`, `delete_product` — product input writes (approval required).

### Regions and inventory

- `list_regions`, `get_region`, `upsert_region`, `delete_region` — regions defined by postal codes or geotarget IDs.
- `list_local_inventory`, `set_local_inventory`, `delete_local_inventory` — per-store price, availability, quantity, pickup.
- `list_regional_inventory`, `set_regional_inventory`, `delete_regional_inventory` — per-region price and availability overrides.

### Shipping, returns, promotions

- `get_shipping_settings`, `replace_shipping_settings` — full shipping configuration with etag protection.
- `list_return_policies`, `get_return_policy` — online return policies.
- `list_promotions`, `get_promotion`, `upsert_promotion` — promotions and approved promotion writes.

### Diagnostics

- `list_account_issues` — account-level issues.
- `list_product_issues` — products filtered by aggregated status (disapproved, limited, eligible, pending) with item-level issues.
- `get_aggregate_product_status` — per-destination, per-country product counts and top issues.
- `render_account_issues`, `render_product_issues` — human-readable issue explanations and resolution links.
- `get_api_quota` — daily Merchant API quota and usage.

### Reports and commerce

- `search_merchant_report` — raw Merchant Query Language reports.
- `get_product_performance` — clicks, impressions, CTR, and conversions for a date range, grouped by offer, brand, category, product type, date, week, country, marketing method, or total.
- `get_price_insights`, `get_price_competitiveness` — suggested prices and benchmark comparisons.
- `list_conversion_sources` — conversion sources and state.
- `list_product_reviews`, `list_merchant_reviews` — uploaded reviews.

### Universal access

- `merchant_api_read` — read any Merchant API route scoped to the configured account.
- `merchant_api_write` — write any Merchant API route scoped to the configured account after explicit approval.
- `batch_merchant_writes` — run an approved batch of up to 20 Merchant writes with bounded concurrency.

The universal scoped routes cover account settings, products, data sources, inventories, promotions, shipping, returns, regions, diagnostics, quotas, reports, conversion sources, reviews, local feeds partnership, loyalty, order tracking, Product Studio, and YouTube Shopping endpoints supported by Google Merchant API.

## Security model

- The MCP endpoint uses OAuth 2.1-compatible authorization through Cloudflare's official OAuth Provider library.
- Google login is restricted to `a.3ayoty89@gmail.com`.
- Merchant API calls use the dedicated service account.
- The service-account JSON, OAuth client secret, and cookie encryption key are Cloudflare Worker secrets and are not stored in this repository.
- Product writes are restricted to data sources belonging to Merchant account `5844649008`.
- Every read tool is annotated read-only.
- Every write tool, including non-destructive updates, is annotated destructive so the MCP client requests approval before execution.
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

The Worker is connected to this repository through Cloudflare Workers Builds. Every push to the production branch installs dependencies and runs `npx wrangler deploy` from the repository root, so the project must stay at the root.

To deploy manually instead:

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
