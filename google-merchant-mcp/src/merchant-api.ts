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

function productId(contentLanguage: string, feedLabel: string, offerId: string): string {
	return encodeURIComponent(`${contentLanguage}~${feedLabel}~${offerId}`);
}

function isJsonObject(value: unknown): value is JsonObject {
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

function assertAccountResource(env: Env, resource: string, collection: string): void {
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

async function merchantRequest<T>(env: Env, path: string, init: RequestInit = {}, retry = true): Promise<T> {
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
