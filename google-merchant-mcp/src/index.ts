import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { GoogleHandler } from "./google-handler";
import {
	deleteProduct,
	getPromotion,
	getReturnPolicy,
	getShippingSettings,
	getMerchantAccount,
	getProduct,
	listAccountIssues,
	listDataSources,
	listPromotions,
	listProducts,
	listReturnPolicies,
	merchantApiRead,
	merchantApiWrite,
	parseJsonObject,
	parseJsonObjectArray,
	patchProduct,
	replaceShippingSettings,
	runBoundedBatch,
	searchMerchantReport,
	upsertPromotion,
	upsertProduct,
} from "./merchant-api";

// Context from the auth process, encrypted & stored in the auth token
// and provided to the MyMCP as this.props
type Props = {
	name: string;
	email: string;
};

const PRODUCT_PATCH_FIELDS = [
	"title",
	"description",
	"link",
	"imageLink",
	"additionalImageLinks",
	"availability",
	"availabilityDate",
	"condition",
	"price",
	"salePrice",
	"salePriceEffectiveDate",
	"brand",
	"gtins",
	"mpn",
	"identifierExists",
	"googleProductCategory",
	"productTypes",
	"color",
	"sizes",
	"sizeSystem",
	"gender",
	"ageGroup",
	"material",
	"pattern",
	"itemGroupId",
	"shippingLabel",
	"customLabel0",
	"customLabel1",
	"customLabel2",
	"customLabel3",
	"customLabel4",
] as const;

const CAPABILITY_CATALOG = {
	account: ["account details", "business info and identity", "homepage", "users", "relationships", "services"],
	settings: ["automatic improvements", "autofeed", "programs", "checkout", "shipping", "returns", "regions"],
	catalog: ["products", "partial product updates", "bulk product writes", "data sources", "file upload status"],
	commerce: ["promotions", "local inventory", "regional inventory", "conversion sources"],
	diagnostics: ["account issues", "product issues", "aggregate product status", "issue resolution", "API quotas and limits"],
	reports: ["product performance", "disapproved products", "market insights", "price insights", "competitive visibility"],
	advanced: ["product and merchant reviews", "local feeds partnership", "loyalty customers", "order tracking", "Product Studio", "YouTube shopping"],
	privacy: "Customer, loyalty, and order data can contain personal information. Read it only when the user explicitly asks for it.",
	writes: "Every write route is exposed only through merchant_api_write or a dedicated write tool marked destructive, so ChatGPT must request approval.",
};

export class MyMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({
		name: "Google Merchant Manager",
		version: "1.0.0",
	});

	async init() {
		const textResult = (value: unknown) => ({
			content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
		});
		const readAnnotations = {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		};
		const writeAnnotations = {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		};

		this.server.registerTool(
			"get_merchant_account",
			{
				title: "Get Merchant account",
				description: "Get the configured Google Merchant Center account details.",
				inputSchema: {},
				annotations: readAnnotations,
			},
			async () => textResult(await getMerchantAccount(this.env)),
		);

		this.server.registerTool(
			"list_data_sources",
			{
				title: "List Merchant data sources",
				description: "List product data sources and identify which ones support API product writes.",
				inputSchema: {
					page_size: z.number().int().min(1).max(100).default(50),
					page_token: z.string().optional(),
				},
				annotations: readAnnotations,
			},
			async ({ page_size, page_token }) => textResult(await listDataSources(this.env, page_size, page_token)),
		);

		this.server.registerTool(
			"list_products",
			{
				title: "List Merchant products",
				description: "List processed products with key attributes, approval status, and product issues.",
				inputSchema: {
					page_size: z.number().int().min(1).max(100).default(25),
					page_token: z.string().optional(),
				},
				annotations: readAnnotations,
			},
			async ({ page_size, page_token }) => textResult(await listProducts(this.env, page_size, page_token)),
		);

		this.server.registerTool(
			"get_product",
			{
				title: "Get Merchant product",
				description: "Get one processed product using its language, feed label, and offer ID.",
				inputSchema: {
					content_language: z.string().min(2).max(10),
					feed_label: z.string().min(1).max(20),
					offer_id: z.string().min(1).max(50),
				},
				annotations: readAnnotations,
			},
			async ({ content_language, feed_label, offer_id }) =>
				textResult(await getProduct(this.env, content_language, feed_label, offer_id)),
		);

		this.server.registerTool(
			"list_account_issues",
			{
				title: "List Merchant account issues",
				description: "List account-level issues that can block or limit product visibility.",
				inputSchema: {
					page_size: z.number().int().min(1).max(100).default(50),
					language_code: z.string().default("en-US"),
					page_token: z.string().optional(),
				},
				annotations: readAnnotations,
			},
			async ({ page_size, language_code, page_token }) =>
				textResult(await listAccountIssues(this.env, page_size, language_code, page_token)),
		);

		this.server.registerTool(
			"search_merchant_report",
			{
				title: "Search Merchant report",
				description: "Run a Merchant Query Language report for product status or performance analysis.",
				inputSchema: {
					query: z.string().min(1).max(10_000),
					page_size: z.number().int().min(1).max(1000).default(100),
					page_token: z.string().optional(),
				},
				annotations: readAnnotations,
			},
			async ({ query, page_size, page_token }) =>
				textResult(await searchMerchantReport(this.env, query, page_size, page_token)),
		);

		this.server.registerTool(
			"upsert_product",
			{
				title: "Add or replace Merchant product",
				description:
					"Add a product to an API data source. If the same identifiers already exist, Google replaces that input.",
				inputSchema: {
					data_source: z.string().min(1),
					offer_id: z.string().min(1).max(50),
					content_language: z.string().min(2).max(10),
					feed_label: z.string().min(1).max(20),
					title: z.string().min(1).max(150),
					description: z.string().min(1).max(5000),
					link: z.string().url(),
					image_link: z.string().url(),
					availability: z.enum(["IN_STOCK", "OUT_OF_STOCK", "PREORDER", "BACKORDER"]),
					condition: z.enum(["NEW", "USED", "REFURBISHED"]).default("NEW"),
					price: z.number().positive().max(10_000_000),
					currency_code: z.string().length(3),
					brand: z.string().max(70).optional(),
					gtins: z.array(z.string()).max(10).optional(),
					mpn: z.string().max(70).optional(),
					google_product_category: z.string().max(750).optional(),
				},
				annotations: writeAnnotations,
			},
			async (input) =>
				textResult(
					await upsertProduct(this.env, {
						dataSource: input.data_source,
						offerId: input.offer_id,
						contentLanguage: input.content_language,
						feedLabel: input.feed_label,
						title: input.title,
						description: input.description,
						link: input.link,
						imageLink: input.image_link,
						availability: input.availability,
						condition: input.condition,
						price: input.price,
						currencyCode: input.currency_code,
						brand: input.brand,
						gtins: input.gtins,
						mpn: input.mpn,
						googleProductCategory: input.google_product_category,
					}),
				),
		);

		this.server.registerTool(
			"delete_product",
			{
				title: "Delete Merchant product input",
				description:
					"Delete a product input from a data source. Deleting it from the primary source removes the processed product.",
				inputSchema: {
					data_source: z.string().min(1),
					content_language: z.string().min(2).max(10),
					feed_label: z.string().min(1).max(20),
					offer_id: z.string().min(1).max(50),
				},
				annotations: writeAnnotations,
			},
			async ({ data_source, content_language, feed_label, offer_id }) =>
				textResult(await deleteProduct(this.env, data_source, content_language, feed_label, offer_id)),
		);

		this.server.registerTool(
			"list_merchant_capabilities",
			{
				title: "List all Merchant MCP capabilities",
				description:
					"Show the complete management coverage, including advanced Merchant API areas and the approval rule for writes.",
				inputSchema: {},
				annotations: readAnnotations,
			},
			async () => textResult(CAPABILITY_CATALOG),
		);

		this.server.registerTool(
			"merchant_api_read",
			{
				title: "Read any scoped Merchant API resource",
				description:
					"Universal read-only access to every current or future Google Merchant API endpoint for the configured account. Use GET normally, or POST only for reports and issue rendering.",
				inputSchema: {
					method: z.enum(["GET", "POST"]).default("GET"),
					path: z.string().min(1).max(2000).describe("Merchant API path only, without the hostname or query string."),
					query_json: z.string().min(2).max(30_000).default("{}"),
					body_json: z.string().min(2).max(100_000).default("{}"),
				},
				annotations: readAnnotations,
			},
			async ({ method, path, query_json, body_json }) =>
				textResult(
					await merchantApiRead(
						this.env,
						method,
						path,
						parseJsonObject(query_json, "query_json"),
						parseJsonObject(body_json, "body_json"),
					),
				),
		);

		this.server.registerTool(
			"merchant_api_write",
			{
				title: "Write any scoped Merchant API resource",
				description:
					"Universal create, update, action, archive, or delete access for the configured Merchant account. Always requires the user's approval before execution.",
				inputSchema: {
					method: z.enum(["POST", "PATCH", "DELETE"]),
					path: z.string().min(1).max(2000).describe("Merchant API path only, without the hostname or query string."),
					query_json: z.string().min(2).max(30_000).default("{}"),
					body_json: z.string().min(2).max(100_000).default("{}"),
					change_summary: z.string().min(5).max(500).describe("Plain-language summary shown with the approval request."),
				},
				annotations: writeAnnotations,
			},
			async ({ method, path, query_json, body_json }) =>
				textResult(
					await merchantApiWrite(
						this.env,
						method,
						path,
						parseJsonObject(query_json, "query_json"),
						parseJsonObject(body_json, "body_json"),
					),
				),
		);

		this.server.registerTool(
			"batch_merchant_writes",
			{
				title: "Run an approved batch of Merchant writes",
				description:
					"Run up to 20 scoped Merchant API writes with bounded concurrency. The full batch requires user approval before execution and returns one result per item.",
				inputSchema: {
					items_json: z.string().min(2).max(200_000).describe(
						'JSON array. Each item: {"method":"POST|PATCH|DELETE","path":"/...","query":{},"body":{}}.',
					),
					change_summary: z.string().min(5).max(1000),
				},
				annotations: writeAnnotations,
			},
			async ({ items_json }) => {
				const items = parseJsonObjectArray(items_json);
				if (!items.length || items.length > 20) throw new Error("The batch must contain between 1 and 20 writes.");
				return textResult(
					await runBoundedBatch(items, async (item) => {
						const method = item.method;
						const path = item.path;
						const query = item.query;
						const body = item.body;
						if (method !== "POST" && method !== "PATCH" && method !== "DELETE") {
							throw new Error("Each batch item needs a valid write method.");
						}
						if (typeof path !== "string") throw new Error("Each batch item needs a path.");
						if (typeof query !== "object" || query === null || Array.isArray(query)) {
							throw new Error("Each batch query must be a JSON object.");
						}
						if (typeof body !== "object" || body === null || Array.isArray(body)) {
							throw new Error("Each batch body must be a JSON object.");
						}
						return merchantApiWrite(this.env, method, path, query, body);
					}),
				);
			},
		);

		this.server.registerTool(
			"patch_product",
			{
				title: "Partially update a Merchant product",
				description:
					"Safely update only selected product fields such as price, availability, title, images, size, color, labels, and sale price. Requires approval.",
				inputSchema: {
					data_source: z.string().min(1),
					content_language: z.string().min(2).max(10),
					feed_label: z.string().min(1).max(20),
					offer_id: z.string().min(1).max(50),
					update_fields: z.array(z.enum(PRODUCT_PATCH_FIELDS)).min(1).max(PRODUCT_PATCH_FIELDS.length),
					attributes_json: z.string().min(2).max(100_000),
				},
				annotations: writeAnnotations,
			},
			async ({ data_source, content_language, feed_label, offer_id, update_fields, attributes_json }) =>
				textResult(
					await patchProduct(this.env, {
						dataSource: data_source,
						contentLanguage: content_language,
						feedLabel: feed_label,
						offerId: offer_id,
						updateFields: [...new Set(update_fields)],
						attributes: parseJsonObject(attributes_json, "attributes_json"),
					}),
				),
		);

		this.server.registerTool(
			"get_shipping_settings",
			{
				title: "Get Merchant shipping settings",
				description: "Read every shipping service, country, rate group, delivery time, and warehouse, including the etag needed for safe changes.",
				inputSchema: {},
				annotations: readAnnotations,
			},
			async () => textResult(await getShippingSettings(this.env)),
		);

		this.server.registerTool(
			"replace_shipping_settings",
			{
				title: "Replace Merchant shipping settings",
				description:
					"Replace the full shipping configuration after checking the latest etag. This can remove omitted services, countries, or warehouses and always requires approval.",
				inputSchema: {
					expected_etag: z.string().min(1).max(500),
					settings_json: z.string().min(2).max(200_000),
					change_summary: z.string().min(5).max(1000),
				},
				annotations: writeAnnotations,
			},
			async ({ expected_etag, settings_json }) =>
				textResult(
					await replaceShippingSettings(
						this.env,
						expected_etag,
						parseJsonObject(settings_json, "settings_json"),
					),
				),
		);

		this.server.registerTool(
			"list_return_policies",
			{
				title: "List Merchant return policies",
				description: "Read all online return policies and their country coverage.",
				inputSchema: {
					page_size: z.number().int().min(1).max(100).default(50),
					page_token: z.string().optional(),
				},
				annotations: readAnnotations,
			},
			async ({ page_size, page_token }) => textResult(await listReturnPolicies(this.env, page_size, page_token)),
		);

		this.server.registerTool(
			"get_return_policy",
			{
				title: "Get Merchant return policy",
				description: "Read one online return policy in full.",
				inputSchema: { policy_id: z.string().min(1).max(200) },
				annotations: readAnnotations,
			},
			async ({ policy_id }) => textResult(await getReturnPolicy(this.env, policy_id)),
		);

		this.server.registerTool(
			"list_promotions",
			{
				title: "List Merchant promotions",
				description: "Read promotions, approval statuses, destinations, and issues.",
				inputSchema: {
					page_size: z.number().int().min(1).max(100).default(50),
					page_token: z.string().optional(),
				},
				annotations: readAnnotations,
			},
			async ({ page_size, page_token }) => textResult(await listPromotions(this.env, page_size, page_token)),
		);

		this.server.registerTool(
			"get_promotion",
			{
				title: "Get Merchant promotion",
				description: "Read one promotion and its validation status.",
				inputSchema: { promotion_id: z.string().min(1).max(200) },
				annotations: readAnnotations,
			},
			async ({ promotion_id }) => textResult(await getPromotion(this.env, promotion_id)),
		);

		this.server.registerTool(
			"upsert_promotion",
			{
				title: "Add or update Merchant promotion",
				description: "Insert or refresh a promotion in a promotions data source. Always requires approval.",
				inputSchema: {
					data_source: z.string().min(1),
					promotion_json: z.string().min(2).max(100_000),
					change_summary: z.string().min(5).max(500),
				},
				annotations: writeAnnotations,
			},
			async ({ data_source, promotion_json }) =>
				textResult(await upsertPromotion(this.env, data_source, parseJsonObject(promotion_json, "promotion_json"))),
		);
	}
}

export default new OAuthProvider({
	apiHandler: MyMCP.serve("/mcp"),
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GoogleHandler as any,
	tokenEndpoint: "/token",
});
