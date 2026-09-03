# Google Merchant MCP

A remote, OAuth-protected MCP server for Google Merchant Center accounts. Works with any MCP client that supports remote OAuth servers (Cursor, ChatGPT, Claude, and others).

One codebase is deployed as one Cloudflare Worker per Merchant Center account. Each account is a Wrangler environment in `wrangler.jsonc`; the code is identical, only the Worker name, OAuth KV namespace, and `MERCHANT_ACCOUNT_ID` differ.

## Deployments

| Store | Merchant account | Wrangler environment | Remote endpoint |
| --- | --- | --- | --- |
| Layal Dress (`layaldress.com`) | `5844649008` | top level (default) | `https://google-merchant-mcp.google-merchant-mcp.workers.dev/mcp` |
| Asom Fashion | `5362919336` | `asom` | `https://google-merchant-asom-fashion-mcp.google-merchant-mcp.workers.dev/mcp` |

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

### Product Studio

- `generate_product_text_suggestions` — AI title and description suggestions from attributes and an optional image.
- `upscale_product_image`, `remove_product_image_background`, `generate_product_image_background` — image fixes and generation; each returns a hosted image URI.

### Data sources and feeds

- `get_data_source`, `create_data_source`, `update_data_source`, `delete_data_source` — data source management (approval required for writes).
- `fetch_data_source` — trigger an immediate fetch of a scheduled data source.
- `get_file_upload_status` — latest upload or fetch result with item counts and issues.

### Issue resolution and notifications

- `trigger_issue_action` — run a built-in action (for example request re-review) using the `action_context` and `action_flow_id` returned by `render_account_issues` / `render_product_issues`.
- `list_notification_subscriptions`, `get_notification_subscription`, `create_notification_subscription`, `update_notification_subscription`, `delete_notification_subscription` — product status and account service webhooks.

### Additional reports

- `get_best_sellers` — best-selling product clusters or brands by country, category, and week or month.
- `get_competitive_visibility` — competitor, top-merchant, and benchmark visibility views.
- `get_non_product_performance` — clicks, impressions, and CTR for non-product surfaces.

### Account, program, and user writes

- `update_business_info`, `update_business_identity` — patch business details and identity attributes.
- `update_homepage`, `claim_homepage`, `unclaim_homepage` — homepage URL and claim.
- `update_autofeed_settings`, `update_automatic_improvements` — crawling and automatic improvement flags.
- `get_program`, `enable_program`, `disable_program` — program participation.
- `get_checkout_settings`, `create_checkout_settings`, `update_checkout_settings`, `delete_checkout_settings` — checkout URL settings per program.
- `get_user`, `create_user`, `update_user`, `delete_user` — account access.
- `get_email_preferences`, `update_email_preferences` — news and tips opt-in.
- `get_ucp_settings`, `update_ucp_settings` — Universal Commerce Protocol settings.
- `create_return_policy`, `update_return_policy`, `delete_return_policy` — return policy writes.
- `list_subaccounts`, `get_terms_of_service_state`, `retrieve_latest_terms_of_service`, `accept_terms_of_service` — account structure and terms.
- `list_gbp_accounts`, `link_gbp_account` — Business Profile links.
- `list_omnichannel_settings`, `get_omnichannel_setting`, `create_omnichannel_setting`, `update_omnichannel_setting`, `request_inventory_verification` — omnichannel setup.

### Commerce signals, conversions, reviews, and local feeds

- `create_order_tracking_signal` — shipment and delivery signals for shipping-speed annotations.
- `get_conversion_source`, `create_conversion_source`, `update_conversion_source`, `delete_conversion_source`, `undelete_conversion_source` — conversion sources.
- `get_product_review`, `insert_product_review`, `delete_product_review`, `get_merchant_review`, `insert_merchant_review`, `delete_merchant_review` — review uploads.
- `list_lfp_stores`, `get_lfp_store`, `insert_lfp_store`, `delete_lfp_store`, `insert_lfp_inventory`, `insert_lfp_sale`, `get_lfp_merchant_state` — local feeds partnership.

### Universal access

- `merchant_api_read` — read any Merchant API route scoped to the configured account.
- `merchant_api_write` — write any Merchant API route scoped to the configured account after explicit approval.
- `batch_merchant_writes` — run an approved batch of up to 20 Merchant writes with bounded concurrency.

The universal scoped routes also cover the remaining endpoints without a dedicated tool, such as loyalty customer matching and YouTube Shopping commission groups and contracts.

## Security model

- The MCP endpoint uses OAuth 2.1-compatible authorization through Cloudflare's official OAuth Provider library.
- Google login is restricted to `a.3ayoty89@gmail.com`.
- Merchant API calls use the dedicated service account.
- The service-account JSON, OAuth client secret, and cookie encryption key are Cloudflare Worker secrets and are not stored in this repository.
- Product writes are restricted to data sources belonging to the Merchant account configured in `MERCHANT_ACCOUNT_ID` for that deployment.
- Every read tool is annotated read-only.
- Every write tool, including non-destructive updates, is annotated destructive so the MCP client requests approval before execution.
- Universal API paths are allowlisted to Google Merchant sub-APIs and must contain only the configured account; cross-account paths, external hosts, traversal, and hidden query strings are rejected.
- Batch writes are capped at 20 operations and five concurrent requests.
- Shipping replacement re-reads and verifies the current etag before sending the full replacement.

## Local checks

```sh
npm install
npm run type-check
npm run dev
```

## Deploy

Both Workers are connected to this repository through Cloudflare Workers Builds and watch the `main` branch. Every push to `main` installs dependencies and deploys from the repository root, so the project must stay at the root.

| Worker | Deploy command |
| --- | --- |
| `google-merchant-mcp` (Layal) | `npx wrangler deploy` |
| `google-merchant-asom-fashion-mcp` (Asom) | `npx wrangler deploy --env asom` |

To deploy manually instead:

```sh
npm run deploy              # Layal
npm run deploy:asom         # Asom Fashion
```

Required Worker secrets (set separately on each Worker):

- `GOOGLE_SERVICE_ACCOUNT_JSON`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `COOKIE_ENCRYPTION_KEY`

The Google OAuth Web client must allow each Worker's callback:

- `https://google-merchant-mcp.google-merchant-mcp.workers.dev/callback`
- `https://google-merchant-asom-fashion-mcp.google-merchant-mcp.workers.dev/callback`

### Adding another store

1. Create a KV namespace for its OAuth state.
2. Add an `env.<store>` block in `wrangler.jsonc` with its own `name`, `kv_namespaces`, `vars`, and the `durable_objects` binding.
3. Create the Worker in Cloudflare, connect it to this repository on `main`, and set the deploy command to `npx wrangler deploy --env <store>`.
4. Set the four secrets on the new Worker and allow its callback URL in the Google OAuth client.
