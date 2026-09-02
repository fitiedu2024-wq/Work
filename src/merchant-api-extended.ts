import {
	accountPath,
	assertAccountResource,
	assertIsoDate,
	type JsonObject,
	merchantRequest,
	mqlString,
	pagedQuery,
	searchMerchantReport,
} from "./merchant-api";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function accountName(env: Env): string {
	return `accounts/${env.MERCHANT_ACCOUNT_ID}`;
}

// Accepts either a bare ID or a full resource name and returns the last path segment.
function resourceId(value: string, label: string): string {
	const id = value.trim().split("/").filter(Boolean).pop() ?? "";
	if (!id || id.includes("..")) throw new Error(`${label} is invalid.`);
	return encodeURIComponent(id);
}

const MASK_FIELD = /^[A-Za-z][A-Za-z0-9_.]{0,100}$/;

function withUpdateMask(path: string, updateMask: string[], extra: Record<string, string> = {}): string {
	const fields = [...new Set(updateMask.map((field) => field.trim()).filter(Boolean))];
	if (!fields.length) throw new Error("update_mask needs at least one field.");
	for (const field of fields) {
		if (!MASK_FIELD.test(field)) throw new Error(`Invalid update_mask field: ${field}`);
	}
	return `${path}?${new URLSearchParams({ updateMask: fields.join(","), ...extra })}`;
}

function post(body: JsonObject): RequestInit {
	return { method: "POST", body: JSON.stringify(body) };
}

function patch(body: JsonObject): RequestInit {
	return { method: "PATCH", body: JSON.stringify(body) };
}

const DELETE: RequestInit = { method: "DELETE" };

function assertCountryCode(value: string, label = "country_code"): string {
	if (!/^[A-Z]{2}$/.test(value)) throw new Error(`${label} must be a two-letter upper-case CLDR region code.`);
	return value;
}

function assertNumericId(value: string, label: string): string {
	if (!/^\d{1,20}$/.test(value)) throw new Error(`${label} must be numeric.`);
	return value;
}

// ---------------------------------------------------------------------------
// Product Studio: text suggestions and image generation
// ---------------------------------------------------------------------------

// Product Studio moved from v1alpha to v1; try the stable path first and fall back.
const PRODUCT_STUDIO_VERSIONS = ["v1", "v1alpha"] as const;

async function productStudioRequest(env: Env, suffix: string, body: JsonObject): Promise<unknown> {
	let lastError: unknown;
	for (const version of PRODUCT_STUDIO_VERSIONS) {
		try {
			return await merchantRequest(env, `/productstudio/${version}/${accountName(env)}/${suffix}`, post(body));
		} catch (error) {
			lastError = error;
			if (!(error instanceof Error && /HTTP 404/.test(error.message))) throw error;
		}
	}
	throw lastError;
}

export type TextSuggestionInput = {
	workflow: "title" | "description" | "tide";
	title?: string;
	description?: string;
	brand?: string;
	productType?: string;
	extraAttributes?: JsonObject;
	imageUri?: string;
	targetLanguage?: string;
	tone?: string;
	editorialChanges?: string;
	attributeSeparator?: string;
	titleExamples?: JsonObject[];
};

export function generateProductTextSuggestions(env: Env, input: TextSuggestionInput): Promise<unknown> {
	const productAttributes: JsonObject = {};
	if (input.title) productAttributes.title = input.title;
	if (input.description) productAttributes.description = input.description;
	if (input.brand) productAttributes.brand = input.brand;
	if (input.productType) productAttributes.product_type = input.productType;
	for (const [key, value] of Object.entries(input.extraAttributes ?? {})) {
		if (typeof value !== "string") throw new Error(`Extra attribute ${key} must be a string.`);
		productAttributes[key] = value;
	}
	if (!Object.keys(productAttributes).length && !input.imageUri) {
		throw new Error("Provide at least a title, description, attributes, or an image URI.");
	}
	const productInfo: JsonObject = { productAttributes };
	if (input.imageUri) productInfo.productImage = { uri: input.imageUri };
	const outputSpec: JsonObject = { workflowId: input.workflow };
	if (input.targetLanguage) outputSpec.targetLanguage = input.targetLanguage;
	if (input.tone) outputSpec.tone = input.tone;
	if (input.editorialChanges) outputSpec.editorialChanges = input.editorialChanges;
	if (input.attributeSeparator) outputSpec.attributeSeparator = input.attributeSeparator;
	const body: JsonObject = { productInfo, outputSpec };
	if (input.titleExamples?.length) body.titleExamples = input.titleExamples;
	return productStudioRequest(env, "generatedAttributes:generateProductTextSuggestions", body);
}

export type ImageSource = { uri?: string; base64?: string };

function inputImage(source: ImageSource): JsonObject {
	if (Boolean(source.uri) === Boolean(source.base64)) {
		throw new Error("Provide exactly one of image_uri or image_base64.");
	}
	return source.uri ? { uri: source.uri } : { imageBytes: source.base64! };
}

const IMAGE_OUTPUT: JsonObject = { returnImageUri: true };

export function generateProductImageBackground(
	env: Env,
	source: ImageSource,
	productDescription: string,
	backgroundDescription: string,
): Promise<unknown> {
	return productStudioRequest(env, "generatedImages:generateProductImageBackground", {
		inputImage: inputImage(source),
		config: { productDescription, backgroundDescription },
		outputConfig: IMAGE_OUTPUT,
	});
}

export function removeProductImageBackground(
	env: Env,
	source: ImageSource,
	backgroundColor?: { red: number; green: number; blue: number },
): Promise<unknown> {
	const body: JsonObject = { inputImage: inputImage(source), outputConfig: IMAGE_OUTPUT };
	if (backgroundColor) body.config = { backgroundColor };
	return productStudioRequest(env, "generatedImages:removeProductImageBackground", body);
}

export function upscaleProductImage(env: Env, source: ImageSource): Promise<unknown> {
	return productStudioRequest(env, "generatedImages:upscaleProductImage", {
		inputImage: inputImage(source),
		outputConfig: IMAGE_OUTPUT,
	});
}

// ---------------------------------------------------------------------------
// Issue resolution: trigger built-in actions such as re-review requests
// ---------------------------------------------------------------------------

export function triggerIssueAction(
	env: Env,
	actionContext: string,
	actionFlowId: string,
	inputValues: JsonObject[],
	languageCode: string,
): Promise<unknown> {
	return merchantRequest(
		env,
		`/issueresolution/v1/${accountName(env)}:triggeraction`,
		post({ payload: { actionContext, actionInput: { actionFlowId, inputValues } }, languageCode }),
	);
}

// ---------------------------------------------------------------------------
// Data sources and file uploads
// ---------------------------------------------------------------------------

function dataSourcesPath(env: Env, suffix = ""): string {
	return `/datasources/v1/${accountName(env)}/dataSources${suffix}`;
}

export function getDataSource(env: Env, dataSourceId: string): Promise<unknown> {
	return merchantRequest(env, dataSourcesPath(env, `/${resourceId(dataSourceId, "data_source_id")}`));
}

export function createDataSource(env: Env, dataSource: JsonObject): Promise<unknown> {
	return merchantRequest(env, dataSourcesPath(env), post(dataSource));
}

export function updateDataSource(env: Env, dataSourceId: string, updateMask: string[], dataSource: JsonObject): Promise<unknown> {
	const id = resourceId(dataSourceId, "data_source_id");
	return merchantRequest(
		env,
		withUpdateMask(dataSourcesPath(env, `/${id}`), updateMask),
		patch({ ...dataSource, name: `${accountName(env)}/dataSources/${decodeURIComponent(id)}` }),
	);
}

export function deleteDataSource(env: Env, dataSourceId: string): Promise<unknown> {
	return merchantRequest(env, dataSourcesPath(env, `/${resourceId(dataSourceId, "data_source_id")}`), DELETE);
}

export function fetchDataSource(env: Env, dataSourceId: string): Promise<unknown> {
	return merchantRequest(env, dataSourcesPath(env, `/${resourceId(dataSourceId, "data_source_id")}:fetch`), post({}));
}

export function getLatestFileUpload(env: Env, dataSourceId: string): Promise<unknown> {
	return merchantRequest(env, dataSourcesPath(env, `/${resourceId(dataSourceId, "data_source_id")}/fileUploads/latest`));
}

// ---------------------------------------------------------------------------
// Notification subscriptions
// ---------------------------------------------------------------------------

function subscriptionsPath(env: Env, suffix = ""): string {
	return `/notifications/v1/${accountName(env)}/notificationsubscriptions${suffix}`;
}

export function listNotificationSubscriptions(env: Env, pageSize: number, pageToken?: string): Promise<unknown> {
	return merchantRequest(env, `${subscriptionsPath(env)}?${pagedQuery(pageSize, pageToken)}`);
}

export function getNotificationSubscription(env: Env, subscriptionId: string): Promise<unknown> {
	return merchantRequest(env, subscriptionsPath(env, `/${resourceId(subscriptionId, "subscription_id")}`));
}

export function createNotificationSubscription(
	env: Env,
	registeredEvent: string,
	callBackUri: string,
	allManagedAccounts: boolean,
): Promise<unknown> {
	const body: JsonObject = { registeredEvent, callBackUri };
	if (allManagedAccounts) body.allManagedAccounts = true;
	else body.targetAccount = accountName(env);
	return merchantRequest(env, subscriptionsPath(env), post(body));
}

export function updateNotificationSubscription(env: Env, subscriptionId: string, callBackUri: string): Promise<unknown> {
	const id = resourceId(subscriptionId, "subscription_id");
	return merchantRequest(
		env,
		withUpdateMask(subscriptionsPath(env, `/${id}`), ["callBackUri"]),
		patch({ name: `${accountName(env)}/notificationsubscriptions/${decodeURIComponent(id)}`, callBackUri }),
	);
}

export function deleteNotificationSubscription(env: Env, subscriptionId: string): Promise<unknown> {
	return merchantRequest(env, subscriptionsPath(env, `/${resourceId(subscriptionId, "subscription_id")}`), DELETE);
}

// ---------------------------------------------------------------------------
// Shaped reports: best sellers, competitive visibility, non-product performance
// ---------------------------------------------------------------------------

export const BEST_SELLERS_VIEWS = ["product_cluster", "brand"] as const;
export const REPORT_GRANULARITIES = ["WEEKLY", "MONTHLY"] as const;

export type BestSellersInput = {
	view: (typeof BEST_SELLERS_VIEWS)[number];
	reportDate: string;
	granularity: (typeof REPORT_GRANULARITIES)[number];
	countryCode: string;
	categoryId?: string;
	limit: number;
	pageToken?: string;
};

const BEST_SELLERS_FIELDS: Record<(typeof BEST_SELLERS_VIEWS)[number], { table: string; fields: string[] }> = {
	product_cluster: {
		table: "best_sellers_product_cluster_view",
		fields: [
			"report_date",
			"report_granularity",
			"report_country_code",
			"report_category_id",
			"title",
			"brand",
			"category_l1",
			"category_l2",
			"category_l3",
			"variant_gtins",
			"inventory_status",
			"brand_inventory_status",
			"rank",
			"previous_rank",
			"relative_demand",
			"previous_relative_demand",
			"relative_demand_change",
		],
	},
	brand: {
		table: "best_sellers_brand_view",
		fields: [
			"report_date",
			"report_granularity",
			"report_country_code",
			"report_category_id",
			"brand",
			"rank",
			"previous_rank",
			"relative_demand",
			"previous_relative_demand",
			"relative_demand_change",
		],
	},
};

export function buildBestSellersQuery(input: BestSellersInput): string {
	const { table, fields } = BEST_SELLERS_FIELDS[input.view];
	const where = [
		`report_date = ${mqlString(assertIsoDate(input.reportDate, "report_date"))}`,
		`report_granularity = ${mqlString(input.granularity)}`,
		`report_country_code = ${mqlString(assertCountryCode(input.countryCode))}`,
	];
	if (input.categoryId) where.push(`report_category_id = ${assertNumericId(input.categoryId, "category_id")}`);
	return `SELECT ${fields.join(", ")} FROM ${table} WHERE ${where.join(" AND ")} ORDER BY rank ASC LIMIT ${input.limit}`;
}

export function getBestSellers(env: Env, input: BestSellersInput): Promise<unknown> {
	return searchMerchantReport(env, buildBestSellersQuery(input), input.limit, input.pageToken);
}

export const COMPETITIVE_VISIBILITY_VIEWS = ["competitor", "top_merchant", "benchmark"] as const;
export const TRAFFIC_SOURCES = ["ORGANIC", "ADS", "ALL"] as const;

export type CompetitiveVisibilityInput = {
	view: (typeof COMPETITIVE_VISIBILITY_VIEWS)[number];
	startDate: string;
	endDate: string;
	countryCode: string;
	trafficSource: (typeof TRAFFIC_SOURCES)[number];
	categoryId?: string;
	limit: number;
	pageToken?: string;
};

const COMPETITIVE_VISIBILITY_FIELDS: Record<
	(typeof COMPETITIVE_VISIBILITY_VIEWS)[number],
	{ table: string; fields: string[]; orderBy: string }
> = {
	competitor: {
		table: "competitive_visibility_competitor_view",
		fields: [
			"date",
			"domain",
			"is_your_domain",
			"report_country_code",
			"report_category_id",
			"traffic_source",
			"rank",
			"ads_organic_ratio",
			"page_overlap_rate",
			"higher_position_rate",
			"relative_visibility",
		],
		orderBy: "rank ASC",
	},
	top_merchant: {
		table: "competitive_visibility_top_merchant_view",
		fields: [
			"date",
			"domain",
			"is_your_domain",
			"report_country_code",
			"report_category_id",
			"traffic_source",
			"rank",
			"ads_organic_ratio",
			"page_overlap_rate",
			"higher_position_rate",
		],
		orderBy: "rank ASC",
	},
	benchmark: {
		table: "competitive_visibility_benchmark_view",
		fields: [
			"date",
			"report_country_code",
			"report_category_id",
			"traffic_source",
			"your_domain_visibility_trend",
			"category_benchmark_visibility_trend",
		],
		orderBy: "date ASC",
	},
};

export function buildCompetitiveVisibilityQuery(input: CompetitiveVisibilityInput): string {
	const start = assertIsoDate(input.startDate, "start_date");
	const end = assertIsoDate(input.endDate, "end_date");
	if (start > end) throw new Error("start_date must not be after end_date.");
	const { table, fields, orderBy } = COMPETITIVE_VISIBILITY_FIELDS[input.view];
	const where = [
		`date BETWEEN ${mqlString(start)} AND ${mqlString(end)}`,
		`report_country_code = ${mqlString(assertCountryCode(input.countryCode))}`,
		`traffic_source = ${mqlString(input.trafficSource)}`,
	];
	if (input.categoryId) where.push(`report_category_id = ${assertNumericId(input.categoryId, "category_id")}`);
	return `SELECT ${fields.join(", ")} FROM ${table} WHERE ${where.join(" AND ")} ORDER BY ${orderBy} LIMIT ${input.limit}`;
}

export function getCompetitiveVisibility(env: Env, input: CompetitiveVisibilityInput): Promise<unknown> {
	return searchMerchantReport(env, buildCompetitiveVisibilityQuery(input), input.limit, input.pageToken);
}

export const NON_PRODUCT_GROUPINGS = ["date", "week", "total"] as const;

export type NonProductPerformanceInput = {
	startDate: string;
	endDate: string;
	groupBy: (typeof NON_PRODUCT_GROUPINGS)[number];
	limit: number;
	pageToken?: string;
};

export function buildNonProductPerformanceQuery(input: NonProductPerformanceInput): string {
	const start = assertIsoDate(input.startDate, "start_date");
	const end = assertIsoDate(input.endDate, "end_date");
	if (start > end) throw new Error("start_date must not be after end_date.");
	const segments = input.groupBy === "total" ? [] : [input.groupBy];
	const metrics = ["clicks", "impressions", "click_through_rate"];
	const orderBy = segments.length ? ` ORDER BY ${segments[0]} ASC` : "";
	return `SELECT ${[...segments, ...metrics].join(", ")} FROM non_product_performance_view WHERE date BETWEEN ${mqlString(start)} AND ${mqlString(end)}${orderBy} LIMIT ${input.limit}`;
}

export function getNonProductPerformance(env: Env, input: NonProductPerformanceInput): Promise<unknown> {
	return searchMerchantReport(env, buildNonProductPerformanceQuery(input), input.limit, input.pageToken);
}

// ---------------------------------------------------------------------------
// Order tracking and conversion sources
// ---------------------------------------------------------------------------

export function createOrderTrackingSignal(env: Env, signal: JsonObject): Promise<unknown> {
	if (typeof signal.orderId !== "string" || !signal.orderId) throw new Error("The signal needs an orderId.");
	if (!Array.isArray(signal.shippingInfo) || !signal.shippingInfo.length) {
		throw new Error("The signal needs at least one shippingInfo entry.");
	}
	return merchantRequest(env, `/ordertracking/v1/${accountName(env)}/ordertrackingsignals`, post(signal));
}

function conversionSourcesPath(env: Env, suffix = ""): string {
	return `/conversions/v1/${accountName(env)}/conversionSources${suffix}`;
}

export function getConversionSource(env: Env, conversionSourceId: string): Promise<unknown> {
	return merchantRequest(env, conversionSourcesPath(env, `/${resourceId(conversionSourceId, "conversion_source_id")}`));
}

export function createConversionSource(env: Env, conversionSource: JsonObject): Promise<unknown> {
	return merchantRequest(env, conversionSourcesPath(env), post(conversionSource));
}

export function updateConversionSource(
	env: Env,
	conversionSourceId: string,
	updateMask: string[],
	conversionSource: JsonObject,
): Promise<unknown> {
	const id = resourceId(conversionSourceId, "conversion_source_id");
	return merchantRequest(
		env,
		withUpdateMask(conversionSourcesPath(env, `/${id}`), updateMask),
		patch({ ...conversionSource, name: `${accountName(env)}/conversionSources/${decodeURIComponent(id)}` }),
	);
}

export function deleteConversionSource(env: Env, conversionSourceId: string): Promise<unknown> {
	return merchantRequest(env, conversionSourcesPath(env, `/${resourceId(conversionSourceId, "conversion_source_id")}`), DELETE);
}

export function undeleteConversionSource(env: Env, conversionSourceId: string): Promise<unknown> {
	return merchantRequest(
		env,
		conversionSourcesPath(env, `/${resourceId(conversionSourceId, "conversion_source_id")}:undelete`),
		post({}),
	);
}

// ---------------------------------------------------------------------------
// Account settings writes: business info, identity, homepage, autofeed, improvements
// ---------------------------------------------------------------------------

export function updateBusinessInfo(env: Env, updateMask: string[], businessInfo: JsonObject): Promise<unknown> {
	return merchantRequest(
		env,
		withUpdateMask(accountPath(env, "businessInfo"), updateMask),
		patch({ ...businessInfo, name: `${accountName(env)}/businessInfo` }),
	);
}

export function updateBusinessIdentity(env: Env, updateMask: string[], businessIdentity: JsonObject): Promise<unknown> {
	return merchantRequest(
		env,
		withUpdateMask(accountPath(env, "businessIdentity"), updateMask),
		patch({ ...businessIdentity, name: `${accountName(env)}/businessIdentity` }),
	);
}

export function updateHomepage(env: Env, uri: string): Promise<unknown> {
	return merchantRequest(
		env,
		withUpdateMask(accountPath(env, "homepage"), ["uri"]),
		patch({ name: `${accountName(env)}/homepage`, uri }),
	);
}

export function claimHomepage(env: Env, overwrite: boolean): Promise<unknown> {
	return merchantRequest(env, accountPath(env, "homepage:claim"), post(overwrite ? { overwrite: true } : {}));
}

export function unclaimHomepage(env: Env): Promise<unknown> {
	return merchantRequest(env, accountPath(env, "homepage:unclaim"), post({}));
}

export function updateAutofeedSettings(env: Env, enableProducts: boolean): Promise<unknown> {
	return merchantRequest(
		env,
		withUpdateMask(accountPath(env, "autofeedSettings"), ["enableProducts"]),
		patch({ name: `${accountName(env)}/autofeedSettings`, enableProducts }),
	);
}

export type AutomaticImprovementsInput = {
	allowPriceUpdates?: boolean;
	allowAvailabilityUpdates?: boolean;
	allowStrictAvailabilityUpdates?: boolean;
	allowConditionUpdates?: boolean;
	allowAutomaticImageImprovements?: boolean;
	allowShippingImprovements?: boolean;
};

export function updateAutomaticImprovements(env: Env, input: AutomaticImprovementsInput): Promise<unknown> {
	const body: JsonObject = { name: `${accountName(env)}/automaticImprovements` };
	const mask: string[] = [];
	const itemUpdates: JsonObject = {};
	if (input.allowPriceUpdates !== undefined) itemUpdates.allowPriceUpdates = input.allowPriceUpdates;
	if (input.allowAvailabilityUpdates !== undefined) itemUpdates.allowAvailabilityUpdates = input.allowAvailabilityUpdates;
	if (input.allowStrictAvailabilityUpdates !== undefined) {
		itemUpdates.allowStrictAvailabilityUpdates = input.allowStrictAvailabilityUpdates;
	}
	if (input.allowConditionUpdates !== undefined) itemUpdates.allowConditionUpdates = input.allowConditionUpdates;
	if (Object.keys(itemUpdates).length) {
		body.itemUpdates = { accountItemUpdatesSettings: itemUpdates };
		mask.push("itemUpdates");
	}
	if (input.allowAutomaticImageImprovements !== undefined) {
		body.imageImprovements = {
			accountImageImprovementsSettings: { allowAutomaticImageImprovements: input.allowAutomaticImageImprovements },
		};
		mask.push("imageImprovements");
	}
	if (input.allowShippingImprovements !== undefined) {
		body.shippingImprovements = { allowShippingImprovements: input.allowShippingImprovements };
		mask.push("shippingImprovements");
	}
	if (!mask.length) throw new Error("Provide at least one automatic improvement setting to change.");
	return merchantRequest(env, withUpdateMask(accountPath(env, "automaticImprovements"), mask), patch(body));
}

// ---------------------------------------------------------------------------
// Programs and checkout settings
// ---------------------------------------------------------------------------

const PROGRAM_ID = /^[a-z0-9-]{1,64}$/;

function assertProgramId(program: string): string {
	if (!PROGRAM_ID.test(program)) throw new Error("program must be a lower-case ID such as free-listings or shopping-ads.");
	return program;
}

export function getProgram(env: Env, program: string): Promise<unknown> {
	return merchantRequest(env, accountPath(env, `programs/${assertProgramId(program)}`));
}

export function enableProgram(env: Env, program: string): Promise<unknown> {
	return merchantRequest(env, accountPath(env, `programs/${assertProgramId(program)}:enable`), post({}));
}

export function disableProgram(env: Env, program: string): Promise<unknown> {
	return merchantRequest(env, accountPath(env, `programs/${assertProgramId(program)}:disable`), post({}));
}

function checkoutSettingsPath(env: Env, program: string): string {
	return accountPath(env, `programs/${assertProgramId(program)}/checkoutSettings`);
}

export function getCheckoutSettings(env: Env, program: string): Promise<unknown> {
	return merchantRequest(env, checkoutSettingsPath(env, program));
}

export function createCheckoutSettings(env: Env, program: string, settings: JsonObject): Promise<unknown> {
	return merchantRequest(env, checkoutSettingsPath(env, program), post(settings));
}

export function updateCheckoutSettings(env: Env, program: string, updateMask: string[], settings: JsonObject): Promise<unknown> {
	return merchantRequest(
		env,
		withUpdateMask(checkoutSettingsPath(env, program), updateMask),
		patch({ ...settings, name: `${accountName(env)}/programs/${program}/checkoutSettings` }),
	);
}

export function deleteCheckoutSettings(env: Env, program: string): Promise<unknown> {
	return merchantRequest(env, checkoutSettingsPath(env, program), DELETE);
}

// ---------------------------------------------------------------------------
// Users, email preferences, and Universal Commerce Protocol settings
// ---------------------------------------------------------------------------

export const ACCESS_RIGHTS = ["STANDARD", "READ_ONLY", "ADMIN", "PERFORMANCE_REPORTING"] as const;

function userPath(env: Env, email: string, suffix = ""): string {
	if (!/^[^\s/]+@[^\s/]+\.[^\s/]+$/.test(email) && email !== "me") throw new Error("user_email must be an email address.");
	return accountPath(env, `users/${encodeURIComponent(email)}${suffix}`);
}

export function getUser(env: Env, email: string): Promise<unknown> {
	return merchantRequest(env, userPath(env, email));
}

export function createUser(env: Env, email: string, accessRights: string[]): Promise<unknown> {
	if (!accessRights.length) throw new Error("Provide at least one access right.");
	return merchantRequest(
		env,
		`${accountPath(env, "users")}?${new URLSearchParams({ userId: email })}`,
		post({ accessRights }),
	);
}

export function updateUser(env: Env, email: string, accessRights: string[]): Promise<unknown> {
	if (!accessRights.length) throw new Error("Provide at least one access right.");
	return merchantRequest(
		env,
		withUpdateMask(userPath(env, email), ["accessRights"]),
		patch({ name: `${accountName(env)}/users/${email}`, accessRights }),
	);
}

export function deleteUser(env: Env, email: string): Promise<unknown> {
	if (email === "me") throw new Error("Refusing to delete the current user.");
	return merchantRequest(env, userPath(env, email), DELETE);
}

export function getEmailPreferences(env: Env, email: string): Promise<unknown> {
	return merchantRequest(env, userPath(env, email, "/emailPreferences"));
}

export function updateEmailPreferences(env: Env, email: string, newsAndTips: "OPTED_IN" | "OPTED_OUT"): Promise<unknown> {
	return merchantRequest(
		env,
		withUpdateMask(userPath(env, email, "/emailPreferences"), ["newsAndTips"]),
		patch({ name: `${accountName(env)}/users/${email}/emailPreferences`, newsAndTips }),
	);
}

export function getUcpSettings(env: Env): Promise<unknown> {
	return merchantRequest(env, accountPath(env, "ucpSettings"));
}

export function updateUcpSettings(env: Env, updateMask: string[], settings: JsonObject): Promise<unknown> {
	return merchantRequest(
		env,
		withUpdateMask(accountPath(env, "ucpSettings"), updateMask),
		patch({ ...settings, name: `${accountName(env)}/ucpSettings` }),
	);
}

// ---------------------------------------------------------------------------
// Return policies
// ---------------------------------------------------------------------------

export function createReturnPolicy(env: Env, policy: JsonObject): Promise<unknown> {
	return merchantRequest(env, accountPath(env, "onlineReturnPolicies"), post(policy));
}

export function updateReturnPolicy(env: Env, policyId: string, updateMask: string[], policy: JsonObject): Promise<unknown> {
	const id = resourceId(policyId, "policy_id");
	return merchantRequest(
		env,
		withUpdateMask(accountPath(env, `onlineReturnPolicies/${id}`), updateMask),
		patch({ ...policy, name: `${accountName(env)}/onlineReturnPolicies/${decodeURIComponent(id)}` }),
	);
}

export function deleteReturnPolicy(env: Env, policyId: string): Promise<unknown> {
	return merchantRequest(env, accountPath(env, `onlineReturnPolicies/${resourceId(policyId, "policy_id")}`), DELETE);
}

// ---------------------------------------------------------------------------
// Reviews (writes)
// ---------------------------------------------------------------------------

function reviewsPath(env: Env, collection: "productReviews" | "merchantReviews", suffix = ""): string {
	return `/reviews/v1alpha/${accountName(env)}/${collection}${suffix}`;
}

export function getProductReview(env: Env, reviewId: string): Promise<unknown> {
	return merchantRequest(env, reviewsPath(env, "productReviews", `/${resourceId(reviewId, "review_id")}`));
}

export function insertProductReview(env: Env, dataSource: string, review: JsonObject): Promise<unknown> {
	assertAccountResource(env, dataSource, "dataSources");
	return merchantRequest(
		env,
		`${reviewsPath(env, "productReviews", ":insert")}?${new URLSearchParams({ dataSource })}`,
		post(review),
	);
}

export function deleteProductReview(env: Env, reviewId: string): Promise<unknown> {
	return merchantRequest(env, reviewsPath(env, "productReviews", `/${resourceId(reviewId, "review_id")}`), DELETE);
}

export function getMerchantReview(env: Env, reviewId: string): Promise<unknown> {
	return merchantRequest(env, reviewsPath(env, "merchantReviews", `/${resourceId(reviewId, "review_id")}`));
}

export function insertMerchantReview(env: Env, dataSource: string, review: JsonObject): Promise<unknown> {
	assertAccountResource(env, dataSource, "dataSources");
	return merchantRequest(
		env,
		`${reviewsPath(env, "merchantReviews", ":insert")}?${new URLSearchParams({ dataSource })}`,
		post(review),
	);
}

export function deleteMerchantReview(env: Env, reviewId: string): Promise<unknown> {
	return merchantRequest(env, reviewsPath(env, "merchantReviews", `/${resourceId(reviewId, "review_id")}`), DELETE);
}

// ---------------------------------------------------------------------------
// Local feeds partnership (LFP)
// ---------------------------------------------------------------------------

function lfpPath(env: Env, suffix: string): string {
	return `/lfp/v1/${accountName(env)}/${suffix}`;
}

function targetAccount(env: Env, value?: string): string {
	return assertNumericId(value ?? env.MERCHANT_ACCOUNT_ID, "target_account");
}

export function listLfpStores(env: Env, pageSize: number, pageToken?: string, target?: string): Promise<unknown> {
	return merchantRequest(
		env,
		`${lfpPath(env, "lfpStores")}?${pagedQuery(pageSize, pageToken, { targetAccount: targetAccount(env, target) })}`,
	);
}

export function getLfpStore(env: Env, storeCode: string, target?: string): Promise<unknown> {
	const id = encodeURIComponent(`${targetAccount(env, target)}~${storeCode}`);
	return merchantRequest(env, lfpPath(env, `lfpStores/${id}`));
}

export function insertLfpStore(env: Env, store: JsonObject, target?: string): Promise<unknown> {
	return merchantRequest(env, lfpPath(env, "lfpStores:insert"), post({ ...store, targetAccount: targetAccount(env, target) }));
}

export function deleteLfpStore(env: Env, storeCode: string, target?: string): Promise<unknown> {
	const id = encodeURIComponent(`${targetAccount(env, target)}~${storeCode}`);
	return merchantRequest(env, lfpPath(env, `lfpStores/${id}`), DELETE);
}

export function insertLfpInventory(env: Env, inventory: JsonObject, target?: string): Promise<unknown> {
	return merchantRequest(
		env,
		lfpPath(env, "lfpInventories:insert"),
		post({ ...inventory, targetAccount: targetAccount(env, target) }),
	);
}

export function insertLfpSale(env: Env, sale: JsonObject, target?: string): Promise<unknown> {
	return merchantRequest(env, lfpPath(env, "lfpSales:insert"), post({ ...sale, targetAccount: targetAccount(env, target) }));
}

export function getLfpMerchantState(env: Env, target?: string): Promise<unknown> {
	return merchantRequest(env, lfpPath(env, `lfpMerchantStates/${targetAccount(env, target)}`));
}

// ---------------------------------------------------------------------------
// Sub-accounts, terms of service, Business Profile links, omnichannel settings
// ---------------------------------------------------------------------------

export function listSubaccounts(env: Env, pageSize: number, pageToken?: string): Promise<unknown> {
	return merchantRequest(env, `/accounts/v1/${accountName(env)}:listSubaccounts?${pagedQuery(pageSize, pageToken)}`);
}

export function getTermsOfServiceAgreementState(env: Env): Promise<unknown> {
	return merchantRequest(env, accountPath(env, "termsOfServiceAgreementStates:retrieveForApplication"));
}

export function retrieveLatestTermsOfService(env: Env, regionCode: string, kind: string): Promise<unknown> {
	const query = new URLSearchParams({ regionCode: assertCountryCode(regionCode, "region_code"), kind });
	return merchantRequest(env, `/accounts/v1/termsOfService:retrieveLatest?${query}`);
}

export function acceptTermsOfService(env: Env, version: string, regionCode: string): Promise<unknown> {
	const id = assertNumericId(version.split("/").pop() ?? "", "terms_of_service_version");
	return merchantRequest(
		env,
		`/accounts/v1/termsOfService/${id}:accept`,
		post({ account: accountName(env), regionCode: assertCountryCode(regionCode, "region_code") }),
	);
}

export function listGbpAccounts(env: Env, pageSize: number, pageToken?: string): Promise<unknown> {
	return merchantRequest(env, `${accountPath(env, "gbpAccounts")}?${pagedQuery(pageSize, pageToken)}`);
}

export function linkGbpAccount(env: Env, gbpEmail: string): Promise<unknown> {
	return merchantRequest(env, accountPath(env, "gbpAccounts:linkGbpAccount"), post({ gbpEmail }));
}

export function listOmnichannelSettings(env: Env, pageSize: number, pageToken?: string): Promise<unknown> {
	return merchantRequest(env, `${accountPath(env, "omnichannelSettings")}?${pagedQuery(pageSize, pageToken)}`);
}

export function getOmnichannelSetting(env: Env, regionCode: string): Promise<unknown> {
	return merchantRequest(env, accountPath(env, `omnichannelSettings/${assertCountryCode(regionCode, "region_code")}`));
}

export function createOmnichannelSetting(env: Env, setting: JsonObject): Promise<unknown> {
	return merchantRequest(env, accountPath(env, "omnichannelSettings"), post(setting));
}

export function updateOmnichannelSetting(env: Env, regionCode: string, updateMask: string[], setting: JsonObject): Promise<unknown> {
	const code = assertCountryCode(regionCode, "region_code");
	return merchantRequest(
		env,
		withUpdateMask(accountPath(env, `omnichannelSettings/${code}`), updateMask),
		patch({ ...setting, name: `${accountName(env)}/omnichannelSettings/${code}` }),
	);
}

export function requestInventoryVerification(env: Env, regionCode: string): Promise<unknown> {
	const code = assertCountryCode(regionCode, "region_code");
	return merchantRequest(env, accountPath(env, `omnichannelSettings/${code}:requestInventoryVerification`), post({}));
}
