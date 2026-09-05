const SESSION_SECONDS = 86400;
const SESSION_PREFIX = 'admin-session:';

function sessionToken(request) {
	const value = (request.headers.get('Cookie') || '').split(';')
		.map(cookie => cookie.trim()).find(cookie => cookie.startsWith('auth='))?.slice(5);
	return /^[a-f0-9]{64}$/.test(value || '') ? value : null;
}

async function digest(value) {
	const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function credentialTag(request, password, key) {
	return digest(JSON.stringify([new URL(request.url).origin, request.headers.get('User-Agent') || 'null', password, key]));
}

export function isSameOriginAdminRequest(request) {
	return request.headers.get('Origin') === new URL(request.url).origin
		&& request.headers.get('Sec-Fetch-Site') !== 'cross-site';
}

export function adminSessionCookie(token = '') {
	return `auth=${token}; Path=/; Max-Age=${token ? SESSION_SECONDS : 0}; HttpOnly; Secure; SameSite=Lax`;
}

export async function readAdminSession(request, env, password, key) {
	const token = sessionToken(request);
	if (!token) return null;
	const storageKey = SESSION_PREFIX + await digest(token);
	const text = await env.KV.get(storageKey);
	if (!text) return null;
	let session;
	try { session = JSON.parse(text); } catch { return null; }
	const now = Date.now();
	if (session?.version !== 1 || !Number.isSafeInteger(session.createdAt) || !Number.isSafeInteger(session.expiresAt)
		|| session.createdAt > now || session.expiresAt <= now
		|| session.expiresAt - session.createdAt !== SESSION_SECONDS * 1000
		|| session.credentialTag !== await credentialTag(request, password, key)) return null;
	return { storageKey };
}

export async function createAdminSession(request, env, password, key) {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	const token = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
	const createdAt = Date.now();
	await env.KV.put(SESSION_PREFIX + await digest(token), JSON.stringify({
		version: 1, createdAt, expiresAt: createdAt + SESSION_SECONDS * 1000,
		credentialTag: await credentialTag(request, password, key)
	}), { expirationTtl: SESSION_SECONDS });
	return token;
}

export async function revokeAdminSession(request, env) {
	// Revoke the presented token even if a browser update changed its user agent.
	const token = sessionToken(request);
	if (token) await env.KV.delete(SESSION_PREFIX + await digest(token));
}
