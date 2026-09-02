import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { GoogleHandler } from "./google-handler";
import {
	deleteLocalInventory,
	deleteProduct,
	deleteRegion,
	deleteRegionalInventory,
	getApiQuota,
	getAutofeedSettings,
	getAutomaticImprovements,
	getBusinessIdentity,
	getBusinessInfo,
	getHomepage,
	getPriceCompetitiveness,
	getPriceInsights,
	getProductPerformance,
	getPromotion,
	getRegion,
	getReturnPolicy,
	getShippingSettings,
	getMerchantAccount,
	getProduct,
	listAccountIssues,
	listAccountRelationships,
	listAccountServices,
	listAggregateProductStatuses,
	listConversionSources,
	listDataSources,
	listLocalInventory,
	listMerchantReviews,
	listPrograms,
	listProductIssues,
	listProductReviews,
	listPromotions,
	listProducts,
	listRegionalInventory,
	listRegions,
	listReturnPolicies,
	listUsers,
	merchantApiRead,
	merchantApiWrite,
	parseJsonObject,
	parseJsonObjectArray,
	patchProduct,
	PERFORMANCE_GROUPING_NAMES,
	PERFORMANCE_METRICS,
	PRODUCT_STATUS_FILTERS,
	renderAccountIssues,
	renderProductIssues,
	replaceShippingSettings,
	runBoundedBatch,
	searchMerchantReport,
	setLocalInventory,
	setRegionalInventory,
	upsertPromotion,
	upsertProduct,
	upsertRegion,
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
	writes: "Every write route is exposed only through merchant_api_write or a dedicated write tool marked destructive, so the MCP client must request approval.",
};

const PRODUCT_KEY_SCHEMA = {
	content_language: z.string().min(2).max(10),
	feed_label: z.string().min(1).max(20),
	offer_id: z.string().min(1).max(50),
};

const PAGING_SCHEMA = {
	page_size: z.number().int().min(1).max(100).default(50),
	page_token: z.string().optional(),
};

const LANGUAGE_CODE = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "Use a BCP-47 language tag such as en-US.");
const TIME_ZONE = z.string().min(1).max(64).optional();
const REGION_ID = z.string().min(1).max(64);
const CURRENCY_CODE = z.string().length(3);
const NON_NEGATIVE_MONEY = z.number().min(0).max(10_000_000);

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

		// --- Account, identity, and settings -------------------------------------------------

		this.server.registerTool(
			"get_business_info",
			{
				title: "Get Merchant business info",
				description: "Read the business address, phone number, customer service contact, and Korean business registration number.",
				inputSchema: {},
				annotations: readAnnotations,
			},
			async () => textResult(await getBusinessInfo(this.env)),
		);

		this.server.registerTool(
			"get_business_identity",
			{
				title: "Get Merchant business identity",
				description: "Read the self-declared business identity attributes (for example women-owned, veteran-owned) and promotion consent.",
				inputSchema: {},
				annotations: readAnnotations,
			},
			async () => textResult(await getBusinessIdentity(this.env)),
		);

		this.server.registerTool(
			"get_homepage",
			{
				title: "Get Merchant homepage",
				description: "Read the store homepage URL and whether it is claimed and verified.",
				inputSchema: {},
				annotations: readAnnotations,
			},
			async () => textResult(await getHomepage(this.env)),
		);

		this.server.registerTool(
			"list_users",
			{
				title: "List Merchant account users",
				description: "List the users with access to the Merchant Center account and their access rights.",
				inputSchema: PAGING_SCHEMA,
				annotations: readAnnotations,
			},
			async ({ page_size, page_token }) => textResult(await listUsers(this.env, page_size, page_token)),
		);

		this.server.registerTool(
			"list_account_relationships",
			{
				title: "List Merchant account relationships",
				description: "List linked third-party providers and the services they provide to this account.",
				inputSchema: PAGING_SCHEMA,
				annotations: readAnnotations,
			},
			async ({ page_size, page_token }) => textResult(await listAccountRelationships(this.env, page_size, page_token)),
		);

		this.server.registerTool(
			"list_account_services",
			{
				title: "List Merchant account services",
				description: "List account services such as aggregation, management, or campaign links, including proposals awaiting approval.",
				inputSchema: PAGING_SCHEMA,
				annotations: readAnnotations,
			},
			async ({ page_size, page_token }) => textResult(await listAccountServices(this.env, page_size, page_token)),
		);

		this.server.registerTool(
			"get_automatic_improvements",
			{
				title: "Get Merchant automatic improvements",
				description: "Read whether automatic item updates, image improvements, and shipping improvements are enabled.",
				inputSchema: {},
				annotations: readAnnotations,
			},
			async () => textResult(await getAutomaticImprovements(this.env)),
		);

		this.server.registerTool(
			"get_autofeed_settings",
			{
				title: "Get Merchant autofeed settings",
				description: "Read whether automatic product crawling (autofeed) is enabled and eligible for this account.",
				inputSchema: {},
				annotations: readAnnotations,
			},
			async () => textResult(await getAutofeedSettings(this.env)),
		);

		this.server.registerTool(
			"list_programs",
			{
				title: "List Merchant programs",
				description: "List program participation (Free Listings, Shopping Ads, and others) with state and unmet requirements.",
				inputSchema: PAGING_SCHEMA,
				annotations: readAnnotations,
			},
			async ({ page_size, page_token }) => textResult(await listPrograms(this.env, page_size, page_token)),
		);

		// --- Regions -------------------------------------------------------------------------

		this.server.registerTool(
			"list_regions",
			{
				title: "List Merchant regions",
				description: "List regions defined for regional pricing, availability, and shipping.",
				inputSchema: PAGING_SCHEMA,
				annotations: readAnnotations,
			},
			async ({ page_size, page_token }) => textResult(await listRegions(this.env, page_size, page_token)),
		);

		this.server.registerTool(
			"get_region",
			{
				title: "Get Merchant region",
				description: "Read one region definition, including its postal code or geotarget area and eligibility flags.",
				inputSchema: { region_id: REGION_ID },
				annotations: readAnnotations,
			},
			async ({ region_id }) => textResult(await getRegion(this.env, region_id)),
		);

		this.server.registerTool(
			"upsert_region",
			{
				title: "Create or update Merchant region",
				description:
					"Create a region, or update it if the region_id already exists. Define the area with either postal_codes (plus region_code) or geotarget_criteria_ids. Requires approval.",
				inputSchema: {
					region_id: REGION_ID,
					display_name: z.string().min(1).max(60).optional(),
					region_code: z.string().length(2).optional().describe("CLDR country code for the postal codes, such as SA or US."),
					postal_codes: z
						.array(z.string().min(1).max(40))
						.max(500)
						.optional()
						.describe('Postal codes, prefixes like "9410*", or ranges written as "94100-94199".'),
					geotarget_criteria_ids: z.array(z.string().regex(/^\d+$/)).max(500).optional(),
					change_summary: z.string().min(5).max(500),
				},
				annotations: writeAnnotations,
			},
			async ({ region_id, display_name, region_code, postal_codes, geotarget_criteria_ids }) =>
				textResult(
					await upsertRegion(this.env, {
						regionId: region_id,
						displayName: display_name,
						regionCode: region_code,
						postalCodes: postal_codes,
						geotargetCriteriaIds: geotarget_criteria_ids,
					}),
				),
		);

		this.server.registerTool(
			"delete_region",
			{
				title: "Delete Merchant region",
				description: "Delete a region definition. Fails if the region is still referenced by shipping settings or regional inventory. Requires approval.",
				inputSchema: { region_id: REGION_ID, change_summary: z.string().min(5).max(500) },
				annotations: writeAnnotations,
			},
			async ({ region_id }) => textResult(await deleteRegion(this.env, region_id)),
		);

		// --- Local and regional inventory ---------------------------------------------------

		this.server.registerTool(
			"list_local_inventory",
			{
				title: "List product local inventory",
				description: "List per-store local inventory entries (price, availability, quantity, pickup) for one product.",
				inputSchema: { ...PRODUCT_KEY_SCHEMA, ...PAGING_SCHEMA },
				annotations: readAnnotations,
			},
			async ({ content_language, feed_label, offer_id, page_size, page_token }) =>
				textResult(
					await listLocalInventory(
						this.env,
						{ contentLanguage: content_language, feedLabel: feed_label, offerId: offer_id },
						page_size,
						page_token,
					),
				),
		);

		this.server.registerTool(
			"set_local_inventory",
			{
				title: "Set product local inventory",
				description:
					"Insert or replace the local inventory entry for one product at one store. Only the attributes you pass are stored. Requires approval.",
				inputSchema: {
					...PRODUCT_KEY_SCHEMA,
					store_code: z.string().min(1).max(64),
					availability: z.enum(["IN_STOCK", "LIMITED_AVAILABILITY", "ON_DISPLAY_TO_ORDER", "OUT_OF_STOCK"]).optional(),
					price: NON_NEGATIVE_MONEY.optional(),
					sale_price: NON_NEGATIVE_MONEY.optional(),
					currency_code: CURRENCY_CODE.optional(),
					quantity: z.number().int().min(0).optional(),
					pickup_method: z.enum(["BUY", "RESERVE", "SHIP_TO_STORE", "NOT_SUPPORTED"]).optional(),
					pickup_sla: z
						.enum(["SAME_DAY", "NEXT_DAY", "TWO_DAY", "THREE_DAY", "FOUR_DAY", "FIVE_DAY", "SIX_DAY", "SEVEN_DAY", "MULTI_WEEK"])
						.optional(),
					instore_product_location: z.string().min(1).max(20).optional(),
					change_summary: z.string().min(5).max(500),
				},
				annotations: writeAnnotations,
			},
			async (input) =>
				textResult(
					await setLocalInventory(this.env, {
						contentLanguage: input.content_language,
						feedLabel: input.feed_label,
						offerId: input.offer_id,
						storeCode: input.store_code,
						availability: input.availability,
						price: input.price,
						salePrice: input.sale_price,
						currencyCode: input.currency_code,
						quantity: input.quantity,
						pickupMethod: input.pickup_method,
						pickupSla: input.pickup_sla,
						instoreProductLocation: input.instore_product_location,
					}),
				),
		);

		this.server.registerTool(
			"delete_local_inventory",
			{
				title: "Delete product local inventory",
				description: "Remove the local inventory entry for one product at one store. Requires approval.",
				inputSchema: { ...PRODUCT_KEY_SCHEMA, store_code: z.string().min(1).max(64), change_summary: z.string().min(5).max(500) },
				annotations: writeAnnotations,
			},
			async ({ content_language, feed_label, offer_id, store_code }) =>
				textResult(
					await deleteLocalInventory(
						this.env,
						{ contentLanguage: content_language, feedLabel: feed_label, offerId: offer_id },
						store_code,
					),
				),
		);

		this.server.registerTool(
			"list_regional_inventory",
			{
				title: "List product regional inventory",
				description: "List per-region price and availability overrides for one product.",
				inputSchema: { ...PRODUCT_KEY_SCHEMA, ...PAGING_SCHEMA },
				annotations: readAnnotations,
			},
			async ({ content_language, feed_label, offer_id, page_size, page_token }) =>
				textResult(
					await listRegionalInventory(
						this.env,
						{ contentLanguage: content_language, feedLabel: feed_label, offerId: offer_id },
						page_size,
						page_token,
					),
				),
		);

		this.server.registerTool(
			"set_regional_inventory",
			{
				title: "Set product regional inventory",
				description:
					"Insert or replace the regional price and availability for one product in one region. The region must already exist. Requires approval.",
				inputSchema: {
					...PRODUCT_KEY_SCHEMA,
					region: REGION_ID,
					availability: z.enum(["IN_STOCK", "OUT_OF_STOCK"]).optional(),
					price: NON_NEGATIVE_MONEY.optional(),
					sale_price: NON_NEGATIVE_MONEY.optional(),
					currency_code: CURRENCY_CODE.optional(),
					change_summary: z.string().min(5).max(500),
				},
				annotations: writeAnnotations,
			},
			async (input) =>
				textResult(
					await setRegionalInventory(this.env, {
						contentLanguage: input.content_language,
						feedLabel: input.feed_label,
						offerId: input.offer_id,
						region: input.region,
						availability: input.availability,
						price: input.price,
						salePrice: input.sale_price,
						currencyCode: input.currency_code,
					}),
				),
		);

		this.server.registerTool(
			"delete_regional_inventory",
			{
				title: "Delete product regional inventory",
				description: "Remove the regional inventory override for one product in one region. Requires approval.",
				inputSchema: { ...PRODUCT_KEY_SCHEMA, region: REGION_ID, change_summary: z.string().min(5).max(500) },
				annotations: writeAnnotations,
			},
			async ({ content_language, feed_label, offer_id, region }) =>
				textResult(
					await deleteRegionalInventory(
						this.env,
						{ contentLanguage: content_language, feedLabel: feed_label, offerId: offer_id },
						region,
					),
				),
		);

		// --- Diagnostics ---------------------------------------------------------------------

		this.server.registerTool(
			"list_product_issues",
			{
				title: "List product issues by status",
				description:
					"List products with their aggregated approval status and item-level issues, optionally filtered to disapproved, limited, eligible, or pending products.",
				inputSchema: {
					status: z.enum(PRODUCT_STATUS_FILTERS).default("NOT_ELIGIBLE_OR_DISAPPROVED"),
					page_size: z.number().int().min(1).max(1000).default(100),
					page_token: z.string().optional(),
				},
				annotations: readAnnotations,
			},
			async ({ status, page_size, page_token }) =>
				textResult(await listProductIssues(this.env, status, page_size, page_token)),
		);

		this.server.registerTool(
			"get_aggregate_product_status",
			{
				title: "Get aggregate product status",
				description:
					"Read per-destination, per-country counts of active, pending, disapproved, and expiring products plus the most common item issues.",
				inputSchema: {
					...PAGING_SCHEMA,
					reporting_context: z
						.string()
						.regex(/^[A-Z_]{1,64}$/)
						.optional()
						.describe("Filter by destination, such as SHOPPING_ADS or FREE_LISTINGS."),
					country: z.string().length(2).optional(),
				},
				annotations: readAnnotations,
			},
			async ({ page_size, page_token, reporting_context, country }) =>
				textResult(await listAggregateProductStatuses(this.env, page_size, page_token, reporting_context, country)),
		);

		this.server.registerTool(
			"render_account_issues",
			{
				title: "Render account issues with resolution guidance",
				description:
					"Return account-level issues with human-readable explanations, impact, and Merchant Center links to resolve them.",
				inputSchema: { language_code: LANGUAGE_CODE.default("en-US"), time_zone: TIME_ZONE },
				annotations: readAnnotations,
			},
			async ({ language_code, time_zone }) => textResult(await renderAccountIssues(this.env, language_code, time_zone)),
		);

		this.server.registerTool(
			"render_product_issues",
			{
				title: "Render product issues with resolution guidance",
				description: "Return one product's issues with human-readable explanations, impact, and links to resolve them.",
				inputSchema: { ...PRODUCT_KEY_SCHEMA, language_code: LANGUAGE_CODE.default("en-US"), time_zone: TIME_ZONE },
				annotations: readAnnotations,
			},
			async ({ content_language, feed_label, offer_id, language_code, time_zone }) =>
				textResult(
					await renderProductIssues(
						this.env,
						{ contentLanguage: content_language, feedLabel: feed_label, offerId: offer_id },
						language_code,
						time_zone,
					),
				),
		);

		this.server.registerTool(
			"get_api_quota",
			{
				title: "Get Merchant API quota usage",
				description: "Read the daily Merchant API call quota and current usage per method group.",
				inputSchema: PAGING_SCHEMA,
				annotations: readAnnotations,
			},
			async ({ page_size, page_token }) => textResult(await getApiQuota(this.env, page_size, page_token)),
		);

		// --- Conversions and reviews ---------------------------------------------------------

		this.server.registerTool(
			"list_conversion_sources",
			{
				title: "List Merchant conversion sources",
				description: "List conversion sources (Google Analytics links, Merchant Center destinations) and their state.",
				inputSchema: { ...PAGING_SCHEMA, show_deleted: z.boolean().default(false) },
				annotations: readAnnotations,
			},
			async ({ page_size, page_token, show_deleted }) =>
				textResult(await listConversionSources(this.env, page_size, page_token, show_deleted)),
		);

		this.server.registerTool(
			"list_product_reviews",
			{
				title: "List product reviews",
				description: "List product reviews uploaded to the account and their status.",
				inputSchema: PAGING_SCHEMA,
				annotations: readAnnotations,
			},
			async ({ page_size, page_token }) => textResult(await listProductReviews(this.env, page_size, page_token)),
		);

		this.server.registerTool(
			"list_merchant_reviews",
			{
				title: "List merchant reviews",
				description: "List seller (merchant) reviews uploaded to the account and their status.",
				inputSchema: PAGING_SCHEMA,
				annotations: readAnnotations,
			},
			async ({ page_size, page_token }) => textResult(await listMerchantReviews(this.env, page_size, page_token)),
		);

		// --- Shaped reports ------------------------------------------------------------------

		this.server.registerTool(
			"get_product_performance",
			{
				title: "Get product performance report",
				description:
					"Clicks, impressions, click-through rate, and conversions for a date range, grouped by offer, brand, category, product type, date, week, country, marketing method, or as a total.",
				inputSchema: {
					start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD."),
					end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD."),
					group_by: z.enum(PERFORMANCE_GROUPING_NAMES).default("offer"),
					order_by: z.enum(PERFORMANCE_METRICS).default("clicks"),
					marketing_method: z.enum(["ADS", "ORGANIC"]).optional(),
					limit: z.number().int().min(1).max(1000).default(100),
					page_token: z.string().optional(),
				},
				annotations: readAnnotations,
			},
			async ({ start_date, end_date, group_by, order_by, marketing_method, limit, page_token }) =>
				textResult(
					await getProductPerformance(this.env, {
						startDate: start_date,
						endDate: end_date,
						groupBy: group_by,
						orderBy: order_by,
						marketingMethod: marketing_method,
						limit,
						pageToken: page_token,
					}),
				),
		);

		this.server.registerTool(
			"get_price_insights",
			{
				title: "Get price insights",
				description:
					"Google's suggested prices per product with predicted impression, click, and conversion changes if the suggestion is applied.",
				inputSchema: { page_size: z.number().int().min(1).max(1000).default(100), page_token: z.string().optional() },
				annotations: readAnnotations,
			},
			async ({ page_size, page_token }) => textResult(await getPriceInsights(this.env, page_size, page_token)),
		);

		this.server.registerTool(
			"get_price_competitiveness",
			{
				title: "Get price competitiveness",
				description: "Compare each product's price with the benchmark price of the same product across other merchants, per country.",
				inputSchema: { page_size: z.number().int().min(1).max(1000).default(100), page_token: z.string().optional() },
				annotations: readAnnotations,
			},
			async ({ page_size, page_token }) => textResult(await getPriceCompetitiveness(this.env, page_size, page_token)),
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
