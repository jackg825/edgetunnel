import assert from 'node:assert/strict';
import { createHash, randomUUID, webcrypto } from 'node:crypto';
import test from 'node:test';

import { injectEgressAdminShortcut, renderEgressAdminPage } from '../admin-egress.js';

const subtle = {
	async digest(algorithm, data) {
		if (String(algorithm).toUpperCase() === 'MD5') {
			return Uint8Array.from(createHash('md5').update(Buffer.from(data)).digest()).buffer;
		}
		return webcrypto.subtle.digest(algorithm, data);
	}
};

Object.defineProperty(globalThis, 'crypto', {
	configurable: true,
	value: {
		getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
		randomUUID,
		subtle
	}
});

const { default: worker } = await import('../_worker.js');

function adminRequest(path, { method = 'GET', body, cookie } = {}) {
	const headers = new Headers({ 'user-agent': 'admin-egress-test' });
	if (cookie) headers.set('cookie', cookie);
	if (body !== undefined) headers.set('content-type', 'application/x-www-form-urlencoded');
	const request = new Request(`https://worker.example.test${path}`, { method, headers, body });
	Object.defineProperty(request, 'cf', {
		value: { colo: 'TPE', asn: 0, asOrganization: 'test', country: 'TW', city: 'Taipei' }
	});
	return request;
}

function adminEnvironment() {
	return {
		ADMIN: 'test-admin',
		KEY: 'test-key',
		UUID: '90cd4a77-141a-43c9-991b-08263cfe9c10',
		OFF_LOG: 'true',
		DEFAULT_EGRESS: 'mac',
		EGRESS_SITES: JSON.stringify([
			{ id: 'mac', name: 'Taiwan Mac mini', binding: 'EGRESS_MAC_NET', address: '192.0.2.10:19090', secret_env: 'EGRESS_MAC_RELAY_PASSWORD' }
		]),
		EGRESS_MAC_RELAY_PASSWORD: 'must-never-appear-in-the-admin-page',
		EGRESS_MAC_NET: { connect() { } },
		KV: {
			async get() { return null; },
			async put() { throw new Error('egress onboarding must not write KV'); }
		}
	};
}

async function login(environment) {
	const response = await worker.fetch(
		adminRequest('/login', { method: 'POST', body: 'password=test-admin' }),
		environment,
		{ waitUntil() { } }
	);
	assert.equal(response.status, 200);
	return response.headers.get('set-cookie').split(';', 1)[0];
}

test('egress onboarding requires an authenticated admin session', async () => {
	const response = await worker.fetch(adminRequest('/admin/egress'), adminEnvironment(), { waitUntil() { } });
	assert.equal(response.status, 302);
	assert.equal(response.headers.get('location'), '/login');
});

test('egress onboarding generates credentials in the browser without exposing Worker secrets', async () => {
	const environment = adminEnvironment();
	const cookie = await login(environment);
	const response = await worker.fetch(adminRequest('/admin/egress', { cookie }), environment, { waitUntil() { } });
	assert.equal(response.status, 200);
	assert.match(response.headers.get('content-security-policy'), /connect-src 'none'/);
	assert.match(response.headers.get('cache-control'), /no-store/);
	const page = await response.text();
	assert.match(page, /crypto\.getRandomValues\(new Uint8Array\(32\)\)/);
	assert.match(page, /Taiwan Mac mini/);
	assert.match(page, /Secret 已設定/);
	assert.match(page, /npx wrangler secret put/);
	assert.doesNotMatch(page, /must-never-appear-in-the-admin-page/);
	assert.doesNotMatch(page, /Cloudflare API token.*input/i);
});

test('egress onboarding escapes configured site metadata', () => {
	const page = renderEgressAdminPage([{
		id: 'site',
		name: '</script><script>alert(1)</script>',
		binding: 'EGRESS_SITE_NET',
		address: '192.0.2.20:19090',
		secretEnv: 'EGRESS_SITE_RELAY_PASSWORD',
		bindingConfigured: true,
		secretConfigured: true
	}]);
	assert.doesNotMatch(page, /<script>alert\(1\)<\/script>/);
	assert.match(page, /&lt;\/script&gt;/);
});

test('existing admin page receives a discoverable egress shortcut', async () => {
	const response = await injectEgressAdminShortcut(new Response('<html><body>Admin</body></html>', {
		headers: { 'Content-Type': 'text/html;charset=utf-8', ETag: 'test' }
	}));
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('etag'), null);
	assert.match(await response.text(), /href="\/admin\/egress"/);
});
