import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseJsonObject, parseJsonObjectArray } from "./merchant-api";
import {
	ACCESS_RIGHTS,
	acceptTermsOfService,
	BEST_SELLERS_VIEWS,
	claimHomepage,
	COMPETITIVE_VISIBILITY_VIEWS,
	createCheckoutSettings,
	createConversionSource,
	createDataSource,
	createNotificationSubscription,
	createOmnichannelSetting,
	createOrderTrackingSignal,
	createReturnPolicy,
	createUser,
	deleteCheckoutSettings,
	deleteConversionSource,
	deleteDataSource,
	deleteLfpStore,
	deleteMerchantReview,
	deleteNotificationSubscription,
	deleteProductReview,
	deleteReturnPolicy,
	deleteUser,
	disableProgram,
	enableProgram,
	fetchDataSource,
	generateProductImageBackground,
	generateProductTextSuggestions,
	getBestSellers,
	getCheckoutSettings,
	getCompetitiveVisibility,
	getConversionSource,
	getDataSource,
	getEmailPreferences,
	getLatestFileUpload,
	getLfpMerchantState,
	getLfpStore,
	getMerchantReview,
	getNonProductPerformance,
	getNotificationSubscription,
	getOmnichannelSetting,
	getProductReview,
	getProgram,
	getTermsOfServiceAgreementState,
	getUcpSettings,
	getUser,
	insertLfpInventory,
	insertLfpSale,
	insertLfpStore,
	insertMerchantReview,
	insertProductReview,
	linkGbpAccount,
	listGbpAccounts,
	listLfpStores,
	listNotificationSubscriptions,
	listOmnichannelSettings,
	listSubaccounts,
	NON_PRODUCT_GROUPINGS,
	removeProductImageBackground,
	REPORT_GRANULARITIES,
	requestInventoryVerification,
	retrieveLatestTermsOfService,
	TRAFFIC_SOURCES,
	triggerIssueAction,
	unclaimHomepage,
	undeleteConversionSource,
	updateAutofeedSettings,
	updateAutomaticImprovements,
	updateBusinessIdentity,
	updateBusinessInfo,
	updateCheckoutSettings,
	updateConversionSource,
	updateDataSource,
	updateEmailPreferences,
	updateHomepage,
	updateNotificationSubscription,
	updateOmnichannelSetting,
	updateReturnPolicy,
	updateUcpSettings,
	updateUser,
	upscaleProductImage,
} from "./merchant-api-extended";

const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const writeAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
// Generation and fetch triggers spend quota but change no Merchant data.
const actionAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

const PAGING_SCHEMA = {
	page_size: z.number().int().min(1).max(100).default(50),
	page_token: z.string().optional(),
};
const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");
const COUNTRY_CODE = z.string().regex(/^[A-Z]{2}$/, "Use a two-letter upper-case country code such as SA.");
const RESOURCE_ID = z.string().min(1).max(200);
const UPDATE_MASK = z
	.array(z.string().min(1).max(100))
	.min(1)
	.max(50)
	.describe("Field paths to update, in camelCase, matching the keys in the JSON body.");
const CHANGE_SUMMARY = z.string().min(5).max(500).describe("Plain-language summary shown with the approval request.");
const JSON_BODY = z.string().min(2).max(100_000);
const PROGRAM = z
	.string()
	.regex(/^[a-z0-9-]{1,64}$/)
	.describe("Program ID such as free-listings, shopping-ads, or youtube-shopping-checkout.");
const USER_EMAIL = z.string().min(2).max(320).describe('Email address of the user, or "me" for the caller.');
const LANGUAGE_CODE = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "Use a BCP-47 language tag such as en-US.");
const IMAGE_SOURCE = {
	image_uri: z.string().url().optional().describe("Public HTTPS URL of the source image."),
	image_base64: z.string().min(1).max(10_000_000).optional().describe("Base64-encoded image bytes, if no URL."),
};

export function registerExtendedTools(server: McpServer, env: Env): void {
	const textResult = (value: unknown) => ({
		content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
	});

	// --- Product Studio -----------------------------------------------------------------

	server.registerTool(
		"generate_product_text_suggestions",
		{
			title: "Generate product title and description suggestions",
			description:
				"Use Google Product Studio to suggest an improved title, description, or both (workflow tide) from existing attributes and an optional image. Fixes short or weak descriptions.",
			inputSchema: {
				workflow: z.enum(["title", "description", "tide"]).default("tide"),
				title: z.string().max(150).optional(),
				description: z.string().max(5000).optional(),
				brand: z.string().max(70).optional(),
				product_type: z.string().max(750).optional(),
				extra_attributes_json: z.string().min(2).max(10_000).default("{}").describe("Extra string attributes such as color, material, size."),
				image_uri: z.string().url().optional(),
				target_language: LANGUAGE_CODE.optional(),
				tone: z.enum(["default", "playful", "formal", "persuasive", "conversational"]).optional(),
				editorial_changes: z.string().max(1000).optional().describe("Free-text instructions, for example: mention the fabric."),
				attribute_separator: z.string().max(5).optional(),
				title_examples_json: z.string().min(2).max(20_000).default("[]").describe("Optional JSON array of title examples."),
			},
			annotations: actionAnnotations,
		},
		async (input) => {
			const extraAttributes = parseJsonObject(input.extra_attributes_json, "extra_attributes_json");
			const titleExamples = input.title_examples_json === "[]" ? [] : parseJsonObjectArray(input.title_examples_json, "title_examples_json");
			return textResult(
				await generateProductTextSuggestions(env, {
					workflow: input.workflow,
					title: input.title,
					description: input.description,
					brand: input.brand,
					productType: input.product_type,
					extraAttributes,
					imageUri: input.image_uri,
					targetLanguage: input.target_language,
					tone: input.tone,
					editorialChanges: input.editorial_changes,
					attributeSeparator: input.attribute_separator,
					titleExamples,
				}),
			);
		},
	);

	server.registerTool(
		"upscale_product_image",
		{
			title: "Upscale a product image",
			description:
				"Use Product Studio to upscale a product image so it meets the 500x500 minimum. Returns a hosted image URI you can set as the product image_link.",
			inputSchema: IMAGE_SOURCE,
			annotations: actionAnnotations,
		},
		async ({ image_uri, image_base64 }) => textResult(await upscaleProductImage(env, { uri: image_uri, base64: image_base64 })),
	);

	server.registerTool(
		"remove_product_image_background",
		{
			title: "Remove a product image background",
			description: "Use Product Studio to remove the background of a product image, optionally replacing it with a solid colour.",
			inputSchema: {
				...IMAGE_SOURCE,
				background_red: z.number().int().min(0).max(255).optional(),
				background_green: z.number().int().min(0).max(255).optional(),
				background_blue: z.number().int().min(0).max(255).optional(),
			},
			annotations: actionAnnotations,
		},
		async ({ image_uri, image_base64, background_red, background_green, background_blue }) => {
			const hasColor = [background_red, background_green, background_blue].some((value) => value !== undefined);
			const color = hasColor
				? { red: background_red ?? 255, green: background_green ?? 255, blue: background_blue ?? 255 }
				: undefined;
			return textResult(await removeProductImageBackground(env, { uri: image_uri, base64: image_base64 }, color));
		},
	);

	server.registerTool(
		"generate_product_image_background",
		{
			title: "Generate a product image background",
			description: "Use Product Studio to place the product on a newly generated background described in text.",
			inputSchema: {
				...IMAGE_SOURCE,
				product_description: z.string().min(1).max(500),
				background_description: z.string().min(1).max(500),
			},
			annotations: actionAnnotations,
		},
		async ({ image_uri, image_base64, product_description, background_description }) =>
			textResult(
				await generateProductImageBackground(
					env,
					{ uri: image_uri, base64: image_base64 },
					product_description,
					background_description,
				),
			),
	);

	// --- Issue resolution ------------------------------------------------------------------

	server.registerTool(
		"trigger_issue_action",
		{
			title: "Trigger an issue-resolution action",
			description:
				"Run a built-in action returned by render_account_issues or render_product_issues, such as requesting a re-review. Copy action_context and action_flow_id from the rendered action. Requires approval.",
			inputSchema: {
				action_context: z.string().min(1).max(10_000),
				action_flow_id: z.string().min(1).max(200),
				input_values_json: z
					.string()
					.min(2)
					.max(20_000)
					.default("[]")
					.describe('JSON array of {"inputFieldId":"...","textInputValue":{"value":"..."}} or choice/checkbox values.'),
				language_code: LANGUAGE_CODE.default("en-US"),
				change_summary: CHANGE_SUMMARY,
			},
			annotations: writeAnnotations,
		},
		async ({ action_context, action_flow_id, input_values_json, language_code }) => {
			const inputValues = input_values_json === "[]" ? [] : parseJsonObjectArray(input_values_json, "input_values_json");
			return textResult(await triggerIssueAction(env, action_context, action_flow_id, inputValues, language_code));
		},
	);

	// --- Data sources ---------------------------------------------------------------------

	server.registerTool(
		"get_data_source",
		{
			title: "Get Merchant data source",
			description: "Read one data source, including its type, feed label, language, and fetch schedule.",
			inputSchema: { data_source_id: RESOURCE_ID },
			annotations: readAnnotations,
		},
		async ({ data_source_id }) => textResult(await getDataSource(env, data_source_id)),
	);

	server.registerTool(
		"create_data_source",
		{
			title: "Create Merchant data source",
			description:
				"Create a primary, supplemental, promotion, or review data source. Pass the DataSource JSON body (displayName plus one *DataSource section, optional fileInput). Requires approval.",
			inputSchema: { data_source_json: JSON_BODY, change_summary: CHANGE_SUMMARY },
			annotations: writeAnnotations,
		},
		async ({ data_source_json }) => textResult(await createDataSource(env, parseJsonObject(data_source_json, "data_source_json"))),
	);

	server.registerTool(
		"update_data_source",
		{
			title: "Update Merchant data source",
			description: "Patch selected fields of a data source, for example the display name or fetch schedule. Requires approval.",
			inputSchema: { data_source_id: RESOURCE_ID, update_mask: UPDATE_MASK, data_source_json: JSON_BODY, change_summary: CHANGE_SUMMARY },
			annotations: writeAnnotations,
		},
		async ({ data_source_id, update_mask, data_source_json }) =>
			textResult(await updateDataSource(env, data_source_id, update_mask, parseJsonObject(data_source_json, "data_source_json"))),
	);

	server.registerTool(
		"delete_data_source",
		{
			title: "Delete Merchant data source",
			description: "Delete a data source and every product input it holds. Requires approval.",
			inputSchema: { data_source_id: RESOURCE_ID, change_summary: CHANGE_SUMMARY },
			annotations: writeAnnotations,
		},
		async ({ data_source_id }) => textResult(await deleteDataSource(env, data_source_id)),
	);

	server.registerTool(
		"fetch_data_source",
		{
			title: "Fetch Merchant data source now",
			description: "Ask Google to fetch a scheduled-fetch data source immediately instead of waiting for the next scheduled run.",
			inputSchema: { data_source_id: RESOURCE_ID },
			annotations: actionAnnotations,
		},
		async ({ data_source_id }) => textResult(await fetchDataSource(env, data_source_id)),
	);

	server.registerTool(
		"get_file_upload_status",
		{
			title: "Get latest data source file upload",
			description: "Read the latest file upload or fetch result for a data source: processing state, item counts, and issues.",
			inputSchema: { data_source_id: RESOURCE_ID },
			annotations: readAnnotations,
		},
		async ({ data_source_id }) => textResult(await getLatestFileUpload(env, data_source_id)),
	);

	// --- Notifications ---------------------------------------------------------------------

	server.registerTool(
		"list_notification_subscriptions",
		{
			title: "List notification subscriptions",
			description: "List webhook subscriptions that push product status or account service changes.",
			inputSchema: PAGING_SCHEMA,
			annotations: readAnnotations,
		},
		async ({ page_size, page_token }) => textResult(await listNotificationSubscriptions(env, page_size, page_token)),
	);

	server.registerTool(
		"get_notification_subscription",
		{
			title: "Get notification subscription",
			description: "Read one webhook subscription.",
			inputSchema: { subscription_id: RESOURCE_ID },
			annotations: readAnnotations,
		},
		async ({ subscription_id }) => textResult(await getNotificationSubscription(env, subscription_id)),
	);

	server.registerTool(
		"create_notification_subscription",
		{
			title: "Create notification subscription",
			description: "Register an HTTPS callback that receives a push whenever a product's status changes or an account service changes. Requires approval.",
			inputSchema: {
				registered_event: z.enum(["PRODUCT_STATUS_CHANGE", "ACCOUNT_SERVICE_CHANGE"]).default("PRODUCT_STATUS_CHANGE"),
				callback_uri: z.string().url().startsWith("https://"),
				all_managed_accounts: z.boolean().default(false),
				change_summary: CHANGE_SUMMARY,
			},
			annotations: writeAnnotations,
		},
		async ({ registered_event, callback_uri, all_managed_accounts }) =>
			textResult(await createNotificationSubscription(env, registered_event, callback_uri, all_managed_accounts)),
	);

	server.registerTool(
		"update_notification_subscription",
		{
			title: "Update notification subscription",
			description: "Change the callback URL of a webhook subscription. Requires approval.",
			inputSchema: { subscription_id: RESOURCE_ID, callback_uri: z.string().url().startsWith("https://"), change_summary: CHANGE_SUMMARY },
			annotations: writeAnnotations,
		},
		async ({ subscription_id, callback_uri }) => textResult(await updateNotificationSubscription(env, subscription_id, callback_uri)),
	);

	server.registerTool(
		"delete_notification_subscription",
		{
			title: "Delete notification subscription",
			description: "Stop receiving pushes for a webhook subscription. Requires approval.",
			inputSchema: { subscription_id: RESOURCE_ID, change_summary: CHANGE_SUMMARY },
			annotations: writeAnnotations,
		},
		async ({ subscription_id }) => textResult(await deleteNotificationSubscription(env, subscription_id)),
	);

	// --- Shaped reports ---------------------------------------------------------------------

	server.registerTool(
		"get_best_sellers",
		{
			title: "Get best sellers report",
			description:
				"Google's best-selling product clusters or brands for a country and category on a weekly or monthly report date, with rank and relative demand. Use a Monday for WEEKLY and the first of the month for MONTHLY.",
			inputSchema: {
				view: z.enum(BEST_SELLERS_VIEWS).default("product_cluster"),
				report_date: ISO_DATE,
				granularity: z.enum(REPORT_GRANULARITIES).default("WEEKLY"),
				country_code: COUNTRY_CODE,
				category_id: z.string().regex(/^\d+$/).optional().describe("Google product category ID to narrow the ranking."),
				limit: z.number().int().min(1).max(1000).default(100),
				page_token: z.string().optional(),
			},
			annotations: readAnnotations,
		},
		async ({ view, report_date, granularity, country_code, category_id, limit, page_token }) =>
			textResult(
				await getBestSellers(env, {
					view,
					reportDate: report_date,
					granularity,
					countryCode: country_code,
					categoryId: category_id,
					limit,
					pageToken: page_token,
				}),
			),
	);

	server.registerTool(
		"get_competitive_visibility",
		{
			title: "Get competitive visibility report",
			description:
				"Compare your visibility with competitors (competitor view), see the top merchants in your category (top_merchant view), or track your visibility trend against the category benchmark (benchmark view).",
			inputSchema: {
				view: z.enum(COMPETITIVE_VISIBILITY_VIEWS).default("competitor"),
				start_date: ISO_DATE,
				end_date: ISO_DATE,
				country_code: COUNTRY_CODE,
				traffic_source: z.enum(TRAFFIC_SOURCES).default("ALL"),
				category_id: z.string().regex(/^\d+$/).optional(),
				limit: z.number().int().min(1).max(1000).default(100),
				page_token: z.string().optional(),
			},
			annotations: readAnnotations,
		},
		async ({ view, start_date, end_date, country_code, traffic_source, category_id, limit, page_token }) =>
			textResult(
				await getCompetitiveVisibility(env, {
					view,
					startDate: start_date,
					endDate: end_date,
					countryCode: country_code,
					trafficSource: traffic_source,
					categoryId: category_id,
					limit,
					pageToken: page_token,
				}),
			),
	);

	server.registerTool(
		"get_non_product_performance",
		{
			title: "Get non-product performance report",
			description: "Clicks, impressions, and click-through rate for non-product surfaces such as the store page, by date, week, or in total.",
			inputSchema: {
				start_date: ISO_DATE,
				end_date: ISO_DATE,
				group_by: z.enum(NON_PRODUCT_GROUPINGS).default("date"),
				limit: z.number().int().min(1).max(1000).default(100),
				page_token: z.string().optional(),
			},
			annotations: readAnnotations,
		},
		async ({ start_date, end_date, group_by, limit, page_token }) =>
			textResult(
				await getNonProductPerformance(env, { startDate: start_date, endDate: end_date, groupBy: group_by, limit, pageToken: page_token }),
			),
	);

	// --- Order tracking and conversion sources ---------------------------------------------

	server.registerTool(
		"create_order_tracking_signal",
		{
			title: "Send order tracking signal",
			description:
				"Report an order's shipment and delivery times to Google so shipping-speed annotations improve. Pass the OrderTrackingSignal JSON (orderId, orderCreatedTime, shippingInfo[], lineItems[], shipmentLineItemMapping[]). Contains customer delivery data. Requires approval.",
			inputSchema: { signal_json: JSON_BODY, change_summary: CHANGE_SUMMARY },
			annotations: writeAnnotations,
		},
		async ({ signal_json }) => textResult(await createOrderTrackingSignal(env, parseJsonObject(signal_json, "signal_json"))),
	);

	server.registerTool(
		"get_conversion_source",
		{
			title: "Get conversion source",
			description: "Read one conversion source and its attribution settings.",
			inputSchema: { conversion_source_id: RESOURCE_ID },
			annotations: readAnnotations,
		},
		async ({ conversion_source_id }) => textResult(await getConversionSource(env, conversion_source_id)),
	);

	server.registerTool(
		"create_conversion_source",
		{
			title: "Create conversion source",
			description:
				"Create a Merchant Center destination or Google Analytics link conversion source. Pass the ConversionSource JSON body. Requires approval.",
			inputSchema: { conversion_source_json: JSON_BODY, change_summary: CHANGE_SUMMARY },
			annotations: writeAnnotations,
		},
		async ({ conversion_source_json }) =>
			textResult(await createConversionSource(env, parseJsonObject(conversion_source_json, "conversion_source_json"))),
	);

	server.registerTool(
		"update_conversion_source",
		{
			title: "Update conversion source",
			description: "Patch selected fields of a conversion source. Requires approval.",
			inputSchema: {
				conversion_source_id: RESOURCE_ID,
				update_mask: UPDATE_MASK,
				conversion_source_json: JSON_BODY,
				change_summary: CHANGE_SUMMARY,
			},
			annotations: writeAnnotations,
		},
		async ({ conversion_source_id, update_mask, conversion_source_json }) =>
			textResult(
				await updateConversionSource(
					env,
					conversion_source_id,
					update_mask,
					parseJsonObject(conversion_source_json, "conversion_source_json"),
				),
			),
	);

	server.registerTool(
		"delete_conversion_source",
		{
			title: "Delete conversion source",
			description: "Archive a conversion source. It can be restored with undelete_conversion_source for 30 days. Requires approval.",
			inputSchema: { conversion_source_id: RESOURCE_ID, change_summary: CHANGE_SUMMARY },
			annotations: writeAnnotations,
		},
		async ({ conversion_source_id }) => textResult(await deleteConversionSource(env, conversion_source_id)),
	);

	server.registerTool(
		"undelete_conversion_source",
		{
			title: "Restore conversion source",
			description: "Restore an archived conversion source. Requires approval.",
			inputSchema: { conversion_source_id: RESOURCE_ID, change_summary: CHANGE_SUMMARY },
			annotations: writeAnnotations,
		},
		async ({ conversion_source_id }) => textResult(await undeleteConversionSource(env, conversion_source_id)),
	);

	// --- Account settings writes -------------------------------------------------------------

	server.registerTool(
		"update_business_info",
		{
			title: "Update Merchant business info",
			description: "Patch the business address, phone, or customer service contact. Pass BusinessInfo JSON and the matching update_mask. Requires approval.",
			inputSchema: { update_mask: UPDATE_MASK, business_info_json: JSON_BODY, change_summary: CHANGE_SUMMARY },
			annotations: writeAnnotations,
		},
		async ({ update_mask, business_info_json }) =>
			textResult(await updateBusinessInfo(env, update_mask, parseJsonObject(business_info_json, "business_info_json"))),
	);

	server.registerTool(
		"update_business_identity",
		{
			title: "Update Merchant business identity",
			description: "Patch self-declared identity attributes and promotion consent. Pass BusinessIdentity JSON and update_mask. Requires approval.",
			inputSchema: { update_mask: UPDATE_MASK, business_identity_json: JSON_BODY, change_summary: CHANGE_SUMMARY },
			annotations: writeAnnotations,
		},
		async ({ update_mask, business_identity_json }) =>
			textResult(await updateBusinessIdentity(env, update_mask, parseJsonObject(business_identity_json, "business_identity_json"))),
	);

	server.registerTool(
		"update_homepage",
		{
			title: "Update Merchant homepage URL",
			description: "Set the store homepage URL. Claim it afterwards with claim_homepage. Requires approval.",
			inputSchema: { uri: z.string().url(), change_summary: CHANGE_SUMMARY },
			annotations: writeAnnotations,
		},
		async ({ uri }) => textResult(await updateHomepage(env, uri)),
	);

	server.registerTool(
		"claim_homepage",
		{
			title: "Claim Merchant homepage",
			description: "Claim the verified homepage for this account. Set overwrite to take the claim from another account. Requires approval.",
			inputSchema: { overwrite: z.boolean().default(false), change_summary: CHANGE_SUMMARY },
			annotations: writeAnnotations,
		},
		async ({ overwrite }) => textResult(await claimHomepage(env, overwrite)),
	);

	server.registerTool(
		"unclaim_homepage",
		{
			title: "Unclaim Merchant homepage",
			description: "Release the homepage claim. Products stop serving until it is claimed again. Requires approval.",
			inputSchema: { change_summary: CHANGE_SUMMARY },
			annotations: writeAnnotations,
		},
		async () => textResult(await unclaimHomepage(env)),
	);

	server.registerTool(
		"update_autofeed_settings",
		{
			title: "Update Merchant autofeed settings",
			description: "Turn automatic product crawling (autofeed) on or off. Requires approval.",
			inputSchema: { enable_products: z.boolean(), change_summary: CHANGE_SUMMARY },
			annotations: writeAnnotations,
		},
		async ({ enable_products }) => textResult(await updateAutofeedSettings(env, enable_products)),
	);

	server.registerTool(
		"update_automatic_improvements",
		{
			title: "Update Merchant automatic improvements",
			description: "Enable or disable automatic price, availability, condition, image, and shipping improvements. Only the flags you pass change. Requires approval.",
			inputSchema: {
				allow_price_updates: z.boolean().optional(),
				allow_availability_updates: z.boolean().optional(),
				allow_strict_availability_updates: z.boolean().optional(),
				allow_condition_updates: z.boolean().optional(),
				allow_automatic_image_improvements: z.boolean().optional(),
				allow_shipping_improvements: z.boolean().optional(),
				change_summary: CHANGE_SUMMARY,
			},
			annotations: writeAnnotations,
		},
		async (input) =>
			textResult(
				await updateAutomaticImprovements(env, {
					allowPriceUpdates: input.allow_price_updates,
					allowAvailabilityUpdates: input.allow_availability_updates,
					allowStrictAvailabilityUpdates: input.allow_strict_availability_updates,
					allowConditionUpdates: input.allow_condition_updates,
					allowAutomaticImageImprovements: input.allow_automatic_image_improvements,
					allowShippingImprovements: input.allow_shipping_improvements,
				}),
			),
	);

	// --- Programs and checkout settings -----------------------------------------------------

	server.registerTool(
		"get_program",
		{
			title: "Get Merchant program",
			description: "Read one program's state, active regions, and unmet requirements.",
			inputSchema: { program: PROGRAM },
			annotations: readAnnotations,
		},
		async ({ program }) => textResult(await getProgram(env, program)),
	);

	server.registerTool(
		"enable_program",
		{
			title: "Enable Merchant program",
			description: "Enable participation in a program such as free-listings or shopping-ads. Requires approval.",
			inputSchema: { program: PROGRAM, change_summary: CHANGE_SUMMARY },
			annotations: writeAnnotations,
		},
		async ({ program }) => textResult(await enableProgram(env, program)),
	);

	server.registerTool(
		"disable_program",
		{
			title: "Disable Merchant program",
			description: "Disable participation in a program. Products stop serving on that surface. Requires approval.",
			inputSchema: { program: PROGRAM, change_summary: CHANGE_SUMMARY },
			annotations: writeAnnotations,
		},
		async ({ program }) => textResult(await disableProgram(env, program)),
	);

	server.registerTool(
		"get_checkout_settings",
		{
			title: "Get program checkout settings",
			description: "Read the checkout URL settings and review state for a program.",
			inputSchema: { program: PROGRAM },
			annotations: readAnnotations,
		},
		async ({ program }) => textResult(await getCheckoutSettings(env, program)),
	);

	server.registerTool(
		"create_checkout_settings",
		{
			title: "Create program checkout settings",
			description: "Create checkout settings (uriSettings with checkoutUriTemplate or cartUriTemplate, eligibleDestinations). Requires approval.",
			inputSchema: { program: PROGRAM, settings_json: JSON_BODY, change_summary: CHANGE_SUMMARY },
			annotations: writeAnnotations,
		},
		async ({ program, settings_json }) => textResult(await createCheckoutSettings(env, program, parseJsonObject(settings_json, "settings_json"))),
	);

	server.registerTool(
		"update_checkout_settings",
		{
			title: "Update program checkout settings",
			description: "Patch checkout settings for a program. Requires approval.",
			inputSchema: { program: PROGRAM, update_mask: UPDATE_MASK, settings_json: JSON_BODY, change_summary: CHANGE_SUMMARY },
			annotations: writeAnnotations,
		},
		async ({ program, update_mask, settings_json }) =>
			textResult(await updateCheckoutSettings(env, program, update_mask, parseJsonObject(settings_json, "settings_json"))),
	);

	server.registerTool(
		"delete_checkout_settings",
		{
			title: "Delete program checkout settings",
			description: "Remove checkout settings for a program. Requires approval.",
			inputSchema: { program: PROGRAM, change_summary: CHANGE_SUMMARY },
			annotations: writeAnnotations,
		},
		async ({ program }) => textResult(await deleteCheckoutSettings(env, program)),
	);

	// --- Users, email preferences, UCP ---------------------------------------------------------

	server.registerTool(
		"get_user",
		{
			title: "Get Merchant account user",
			description: "Read one user's access rights and state.",
			inputSchema: { user_email: USER_EMAIL },
			annotations: readAnnotations,
		},
		async ({ user_email }) => textResult(await getUser(env, user_email)),
	);

	server.registerTool(
		"create_user",
		{
			title: "Invite Merchant account user",
			description: "Invite a Google account to this Merchant Center account with the given access rights. Requires approval.",
			inputSchema: { user_email: z.string().email(), access_rights: z.array(z.enum(ACCESS_RIGHTS)).min(1), change_summary: CHANGE_SUMMARY },
			annotations: writeAnnotations,
		},
		async ({ user_email, access_rights }) => textResult(await createUser(env, user_email, [...new Set(access_rights)])),
	);

	server.registerTool(
		"update_user",
		{
			title: "Update Merchant account user",
			description: "Replace a user's access rights. Requires approval.",
			inputSchema: { user_email: z.string().email(), access_rights: z.array(z.enum(ACCESS_RIGHTS)).min(1), change_summary: CHANGE_SUMMARY },
			annotations: writeAnnotations,
		},
		async ({ user_email, access_rights }) => textResult(await updateUser(env, user_email, [...new Set(access_rights)])),
	);

	server.registerTool(
		"delete_user",
		{
			title: "Remove Merchant account user",
			description: "Remove a user's access to the account. Requires approval.",
			inputSchema: { user_email: z.string().email(), change_summary: CHANGE_SUMMARY },
			annotations: writeAnnotations,
		},
		async ({ user_email }) => textResult(await deleteUser(env, user_email)),
	);

	server.registerTool(
		"get_email_preferences",
		{
			title: "Get user email preferences",
			description: "Read whether a user receives Merchant Center news and tips.",
			inputSchema: { user_email: USER_EMAIL.default("me") },
			annotations: readAnnotations,
		},
		async ({ user_email }) => textResult(await getEmailPreferences(env, user_email)),
	);

	server.registerTool(
		"update_email_preferences",
		{
			title: "Update user email preferences",
			description: "Opt a user in or out of Merchant Center news and tips emails. Requires approval.",
			inputSchema: { user_email: USER_EMAIL.default("me"), news_and_tips: z.enum(["OPTED_IN", "OPTED_OUT"]), change_summary: CHANGE_SUMMARY },
			annotations: writeAnnotations,
		},
		async ({ user_email, news_and_tips }) => textResult(await updateEmailPreferences(env, user_email, news_and_tips)),
	);

	server.registerTool(
		"get_ucp_settings",
		{
			title: "Get Universal Commerce Protocol settings",
			description: "Read the account's Universal Commerce Protocol (agentic checkout) settings.",
			inputSchema: {},
			annotations: readAnnotations,
		},
		async () => textResult(await getUcpSettings(env)),
	);

	server.registerTool(
		"update_ucp_settings",
		{
			title: "Update Universal Commerce Protocol settings",
			description: "Patch the account's Universal Commerce Protocol settings. Requires approval.",
			inputSchema: { update_mask: UPDATE_MASK, settings_json: JSON_BODY, change_summary: CHANGE_SUMMARY },
			annotations: writeAnnotations,
		},
		async ({ update_mask, settings_json }) => textResult(await updateUcpSettings(env, update_mask, parseJsonObject(settings_json, "settings_json"))),
	);

	// --- Return policies -----------------------------------------------------------------------

	server.registerTool(
		"create_return_policy",
		{
			title: "Create Merchant return policy",
			description:
				"Create an online return policy. Pass the OnlineReturnPolicy JSON (label, countries, policy, returnMethods, itemConditions, returnShippingFee, returnPolicyUri). Requires approval.",
			inputSchema: { policy_json: JSON_BODY, change_summary: CHANGE_SUMMARY },
			annotations: writeAnnotations,
		},
		async ({ policy_json }) => textResult(await createReturnPolicy(env, parseJsonObject(policy_json, "policy_json"))),
	);

	server.registerTool(
		"update_return_policy",
		{
			title: "Update Merchant return policy",
			description: "Patch selected fields of an online return policy. Requires approval.",
			inputSchema: { policy_id: RESOURCE_ID, update_mask: UPDATE_MASK, policy_json: JSON_BODY, change_summary: CHANGE_SUMMARY },
			annotations: writeAnnotations,
		},
		async ({ policy_id, update_mask, policy_json }) =>
			textResult(await updateReturnPolicy(env, policy_id, update_mask, parseJsonObject(policy_json, "policy_json"))),
	);

	server.registerTool(
		"delete_return_policy",
		{
			title: "Delete Merchant return policy",
			description: "Delete an online return policy. Requires approval.",
			inputSchema: { policy_id: RESOURCE_ID, change_summary: CHANGE_SUMMARY },
			annotations: writeAnnotations,
		},
		async ({ policy_id }) => textResult(await deleteReturnPolicy(env, policy_id)),
	);

	// --- Reviews ---------------------------------------------------------------------------------

	server.registerTool(
		"get_product_review",
		{
			title: "Get product review",
			description: "Read one uploaded product review and its status.",
			inputSchema: { review_id: RESOURCE_ID },
			annotations: readAnnotations,
		},
		async ({ review_id }) => textResult(await getProductReview(env, review_id)),
	);

	server.registerTool(
		"insert_product_review",
		{
			title: "Insert product review",
			description: "Upload or replace a product review in a product-review data source. Pass the ProductReview JSON. Requires approval.",
			inputSchema: { data_source: z.string().min(1), review_json: JSON_BODY, change_summary: CHANGE_SUMMARY },
			annotations: writeAnnotations,
		},
		async ({ data_source, review_json }) => textResult(await insertProductReview(env, data_source, parseJsonObject(review_json, "review_json"))),
	);

	server.registerTool(
		"delete_product_review",
		{
			title: "Delete product review",
			description: "Delete an uploaded product review. Requires approval.",
			inputSchema: { review_id: RESOURCE_ID, change_summary: CHANGE_SUMMARY },
			annotations: writeAnnotations,
		},
		async ({ review_id }) => textResult(await deleteProductReview(env, review_id)),
	);

	server.registerTool(
		"get_merchant_review",
		{
			title: "Get merchant review",
			description: "Read one uploaded seller review and its status.",
			inputSchema: { review_id: RESOURCE_ID },
			annotations: readAnnotations,
		},
		async ({ review_id }) => textResult(await getMerchantReview(env, review_id)),
	);

	server.registerTool(
		"insert_merchant_review",
		{
			title: "Insert merchant review",
			description: "Upload or replace a seller review in a merchant-review data source. Pass the MerchantReview JSON. Requires approval.",
			inputSchema: { data_source: z.string().min(1), review_json: JSON_BODY, change_summary: CHANGE_SUMMARY },
			annotations: writeAnnotations,
		},
		async ({ data_source, review_json }) => textResult(await insertMerchantReview(env, data_source, parseJsonObject(review_json, "review_json"))),
	);

	server.registerTool(
		"delete_merchant_review",
		{
			title: "Delete merchant review",
			description: "Delete an uploaded seller review. Requires approval.",
			inputSchema: { review_id: RESOURCE_ID, change_summary: CHANGE_SUMMARY },
			annotations: writeAnnotations,
		},
		async ({ review_id }) => textResult(await deleteMerchantReview(env, review_id)),
	);

	// --- Local feeds partnership ---------------------------------------------------------------

	const TARGET_ACCOUNT = z.string().regex(/^\d+$/).optional().describe("Merchant account ID that owns the stores; defaults to this account.");

	server.registerTool(
		"list_lfp_stores",
		{
			title: "List LFP stores",
			description: "List physical stores submitted through the local feeds partnership.",
			inputSchema: { ...PAGING_SCHEMA, target_account: TARGET_ACCOUNT },
			annotations: readAnnotations,
		},
		async ({ page_size, page_token, target_account }) => textResult(await listLfpStores(env, page_size, page_token, target_account)),
	);

	server.registerTool(
		"get_lfp_store",
		{
			title: "Get LFP store",
			description: "Read one physical store by store code, including its matching state.",
			inputSchema: { store_code: z.string().min(1).max(64), target_account: TARGET_ACCOUNT },
			annotations: readAnnotations,
		},
		async ({ store_code, target_account }) => textResult(await getLfpStore(env, store_code, target_account)),
	);

	server.registerTool(
		"insert_lfp_store",
		{
			title: "Insert LFP store",
			description: "Create or replace a physical store (storeCode, storeAddress, storeName, phoneNumber, placeId...). Requires approval.",
			inputSchema: { store_json: JSON_BODY, target_account: TARGET_ACCOUNT, change_summary: CHANGE_SUMMARY },
			annotations: writeAnnotations,
		},
		async ({ store_json, target_account }) => textResult(await insertLfpStore(env, parseJsonObject(store_json, "store_json"), target_account)),
	);

	server.registerTool(
		"delete_lfp_store",
		{
			title: "Delete LFP store",
			description: "Delete a physical store by store code. Requires approval.",
			inputSchema: { store_code: z.string().min(1).max(64), target_account: TARGET_ACCOUNT, change_summary: CHANGE_SUMMARY },
			annotations: writeAnnotations,
		},
		async ({ store_code, target_account }) => textResult(await deleteLfpStore(env, store_code, target_account)),
	);

	server.registerTool(
		"insert_lfp_inventory",
		{
			title: "Insert LFP inventory",
			description: "Submit in-store inventory for one product at one store (storeCode, offerId, regionCode, contentLanguage, price, availability, quantity). Requires approval.",
			inputSchema: { inventory_json: JSON_BODY, target_account: TARGET_ACCOUNT, change_summary: CHANGE_SUMMARY },
			annotations: writeAnnotations,
		},
		async ({ inventory_json, target_account }) =>
			textResult(await insertLfpInventory(env, parseJsonObject(inventory_json, "inventory_json"), target_account)),
	);

	server.registerTool(
		"insert_lfp_sale",
		{
			title: "Insert LFP sale",
			description: "Report an in-store sale (storeCode, offerId, regionCode, contentLanguage, price, quantity, saleTime). Requires approval.",
			inputSchema: { sale_json: JSON_BODY, target_account: TARGET_ACCOUNT, change_summary: CHANGE_SUMMARY },
			annotations: writeAnnotations,
		},
		async ({ sale_json, target_account }) => textResult(await insertLfpSale(env, parseJsonObject(sale_json, "sale_json"), target_account)),
	);

	server.registerTool(
		"get_lfp_merchant_state",
		{
			title: "Get LFP merchant state",
			description: "Read the local feeds partnership onboarding state: linked provider, store matching, and inventory verification.",
			inputSchema: { target_account: TARGET_ACCOUNT },
			annotations: readAnnotations,
		},
		async ({ target_account }) => textResult(await getLfpMerchantState(env, target_account)),
	);

	// --- Sub-accounts, terms of service, Business Profile, omnichannel -------------------------

	server.registerTool(
		"list_subaccounts",
		{
			title: "List Merchant sub-accounts",
			description: "List sub-accounts if this account is an advanced (multi-client) account.",
			inputSchema: PAGING_SCHEMA,
			annotations: readAnnotations,
		},
		async ({ page_size, page_token }) => textResult(await listSubaccounts(env, page_size, page_token)),
	);

	server.registerTool(
		"get_terms_of_service_state",
		{
			title: "Get terms of service agreement state",
			description: "Read which Merchant Center terms of service are accepted and which are pending for this account.",
			inputSchema: {},
			annotations: readAnnotations,
		},
		async () => textResult(await getTermsOfServiceAgreementState(env)),
	);

	server.registerTool(
		"retrieve_latest_terms_of_service",
		{
			title: "Retrieve latest terms of service",
			description: "Read the latest terms of service version for a region, including the version ID needed to accept it.",
			inputSchema: { region_code: COUNTRY_CODE, kind: z.enum(["MERCHANT_CENTER"]).default("MERCHANT_CENTER") },
			annotations: readAnnotations,
		},
		async ({ region_code, kind }) => textResult(await retrieveLatestTermsOfService(env, region_code, kind)),
	);

	server.registerTool(
		"accept_terms_of_service",
		{
			title: "Accept terms of service",
			description: "Accept a terms of service version for this account in a region. Legally binding. Requires approval.",
			inputSchema: {
				terms_of_service_version: z.string().min(1).max(100).describe("Version ID or full termsOfService/{id} name."),
				region_code: COUNTRY_CODE,
				change_summary: CHANGE_SUMMARY,
			},
			annotations: writeAnnotations,
		},
		async ({ terms_of_service_version, region_code }) => textResult(await acceptTermsOfService(env, terms_of_service_version, region_code)),
	);

	server.registerTool(
		"list_gbp_accounts",
		{
			title: "List linked Business Profile accounts",
			description: "List Google Business Profile accounts available to link for local listings.",
			inputSchema: PAGING_SCHEMA,
			annotations: readAnnotations,
		},
		async ({ page_size, page_token }) => textResult(await listGbpAccounts(env, page_size, page_token)),
	);

	server.registerTool(
		"link_gbp_account",
		{
			title: "Link Business Profile account",
			description: "Link a Google Business Profile account by its email so stores can be matched. Requires approval.",
			inputSchema: { gbp_email: z.string().email(), change_summary: CHANGE_SUMMARY },
			annotations: writeAnnotations,
		},
		async ({ gbp_email }) => textResult(await linkGbpAccount(env, gbp_email)),
	);

	server.registerTool(
		"list_omnichannel_settings",
		{
			title: "List omnichannel settings",
			description: "List per-country omnichannel (local inventory ads, pickup, in-stock serving) settings.",
			inputSchema: PAGING_SCHEMA,
			annotations: readAnnotations,
		},
		async ({ page_size, page_token }) => textResult(await listOmnichannelSettings(env, page_size, page_token)),
	);

	server.registerTool(
		"get_omnichannel_setting",
		{
			title: "Get omnichannel setting",
			description: "Read the omnichannel setting for one country.",
			inputSchema: { region_code: COUNTRY_CODE },
			annotations: readAnnotations,
		},
		async ({ region_code }) => textResult(await getOmnichannelSetting(env, region_code)),
	);

	server.registerTool(
		"create_omnichannel_setting",
		{
			title: "Create omnichannel setting",
			description: "Create the omnichannel setting for a country (regionCode, lsfType, inStock, pickup, lfpLink...). Requires approval.",
			inputSchema: { setting_json: JSON_BODY, change_summary: CHANGE_SUMMARY },
			annotations: writeAnnotations,
		},
		async ({ setting_json }) => textResult(await createOmnichannelSetting(env, parseJsonObject(setting_json, "setting_json"))),
	);

	server.registerTool(
		"update_omnichannel_setting",
		{
			title: "Update omnichannel setting",
			description: "Patch the omnichannel setting for a country. Requires approval.",
			inputSchema: { region_code: COUNTRY_CODE, update_mask: UPDATE_MASK, setting_json: JSON_BODY, change_summary: CHANGE_SUMMARY },
			annotations: writeAnnotations,
		},
		async ({ region_code, update_mask, setting_json }) =>
			textResult(await updateOmnichannelSetting(env, region_code, update_mask, parseJsonObject(setting_json, "setting_json"))),
	);

	server.registerTool(
		"request_inventory_verification",
		{
			title: "Request inventory verification",
			description: "Ask Google to start inventory verification for a country's omnichannel setting. Requires approval.",
			inputSchema: { region_code: COUNTRY_CODE, change_summary: CHANGE_SUMMARY },
			annotations: writeAnnotations,
		},
		async ({ region_code }) => textResult(await requestInventoryVerification(env, region_code)),
	);
}
