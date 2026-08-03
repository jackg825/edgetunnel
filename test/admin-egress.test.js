import assert from 'node:assert/strict';
import { createHash, randomUUID, webcrypto } from 'node:crypto';
import test from 'node:test';

import { injectEgressAdminShortcut, renderEgressAdminPage } from '../admin-egress.js';

const subtle = {
	async digest(algorithm, data) {
		if (String(algorithm).toUpperCase() === 'MD5') return Uint8Array.from(createHash('md5').update(Buffer.from(data)).digest()).buffer;
		return webcrypto.subtle.digest(algorithm, data);
	}
};

Object.defineProperty(globalThis, 'crypto', {
	configurable: true,
	value: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto), randomUUID, subtle }
});

const { default: worker } = await import('../_worker.js');

function adminRequest(path, { method = 'GET', body, cookie, origin } = {}) {
	const headers = new Headers({ 'user-agent': 'admin-egress-test' });
	if (cookie) headers.set('cookie', cookie);
	if (origin) headers.set('origin', origin);
	if (body !== undefined) headers.set('content-type', method === 'POST' ? 'application/json' : 'application/x-www-form-urlencoded');
	const request = new Request(`https://worker.example.test${path}`, { method, headers, body });
	Object.defineProperty(request, 'cf', { value: { colo: 'TPE', asn: 0, asOrganization: 'test', country: 'TW', city: 'Taipei' } });
	return request;
}

function adminEnvironment() {
	const entries = new Map();
	return {
		ADMIN: 'test-admin',
		KEY: 'test-key',
		UUID: '90cd4a77-141a-43c9-991b-08263cfe9c10',
		OFF_LOG: 'true',
		DEFAULT_EGRESS: 'mac',
		EGRESS_SITES: JSON.stringify([
			{ id: 'mac', name: 'Taiwan Mac mini', binding: 'EGRESS_MAC_NET', address: '192.0.2.10:19090', secret_env: 'EGRESS_MAC_RELAY_PASSWORD' },
			{ id: 'nas', name: 'NAS Site', binding: 'EGRESS_NAS_NET', address: '192.0.2.20:19090', secret_env: 'EGRESS_NAS_RELAY_PASSWORD' }
		]),
		EGRESS_MAC_RELAY_PASSWORD: 'must-never-appear-in-the-admin-page',
		EGRESS_NAS_RELAY_PASSWORD: 'must-also-remain-server-side',
		EGRESS_MAC_NET: { connect() { } },
		EGRESS_NAS_NET: { connect() { } },
		KV: {
			async get(key) { return entries.has(key) ? entries.get(key) : null; },
			async put(key, value) { entries.set(key, value); },
			entries
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

test('egress management requires an authenticated admin session', async () => {
	const response = await worker.fetch(adminRequest('/admin/egress'), adminEnvironment(), { waitUntil() { } });
	assert.equal(response.status, 302);
	assert.equal(response.headers.get('location'), '/login');
});

test('egress management shows only safe metadata for provisioned sites', async () => {
	const environment = adminEnvironment(), cookie = await login(environment);
	const response = await worker.fetch(adminRequest('/admin/egress', { cookie }), environment, { waitUntil() { } });
	assert.equal(response.status, 200);
	assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
	assert.match(response.headers.get('cache-control'), /no-store/);
	const page = await response.text();
	assert.match(page, /Taiwan Mac mini/);
	assert.match(page, /NAS Site/);
	assert.match(page, /VPC Binding 已設定/);
	assert.doesNotMatch(page, /must-never-appear-in-the-admin-page|must-also-remain-server-side/);
	assert.doesNotMatch(page, /Cloudflare API token.*input/i);
});

test('egress management saves only display and selection overrides to KV', async () => {
	const environment = adminEnvironment(), cookie = await login(environment);
	const payload = {
		defaultSite: 'nas',
		sites: [
			{ id: 'nas', name: 'Synology NAS', enabled: true },
			{ id: 'mac', name: 'Taiwan Mac mini', enabled: false }
		]
	};
	const response = await worker.fetch(adminRequest('/admin/egress', {
		method: 'POST', cookie, origin: 'https://worker.example.test', body: JSON.stringify(payload)
	}), environment, { waitUntil() { } });
	assert.equal(response.status, 200);
	const stored = JSON.parse(environment.KV.entries.get('egress-sites.json'));
	assert.deepEqual(stored, { version: 1, ...payload });
	assert.doesNotMatch(JSON.stringify(stored), /binding|address|secret|password/i);
});

test('egress management rejects disabling every provisioned site', async () => {
	const environment = adminEnvironment(), cookie = await login(environment);
	const response = await worker.fetch(adminRequest('/admin/egress', {
		method: 'POST', cookie, origin: 'https://worker.example.test', body: JSON.stringify({
			defaultSite: 'mac',
			sites: [
				{ id: 'mac', name: 'Mac', enabled: false },
				{ id: 'nas', name: 'NAS', enabled: false }
			]
		})
	}), environment, { waitUntil() { } });
	assert.equal(response.status, 400);
	assert.equal(environment.KV.entries.has('egress-sites.json'), false);
});

test('egress management escapes configured site metadata', () => {
	const page = renderEgressAdminPage({
		defaultSite: 'site',
		sites: [{
			id: 'site', name: '</script><script>alert(1)</script>', enabled: true,
			binding: 'EGRESS_SITE_NET', address: '192.0.2.20:19090', secretEnv: 'EGRESS_SITE_RELAY_PASSWORD',
			bindingConfigured: true, secretConfigured: true
		}]
	});
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
