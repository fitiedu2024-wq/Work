const MERCHANT_API_ORIGIN = "https://merchantapi.googleapis.com";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const MERCHANT_SCOPE = "https://www.googleapis.com/auth/content";

type ServiceAccountCredentials = {
	client_email: string;
	private_key: string;
	private_key_id?: string;
	token_uri?: string;
};

type CachedAccessToken = { accessToken: string; expiresAt: number };

export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type ProductPatch = {
	dataSource: string;
	contentLanguage: string;
	feedLabel: string;
	offerId: string;
	attributes: JsonObject;
	updateFields: string[];
};

export type ProductInput = {
	dataSource: string;
	offerId: string;
	contentLanguage: string;
	feedLabel: string;
	title: string;
	description: string;
	link: string;
	imageLink: string;
	availability: "IN_STOCK" | "OUT_OF_STOCK" | "PREORDER" | "BACKORDER";
	condition: "NEW" | "USED" | "REFURBISHED";
	price: number;
	currencyCode: string;
	brand?: string;
	gtins?: string[];
	mpn?: string;
	googleProductCategory?: string;
};

function encodeBase64Url(value: string): string {
	const bytes = new TextEncoder().encode(value);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function productId(contentLanguage: string, feedLabel: string, offerId: string): string {
	return encodeURIComponent(`${contentLanguage}~${feedLabel}~${offerId}`);
}

export function pagedQuery(pageSize: number, pageToken?: string, extra: Record<string, string> = {}): URLSearchParams {
	const query = new URLSearchParams({ pageSize: String(pageSize), ...extra });
	if (pageToken) query.set("pageToken", pageToken);
	return query;
}

export function toMoney(amount: number, currencyCode: string): { amountMicros: string; currencyCode: string } {
	return {
		amountMicros: BigInt(Math.round(amount * 1_000_000)).toString(),
		currencyCode: currencyCode.toUpperCase(),
	};
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function assertIsoDate(value: string, label: string): string {
	if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) {
		throw new Error(`${label} must be a calendar date in YYYY-MM-DD format.`);
	}
	return value;
}

// Merchant Query Language string literals are single-quoted and backslash-escaped.
export function mqlString(value: string): string {
	return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJsonObject(value: string, label = "payload_json"): JsonObject {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error(`${label} must contain valid JSON.`);
	}
	if (!isJsonObject(parsed)) throw new Error(`${label} must be a JSON object.`);
	return parsed;
}

export function parseJsonObjectArray(value: string, label = "items_json"): JsonObject[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error(`${label} must contain valid JSON.`);
	}
	if (!Array.isArray(parsed) || !parsed.every(isJsonObject)) {
		throw new Error(`${label} must be a JSON array of objects.`);
	}
	return parsed;
}

export function assertAccountResource(env: Env, resource: string, collection: string): void {
	const prefix = `accounts/${env.MERCHANT_ACCOUNT_ID}/${collection}/`;
	if (!resource.startsWith(prefix)) {
		throw new Error(`The resource must belong to Merchant account ${env.MERCHANT_ACCOUNT_ID}.`);
	}
}

function parseServiceAccount(env: Env): ServiceAccountCredentials {
	let credentials: ServiceAccountCredentials;
	try {
		credentials = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON) as ServiceAccountCredentials;
	} catch {
		throw new Error("The Google service-account secret is not valid JSON.");
	}
	if (!credentials.client_email || !credentials.private_key) {
		throw new Error("The Google service-account secret is missing required fields.");
	}
	return credentials;
}

async function importPrivateKey(privateKey: string): Promise<CryptoKey> {
	const base64 = privateKey
		.replace("-----BEGIN PRIVATE KEY-----", "")
		.replace("-----END PRIVATE KEY-----", "")
		.replace(/\s/g, "");
	const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
	return crypto.subtle.importKey(
		"pkcs8",
		bytes,
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
}

async function createServiceAccountAssertion(credentials: ServiceAccountCredentials): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const header = encodeBase64Url(
		JSON.stringify({ alg: "RS256", typ: "JWT", ...(credentials.private_key_id ? { kid: credentials.private_key_id } : {}) }),
	);
	const payload = encodeBase64Url(
		JSON.stringify({
			iss: credentials.client_email,
			scope: MERCHANT_SCOPE,
			aud: credentials.token_uri || GOOGLE_TOKEN_URL,
			iat: now,
			exp: now + 3600,
		}),
	);
	const unsignedToken = `${header}.${payload}`;
	const key = await importPrivateKey(credentials.private_key);
	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		key,
		new TextEncoder().encode(unsignedToken),
	);
	let binarySignature = "";
	for (const byte of new Uint8Array(signature)) binarySignature += String.fromCharCode(byte);
	const encodedSignature = btoa(binarySignature)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
	return `${unsignedToken}.${encodedSignature}`;
}

async function getGoogleAccessToken(env: Env, forceRefresh = false): Promise<string> {
	const credentials = parseServiceAccount(env);
	const cacheKey = `merchant:access-token:${credentials.client_email}`;
	if (!forceRefresh) {
		const cached = await env.OAUTH_KV.get<CachedAccessToken>(cacheKey, "json");
		if (cached && cached.expiresAt > Date.now() + 60_000) return cached.accessToken;
	}
	const assertion = await createServiceAccountAssertion(credentials);
	const response = await fetch(credentials.token_uri || GOOGLE_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
			assertion,
		}),
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok) throw new Error(`Google authentication failed with HTTP ${response.status}.`);
	const token = (await response.json()) as { access_token?: string; expires_in?: number };
	if (!token.access_token) throw new Error("Google authentication returned no access token.");
	const expiresIn = Math.max(60, token.expires_in || 3600);
	await env.OAUTH_KV.put(
		cacheKey,
		JSON.stringify({ accessToken: token.access_token, expiresAt: Date.now() + expiresIn * 1000 }),
		{ expirationTtl: Math.max(60, expiresIn - 30) },
	);
	return token.access_token;
}

export async function merchantRequest<T>(env: Env, path: string, init: RequestInit = {}, retry = true): Promise<T> {
	const accessToken = await getGoogleAccessToken(env, !retry);
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${accessToken}`);
	if (init.body) headers.set("Content-Type", "application/json");
	const response = await fetch(`${MERCHANT_API_ORIGIN}${path}`, {
		...init,
		headers,
		signal: AbortSignal.timeout(20_000),
	});
	if (response.status === 401 && retry) return merchantRequest<T>(env, path, init, false);
	if (!response.ok) {
		let message = `Merchant API request failed with HTTP ${response.status}.`;
		try {
			const error = (await response.json()) as { error?: { message?: string } };
			if (error.error?.message) message += ` ${error.error.message}`;
		} catch {
			// Keep the status-only message when Google returns a non-JSON error.
		}
		throw new Error(message);
	}
	if (response.status === 204) return {} as T;
	return (await response.json()) as T;
}

const ALLOWED_MERCHANT_SUB_APIS = new Set([
	"accounts",
	"conversions",
	"datasources",
	"inventories",
	"issueresolution",
	"lfp",
	"loyaltyCustomers",
	"ordertracking",
	"products",
	"productstudio",
	"promotions",
	"quota",
	"reports",
	"reviews",
	"youtube",
	"youtubeshoppingcheckout",
]);

const READ_ONLY_POST_SUFFIXES = [
	":search",
	":renderaccountissues",
	":renderproductissues",
	":retrieveForApplication",
];

function validateScopedMerchantPath(env: Env, rawPath: string): string {
	const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
	if (
		path.length > 2000 ||
		path.includes("..") ||
		path.includes("\\") ||
		path.includes("://") ||
		path.includes("?") ||
		path.includes("#") ||
		/%2f|%5c/i.test(path)
	) {
		throw new Error("The Merchant API path is invalid.");
	}
	const segments = path.split("/").filter(Boolean);
	if (segments.length < 3 || !ALLOWED_MERCHANT_SUB_APIS.has(segments[0])) {
		throw new Error("The Merchant API sub-API is not allowed.");
	}
	const accountMatches = [...path.matchAll(/accounts\/(\d+)/g)].map((match) => match[1]);
	if (!accountMatches.length || accountMatches.some((accountId) => accountId !== env.MERCHANT_ACCOUNT_ID)) {
		throw new Error(`The path must be scoped only to Merchant account ${env.MERCHANT_ACCOUNT_ID}.`);
	}
	return path;
}

function buildQuery(query: JsonObject): URLSearchParams {
	const params = new URLSearchParams();
	const entries = Object.entries(query);
	if (entries.length > 30) throw new Error("Too many query parameters.");
	for (const [key, value] of entries) {
		if (!/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(key)) throw new Error(`Invalid query parameter: ${key}`);
		if (value === null || typeof value === "object") {
			throw new Error(`Query parameter ${key} must be a string, number, or boolean.`);
		}
		const rendered = String(value);
		if (rendered.length > 10_000) throw new Error(`Query parameter ${key} is too long.`);
		params.set(key, rendered);
	}
	return params;
}

export function merchantApiRead(
	env: Env,
	method: "GET" | "POST",
	pathValue: string,
	query: JsonObject,
	body: JsonObject,
): Promise<unknown> {
	const path = validateScopedMerchantPath(env, pathValue);
	if (method === "POST" && !READ_ONLY_POST_SUFFIXES.some((suffix) => path.endsWith(suffix))) {
		throw new Error("POST is allowed in the read tool only for reports and issue-rendering endpoints.");
	}
	const params = buildQuery(query);
	const requestPath = params.size ? `${path}?${params}` : path;
	return merchantRequest(env, requestPath, method === "GET" ? {} : { method, body: JSON.stringify(body) });
}

export function merchantApiWrite(
	env: Env,
	method: "POST" | "PATCH" | "DELETE",
	pathValue: string,
	query: JsonObject,
	body: JsonObject,
): Promise<unknown> {
	const path = validateScopedMerchantPath(env, pathValue);
	if (READ_ONLY_POST_SUFFIXES.some((suffix) => path.endsWith(suffix))) {
		throw new Error("Use merchant_api_read for this read-only POST endpoint.");
	}
	const params = buildQuery(query);
	const requestPath = params.size ? `${path}?${params}` : path;
	return merchantRequest(env, requestPath, {
		method,
		...(method === "DELETE" && !Object.keys(body).length ? {} : { body: JSON.stringify(body) }),
	});
}

export function getMerchantAccount(env: Env): Promise<unknown> {
	return merchantRequest(env, `/accounts/v1/accounts/${env.MERCHANT_ACCOUNT_ID}`);
}

export function listDataSources(env: Env, pageSize: number, pageToken?: string): Promise<unknown> {
	const query = new URLSearchParams({ pageSize: String(pageSize) });
	if (pageToken) query.set("pageToken", pageToken);
	return merchantRequest(env, `/datasources/v1/accounts/${env.MERCHANT_ACCOUNT_ID}/dataSources?${query}`);
}

export async function listProducts(env: Env, pageSize: number, pageToken?: string): Promise<unknown> {
	const query = new URLSearchParams({ pageSize: String(pageSize) });
	if (pageToken) query.set("pageToken", pageToken);
	return merchantRequest(env, `/products/v1/accounts/${env.MERCHANT_ACCOUNT_ID}/products?${query}`);
}

export function getProduct(env: Env, contentLanguage: string, feedLabel: string, offerId: string): Promise<unknown> {
	const id = productId(contentLanguage, feedLabel, offerId);
	return merchantRequest(env, `/products/v1/accounts/${env.MERCHANT_ACCOUNT_ID}/products/${id}`);
}

export function listAccountIssues(
	env: Env,
	pageSize: number,
	languageCode: string,
	pageToken?: string,
): Promise<unknown> {
	const query = new URLSearchParams({ pageSize: String(pageSize), languageCode });
	if (pageToken) query.set("pageToken", pageToken);
	return merchantRequest(env, `/accounts/v1/accounts/${env.MERCHANT_ACCOUNT_ID}/issues?${query}`);
}

export function searchMerchantReport(env: Env, query: string, pageSize: number, pageToken?: string): Promise<unknown> {
	return merchantRequest(env, `/reports/v1/accounts/${env.MERCHANT_ACCOUNT_ID}/reports:search`, {
		method: "POST",
		body: JSON.stringify({ query, pageSize, ...(pageToken ? { pageToken } : {}) }),
	});
}

export function upsertProduct(env: Env, input: ProductInput): Promise<unknown> {
	assertAccountResource(env, input.dataSource, "dataSources");
	const query = new URLSearchParams({ dataSource: input.dataSource });
	const productAttributes: Record<string, unknown> = {
		title: input.title,
		description: input.description,
		link: input.link,
		imageLink: input.imageLink,
		availability: input.availability,
		condition: input.condition,
		price: {
			amountMicros: BigInt(Math.round(input.price * 1_000_000)).toString(),
			currencyCode: input.currencyCode.toUpperCase(),
		},
	};
	if (input.brand) productAttributes.brand = input.brand;
	if (input.gtins?.length) productAttributes.gtins = input.gtins;
	if (input.mpn) productAttributes.mpn = input.mpn;
	if (input.googleProductCategory) productAttributes.googleProductCategory = input.googleProductCategory;
	return merchantRequest(env, `/products/v1/accounts/${env.MERCHANT_ACCOUNT_ID}/productInputs:insert?${query}`, {
		method: "POST",
		body: JSON.stringify({
			offerId: input.offerId,
			contentLanguage: input.contentLanguage,
			feedLabel: input.feedLabel,
			productAttributes,
		}),
	});
}

export function patchProduct(env: Env, input: ProductPatch): Promise<unknown> {
	assertAccountResource(env, input.dataSource, "dataSources");
	if (!input.updateFields.length) throw new Error("At least one update field is required.");
	const id = productId(input.contentLanguage, input.feedLabel, input.offerId);
	const query = new URLSearchParams({
		dataSource: input.dataSource,
		updateMask: input.updateFields.map((field) => `productAttributes.${field}`).join(","),
	});
	return merchantRequest(env, `/products/v1/accounts/${env.MERCHANT_ACCOUNT_ID}/productInputs/${id}?${query}`, {
		method: "PATCH",
		body: JSON.stringify({
			name: `accounts/${env.MERCHANT_ACCOUNT_ID}/productInputs/${decodeURIComponent(id)}`,
			productAttributes: input.attributes,
		}),
	});
}

export async function runBoundedBatch<T, R>(
	items: T[],
	operation: (item: T) => Promise<R>,
	concurrency = 5,
): Promise<Array<{ index: number; ok: boolean; result?: R; error?: string }>> {
	const results: Array<{ index: number; ok: boolean; result?: R; error?: string }> = new Array(items.length);
	let nextIndex = 0;
	const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
		while (true) {
			const index = nextIndex++;
			if (index >= items.length) return;
			try {
				results[index] = { index, ok: true, result: await operation(items[index]) };
			} catch (error) {
				results[index] = { index, ok: false, error: error instanceof Error ? error.message : "Unknown error" };
			}
		}
	});
	await Promise.all(workers);
	return results;
}

export function deleteProduct(
	env: Env,
	dataSource: string,
	contentLanguage: string,
	feedLabel: string,
	offerId: string,
): Promise<unknown> {
	assertAccountResource(env, dataSource, "dataSources");
	const id = productId(contentLanguage, feedLabel, offerId);
	const query = new URLSearchParams({ dataSource });
	return merchantRequest(env, `/products/v1/accounts/${env.MERCHANT_ACCOUNT_ID}/productInputs/${id}?${query}`, {
		method: "DELETE",
	});
}

export function getShippingSettings(env: Env): Promise<unknown> {
	return merchantRequest(env, `/accounts/v1/accounts/${env.MERCHANT_ACCOUNT_ID}/shippingSettings`);
}

export async function replaceShippingSettings(env: Env, expectedEtag: string, settings: JsonObject): Promise<unknown> {
	const current = await getShippingSettings(env);
	if (!isJsonObject(current) || typeof current.etag !== "string") {
		throw new Error("Google did not return the current shipping etag.");
	}
	if (current.etag !== expectedEtag) {
		throw new Error("Shipping settings changed since they were read. Read them again and use the new etag.");
	}
	return merchantRequest(env, `/accounts/v1/accounts/${env.MERCHANT_ACCOUNT_ID}/shippingSettings:insert`, {
		method: "POST",
		body: JSON.stringify({
			...settings,
			name: `accounts/${env.MERCHANT_ACCOUNT_ID}/shippingSettings`,
			etag: expectedEtag,
		}),
	});
}

export function listReturnPolicies(env: Env, pageSize: number, pageToken?: string): Promise<unknown> {
	const query = new URLSearchParams({ pageSize: String(pageSize) });
	if (pageToken) query.set("pageToken", pageToken);
	return merchantRequest(env, `/accounts/v1/accounts/${env.MERCHANT_ACCOUNT_ID}/onlineReturnPolicies?${query}`);
}

export function getReturnPolicy(env: Env, policyId: string): Promise<unknown> {
	return merchantRequest(
		env,
		`/accounts/v1/accounts/${env.MERCHANT_ACCOUNT_ID}/onlineReturnPolicies/${encodeURIComponent(policyId)}`,
	);
}

export function listPromotions(env: Env, pageSize: number, pageToken?: string): Promise<unknown> {
	const query = new URLSearchParams({ pageSize: String(pageSize) });
	if (pageToken) query.set("pageToken", pageToken);
	return merchantRequest(env, `/promotions/v1/accounts/${env.MERCHANT_ACCOUNT_ID}/promotions?${query}`);
}

export function getPromotion(env: Env, promotionIdValue: string): Promise<unknown> {
	return merchantRequest(
		env,
		`/promotions/v1/accounts/${env.MERCHANT_ACCOUNT_ID}/promotions/${encodeURIComponent(promotionIdValue)}`,
	);
}

export function upsertPromotion(env: Env, dataSource: string, promotion: JsonObject): Promise<unknown> {
	assertAccountResource(env, dataSource, "dataSources");
	return merchantRequest(env, `/promotions/v1/accounts/${env.MERCHANT_ACCOUNT_ID}/promotions:insert`, {
		method: "POST",
		body: JSON.stringify({ dataSource, promotion }),
	});
}

// ---------------------------------------------------------------------------
// Account, identity, and settings
// ---------------------------------------------------------------------------

export function accountPath(env: Env, suffix: string): string {
	return `/accounts/v1/accounts/${env.MERCHANT_ACCOUNT_ID}/${suffix}`;
}

export function getBusinessInfo(env: Env): Promise<unknown> {
	return merchantRequest(env, accountPath(env, "businessInfo"));
}

export function getBusinessIdentity(env: Env): Promise<unknown> {
	return merchantRequest(env, accountPath(env, "businessIdentity"));
}

export function getHomepage(env: Env): Promise<unknown> {
	return merchantRequest(env, accountPath(env, "homepage"));
}

export function listUsers(env: Env, pageSize: number, pageToken?: string): Promise<unknown> {
	return merchantRequest(env, `${accountPath(env, "users")}?${pagedQuery(pageSize, pageToken)}`);
}

export function listAccountRelationships(env: Env, pageSize: number, pageToken?: string): Promise<unknown> {
	return merchantRequest(env, `${accountPath(env, "relationships")}?${pagedQuery(pageSize, pageToken)}`);
}

export function listAccountServices(env: Env, pageSize: number, pageToken?: string): Promise<unknown> {
	return merchantRequest(env, `${accountPath(env, "services")}?${pagedQuery(pageSize, pageToken)}`);
}

export function getAutomaticImprovements(env: Env): Promise<unknown> {
	return merchantRequest(env, accountPath(env, "automaticImprovements"));
}

export function getAutofeedSettings(env: Env): Promise<unknown> {
	return merchantRequest(env, accountPath(env, "autofeedSettings"));
}

export function listPrograms(env: Env, pageSize: number, pageToken?: string): Promise<unknown> {
	return merchantRequest(env, `${accountPath(env, "programs")}?${pagedQuery(pageSize, pageToken)}`);
}

// ---------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------

export type RegionInput = {
	regionId: string;
	displayName?: string;
	regionCode?: string;
	postalCodes?: string[];
	geotargetCriteriaIds?: string[];
};

const REGION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function assertRegionId(regionId: string): string {
	if (!REGION_ID_PATTERN.test(regionId)) {
		throw new Error("region_id may only contain letters, digits, hyphens, and underscores (max 64).");
	}
	return regionId;
}

// Accepts "94108", "9410*", or ranges written as "begin-end" such as "94100-94199" or "94*-95*".
function parsePostalCodeRange(value: string): { begin: string; end?: string } {
	const trimmed = value.trim();
	if (!trimmed) throw new Error("Postal code entries cannot be empty.");
	const separator = trimmed.indexOf("-");
	if (separator === -1) return { begin: trimmed };
	const begin = trimmed.slice(0, separator).trim();
	const end = trimmed.slice(separator + 1).trim();
	if (!begin || !end) throw new Error(`Invalid postal code range: ${value}`);
	return { begin, end };
}

export function buildRegionBody(input: RegionInput): JsonObject {
	const hasPostal = Boolean(input.postalCodes?.length);
	const hasGeo = Boolean(input.geotargetCriteriaIds?.length);
	if (hasPostal === hasGeo) {
		throw new Error("Provide exactly one of postal_codes or geotarget_criteria_ids.");
	}
	const body: JsonObject = {};
	if (input.displayName) body.displayName = input.displayName;
	if (hasPostal) {
		if (!input.regionCode) throw new Error("region_code is required when defining a region by postal codes.");
		body.postalCodeArea = {
			regionCode: input.regionCode.toUpperCase(),
			postalCodes: input.postalCodes!.map((entry): JsonObject => {
				const range = parsePostalCodeRange(entry);
				return range.end ? { begin: range.begin, end: range.end } : { begin: range.begin };
			}),
		};
	} else {
		body.geotargetArea = { geotargetCriteriaIds: input.geotargetCriteriaIds! };
	}
	return body;
}

export function listRegions(env: Env, pageSize: number, pageToken?: string): Promise<unknown> {
	return merchantRequest(env, `${accountPath(env, "regions")}?${pagedQuery(pageSize, pageToken)}`);
}

export function getRegion(env: Env, regionId: string): Promise<unknown> {
	return merchantRequest(env, accountPath(env, `regions/${encodeURIComponent(assertRegionId(regionId))}`));
}

async function regionExists(env: Env, regionId: string): Promise<boolean> {
	try {
		await getRegion(env, regionId);
		return true;
	} catch (error) {
		if (error instanceof Error && /HTTP 404/.test(error.message)) return false;
		throw error;
	}
}

export async function upsertRegion(env: Env, input: RegionInput): Promise<unknown> {
	const regionId = assertRegionId(input.regionId);
	const body = buildRegionBody(input);
	if (await regionExists(env, regionId)) {
		const query = new URLSearchParams({ updateMask: Object.keys(body).join(",") });
		return merchantRequest(env, `${accountPath(env, `regions/${encodeURIComponent(regionId)}`)}?${query}`, {
			method: "PATCH",
			body: JSON.stringify({ name: `accounts/${env.MERCHANT_ACCOUNT_ID}/regions/${regionId}`, ...body }),
		});
	}
	const query = new URLSearchParams({ regionId });
	return merchantRequest(env, `${accountPath(env, "regions")}?${query}`, {
		method: "POST",
		body: JSON.stringify(body),
	});
}

export function deleteRegion(env: Env, regionId: string): Promise<unknown> {
	return merchantRequest(env, accountPath(env, `regions/${encodeURIComponent(assertRegionId(regionId))}`), {
		method: "DELETE",
	});
}

// ---------------------------------------------------------------------------
// Local and regional inventory
// ---------------------------------------------------------------------------

export type ProductKey = { contentLanguage: string; feedLabel: string; offerId: string };

export type LocalInventoryInput = ProductKey & {
	storeCode: string;
	availability?: "IN_STOCK" | "LIMITED_AVAILABILITY" | "ON_DISPLAY_TO_ORDER" | "OUT_OF_STOCK";
	price?: number;
	salePrice?: number;
	currencyCode?: string;
	quantity?: number;
	pickupMethod?: "BUY" | "RESERVE" | "SHIP_TO_STORE" | "NOT_SUPPORTED";
	pickupSla?:
		| "SAME_DAY"
		| "NEXT_DAY"
		| "TWO_DAY"
		| "THREE_DAY"
		| "FOUR_DAY"
		| "FIVE_DAY"
		| "SIX_DAY"
		| "SEVEN_DAY"
		| "MULTI_WEEK";
	instoreProductLocation?: string;
};

export type RegionalInventoryInput = ProductKey & {
	region: string;
	availability?: "IN_STOCK" | "OUT_OF_STOCK";
	price?: number;
	salePrice?: number;
	currencyCode?: string;
};

function inventoryPath(env: Env, key: ProductKey, suffix: string): string {
	const id = productId(key.contentLanguage, key.feedLabel, key.offerId);
	return `/inventories/v1/accounts/${env.MERCHANT_ACCOUNT_ID}/products/${id}/${suffix}`;
}

function priceAttributes(price?: number, salePrice?: number, currencyCode?: string): JsonObject {
	const attributes: JsonObject = {};
	if (price === undefined && salePrice === undefined) return attributes;
	if (!currencyCode) throw new Error("currency_code is required when setting a price or sale price.");
	if (price !== undefined) attributes.price = toMoney(price, currencyCode);
	if (salePrice !== undefined) attributes.salePrice = toMoney(salePrice, currencyCode);
	return attributes;
}

export function listLocalInventory(env: Env, key: ProductKey, pageSize: number, pageToken?: string): Promise<unknown> {
	return merchantRequest(env, `${inventoryPath(env, key, "localInventories")}?${pagedQuery(pageSize, pageToken)}`);
}

export function setLocalInventory(env: Env, input: LocalInventoryInput): Promise<unknown> {
	const needsSla = Boolean(input.pickupMethod) && input.pickupMethod !== "NOT_SUPPORTED";
	if (needsSla !== Boolean(input.pickupSla)) {
		throw new Error("pickup_method and pickup_sla must be provided together (unless pickup_method is NOT_SUPPORTED).");
	}
	const attributes: JsonObject = priceAttributes(input.price, input.salePrice, input.currencyCode);
	if (input.availability) attributes.availability = input.availability;
	if (input.quantity !== undefined) attributes.quantity = String(input.quantity);
	if (input.pickupMethod) attributes.pickupMethod = input.pickupMethod;
	if (input.pickupSla) attributes.pickupSla = input.pickupSla;
	if (input.instoreProductLocation) attributes.instoreProductLocation = input.instoreProductLocation;
	if (!Object.keys(attributes).length) throw new Error("Provide at least one inventory attribute to set.");
	return merchantRequest(env, inventoryPath(env, input, "localInventories:insert"), {
		method: "POST",
		body: JSON.stringify({ storeCode: input.storeCode, localInventoryAttributes: attributes }),
	});
}

export function deleteLocalInventory(env: Env, key: ProductKey, storeCode: string): Promise<unknown> {
	return merchantRequest(env, inventoryPath(env, key, `localInventories/${encodeURIComponent(storeCode)}`), {
		method: "DELETE",
	});
}

export function listRegionalInventory(
	env: Env,
	key: ProductKey,
	pageSize: number,
	pageToken?: string,
): Promise<unknown> {
	return merchantRequest(env, `${inventoryPath(env, key, "regionalInventories")}?${pagedQuery(pageSize, pageToken)}`);
}

export function setRegionalInventory(env: Env, input: RegionalInventoryInput): Promise<unknown> {
	const attributes: JsonObject = priceAttributes(input.price, input.salePrice, input.currencyCode);
	if (input.availability) attributes.availability = input.availability;
	if (!Object.keys(attributes).length) throw new Error("Provide at least one inventory attribute to set.");
	return merchantRequest(env, inventoryPath(env, input, "regionalInventories:insert"), {
		method: "POST",
		body: JSON.stringify({ region: assertRegionId(input.region), regionalInventoryAttributes: attributes }),
	});
}

export function deleteRegionalInventory(env: Env, key: ProductKey, region: string): Promise<unknown> {
	return merchantRequest(
		env,
		inventoryPath(env, key, `regionalInventories/${encodeURIComponent(assertRegionId(region))}`),
		{ method: "DELETE" },
	);
}

// ---------------------------------------------------------------------------
// Diagnostics: product issues, aggregate status, rendered issue guidance, quota
// ---------------------------------------------------------------------------

export const PRODUCT_STATUS_FILTERS = [
	"ALL",
	"NOT_ELIGIBLE_OR_DISAPPROVED",
	"ELIGIBLE_LIMITED",
	"ELIGIBLE",
	"PENDING",
] as const;

export type ProductStatusFilter = (typeof PRODUCT_STATUS_FILTERS)[number];

export function listProductIssues(
	env: Env,
	status: ProductStatusFilter,
	pageSize: number,
	pageToken?: string,
): Promise<unknown> {
	const fields = [
		"id",
		"offer_id",
		"title",
		"brand",
		"feed_label",
		"language_code",
		"availability",
		"price",
		"aggregated_reporting_context_status",
		"item_issues",
		"click_potential",
	];
	const where = status === "ALL" ? "" : ` WHERE aggregated_reporting_context_status = ${mqlString(status)}`;
	const query = `SELECT ${fields.join(", ")} FROM product_view${where}`;
	return searchMerchantReport(env, query, pageSize, pageToken);
}

export function listAggregateProductStatuses(
	env: Env,
	pageSize: number,
	pageToken?: string,
	reportingContext?: string,
	country?: string,
): Promise<unknown> {
	const clauses: string[] = [];
	if (reportingContext) {
		if (!/^[A-Z_]{1,64}$/.test(reportingContext)) throw new Error("reporting_context must be an upper-case enum name.");
		clauses.push(`reporting_context = "${reportingContext}"`);
	}
	if (country) {
		if (!/^[A-Z]{2}$/.test(country)) throw new Error("country must be a two-letter CLDR region code.");
		clauses.push(`country = "${country}"`);
	}
	const extra: Record<string, string> = clauses.length ? { filter: clauses.join(" AND ") } : {};
	return merchantRequest(
		env,
		`/issueresolution/v1/accounts/${env.MERCHANT_ACCOUNT_ID}/aggregateProductStatuses?${pagedQuery(pageSize, pageToken, extra)}`,
	);
}

function renderQuery(languageCode: string, timeZone?: string): URLSearchParams {
	const query = new URLSearchParams({ languageCode });
	if (timeZone) query.set("timeZone", timeZone);
	return query;
}

// Asking for built-in user-input actions makes Google return the action context and flow IDs
// that trigger_issue_action needs (for example to request a re-review).
const RENDER_ISSUES_BODY = JSON.stringify({
	contentOption: "PRE_RENDERED_HTML",
	userInputActionOption: "BUILT_IN_USER_INPUT_ACTIONS",
});

export function renderAccountIssues(env: Env, languageCode: string, timeZone?: string): Promise<unknown> {
	return merchantRequest(
		env,
		`/issueresolution/v1/accounts/${env.MERCHANT_ACCOUNT_ID}:renderaccountissues?${renderQuery(languageCode, timeZone)}`,
		{ method: "POST", body: RENDER_ISSUES_BODY },
	);
}

export function renderProductIssues(env: Env, key: ProductKey, languageCode: string, timeZone?: string): Promise<unknown> {
	const id = productId(key.contentLanguage, key.feedLabel, key.offerId);
	return merchantRequest(
		env,
		`/issueresolution/v1/accounts/${env.MERCHANT_ACCOUNT_ID}/products/${id}:renderproductissues?${renderQuery(languageCode, timeZone)}`,
		{ method: "POST", body: RENDER_ISSUES_BODY },
	);
}

export function getApiQuota(env: Env, pageSize: number, pageToken?: string): Promise<unknown> {
	return merchantRequest(env, `/quota/v1/accounts/${env.MERCHANT_ACCOUNT_ID}/quotas?${pagedQuery(pageSize, pageToken)}`);
}

// ---------------------------------------------------------------------------
// Conversions and reviews
// ---------------------------------------------------------------------------

export function listConversionSources(
	env: Env,
	pageSize: number,
	pageToken?: string,
	showDeleted = false,
): Promise<unknown> {
	const extra: Record<string, string> = showDeleted ? { showDeleted: "true" } : {};
	return merchantRequest(
		env,
		`/conversions/v1/accounts/${env.MERCHANT_ACCOUNT_ID}/conversionSources?${pagedQuery(pageSize, pageToken, extra)}`,
	);
}

export function listProductReviews(env: Env, pageSize: number, pageToken?: string): Promise<unknown> {
	return merchantRequest(
		env,
		`/reviews/v1alpha/accounts/${env.MERCHANT_ACCOUNT_ID}/productReviews?${pagedQuery(pageSize, pageToken)}`,
	);
}

export function listMerchantReviews(env: Env, pageSize: number, pageToken?: string): Promise<unknown> {
	return merchantRequest(
		env,
		`/reviews/v1alpha/accounts/${env.MERCHANT_ACCOUNT_ID}/merchantReviews?${pagedQuery(pageSize, pageToken)}`,
	);
}

// ---------------------------------------------------------------------------
// Shaped reports: performance, price insights, price competitiveness
// ---------------------------------------------------------------------------

export const PERFORMANCE_GROUPING_NAMES = [
	"total",
	"offer",
	"brand",
	"category",
	"product_type",
	"date",
	"week",
	"country",
	"marketing_method",
] as const;

export type PerformanceGrouping = (typeof PERFORMANCE_GROUPING_NAMES)[number];

const PERFORMANCE_GROUPINGS: Record<PerformanceGrouping, readonly string[]> = {
	total: [],
	offer: ["offer_id", "title"],
	brand: ["brand"],
	category: ["category_l1", "category_l2"],
	product_type: ["product_type_l1", "product_type_l2"],
	date: ["date"],
	week: ["week"],
	country: ["customer_country_code"],
	marketing_method: ["marketing_method"],
};

export const PERFORMANCE_METRICS = ["clicks", "impressions", "conversions"] as const;
export type PerformanceMetric = (typeof PERFORMANCE_METRICS)[number];

export type ProductPerformanceInput = {
	startDate: string;
	endDate: string;
	groupBy: PerformanceGrouping;
	orderBy: PerformanceMetric;
	limit: number;
	marketingMethod?: "ADS" | "ORGANIC";
	pageToken?: string;
};

export function buildProductPerformanceQuery(input: ProductPerformanceInput): string {
	const start = assertIsoDate(input.startDate, "start_date");
	const end = assertIsoDate(input.endDate, "end_date");
	if (start > end) throw new Error("start_date must not be after end_date.");
	const segments = PERFORMANCE_GROUPINGS[input.groupBy];
	const metrics = ["clicks", "impressions", "click_through_rate", "conversions", "conversion_rate"];
	const where = [`date BETWEEN ${mqlString(start)} AND ${mqlString(end)}`];
	if (input.marketingMethod) where.push(`marketing_method = ${mqlString(input.marketingMethod)}`);
	const orderBy = segments.length ? ` ORDER BY ${input.orderBy} DESC` : "";
	return `SELECT ${[...segments, ...metrics].join(", ")} FROM product_performance_view WHERE ${where.join(" AND ")}${orderBy} LIMIT ${input.limit}`;
}

export function getProductPerformance(env: Env, input: ProductPerformanceInput): Promise<unknown> {
	return searchMerchantReport(env, buildProductPerformanceQuery(input), input.limit, input.pageToken);
}

export function getPriceInsights(env: Env, pageSize: number, pageToken?: string): Promise<unknown> {
	const fields = [
		"id",
		"offer_id",
		"title",
		"brand",
		"price",
		"suggested_price",
		"predicted_impressions_change_fraction",
		"predicted_clicks_change_fraction",
		"predicted_conversions_change_fraction",
		"effectiveness",
	];
	return searchMerchantReport(env, `SELECT ${fields.join(", ")} FROM price_insights_product_view`, pageSize, pageToken);
}

export function getPriceCompetitiveness(env: Env, pageSize: number, pageToken?: string): Promise<unknown> {
	const fields = ["id", "offer_id", "title", "brand", "price", "benchmark_price", "report_country_code"];
	return searchMerchantReport(
		env,
		`SELECT ${fields.join(", ")} FROM price_competitiveness_product_view`,
		pageSize,
		pageToken,
	);
}
