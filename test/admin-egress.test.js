import assert from 'node:assert/strict';
import { createHash, randomUUID, webcrypto } from 'node:crypto';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import { adminLogoutHeaders, injectEgressAdminShortcut, renderAdminLogoutPage, renderEgressAdminPage } from '../admin-egress.js';

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
			async delete(key) { entries.delete(key); },
			entries
		}
	};
}

async function login(environment) {
	const response = await worker.fetch(
		adminRequest('/login', { method: 'POST', origin: 'https://worker.example.test', body: 'password=test-admin' }),
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

async function adminActions(fetch) {
	const response = await injectEgressAdminShortcut(new Response('<html><body>Admin</body></html>', {
		headers: { 'Content-Type': 'text/html;charset=utf-8' }
	}));
	const html = await response.text();
	const source = /<script id="edgetunnel-admin-actions"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];
	assert.ok(source, 'the management actions must be injected after the upstream page');
	const state = { requests: [], messages: [], resets: 0, reloads: 0, redirects: [] };
	const window = {
		confirmReset() { assert.fail('legacy reset must be replaced'); },
		logout() { assert.fail('legacy logout must be replaced'); },
		showToast(message, type) { state.messages.push({ message, type }); },
		closeResetModal() { state.resets++; },
		location: {
			reload() { state.reloads++; },
			replace(path) { state.redirects.push(path); }
		}
	};
	runInNewContext(source, {
		window,
		fetch(path, options) { state.requests.push({ path, options }); return fetch(path, options); },
		setTimeout(callback, delay) { assert.equal(delay, 1000); callback(); }
	});
	assert.equal(state.requests.length, 0, 'loading the page must not submit an action');
	return { window, state };
}

function assertAdminPost(request, path) {
	assert.equal(request.path, path);
	assert.equal(request.options.method, 'POST');
	assert.equal(request.options.credentials, 'same-origin');
	assert.equal(request.options.cache, 'no-store');
	assert.equal(request.options.redirect, 'error');
	assert.equal(request.options.headers['Content-Type'], 'application/json');
	assert.equal(request.options.headers.Accept, 'application/json');
	assert.equal(request.options.body, '{}');
}

test('admin reset submits POST and updates the page only after successful completion', async () => {
	let complete;
	const response = new Promise(resolve => { complete = resolve; });
	const { window, state } = await adminActions(() => response);
	const action = window.confirmReset();
	assertAdminPost(state.requests[0], '/admin/init');
	assert.equal(state.resets, 0);
	assert.equal(state.reloads, 0);
	complete(new Response(JSON.stringify({ init: '配置已重置为默认值' })));
	await action;
	assert.equal(state.resets, 1);
	assert.equal(state.reloads, 1);
	assert.equal(state.messages.at(-1).type, 'success');
});

test('admin logout submits POST and navigates only after session revocation succeeds', async () => {
	let complete;
	const response = new Promise(resolve => { complete = resolve; });
	const { window, state } = await adminActions(() => response);
	const action = window.logout();
	assertAdminPost(state.requests[0], '/logout');
	assert.equal(state.redirects.length, 0);
	complete(new Response(JSON.stringify({ success: true })));
	await action;
	assert.deepEqual(state.redirects, ['/login']);
});

for (const name of ['confirmReset', 'logout']) {
	test(`admin ${name} reports failure without changing the current page`, async () => {
		const { window, state } = await adminActions(async () => new Response(JSON.stringify({ error: 'session expired' }), { status: 403 }));
		await window[name]();
		assert.equal(state.resets, 0);
		assert.equal(state.reloads, 0);
		assert.equal(state.redirects.length, 0);
		assert.equal(state.messages.at(-1).type, 'error');
		assert.match(state.messages.at(-1).message, /session expired/);
	});
}

test('admin logout does not navigate when a successful HTTP response omits revocation confirmation', async () => {
	const { window, state } = await adminActions(async () => new Response('{}'));
	await window.logout();
	assert.equal(state.redirects.length, 0);
	assert.equal(state.messages.at(-1).type, 'error');
});

test('logout confirmation requires an explicit form submission and permits only same-origin forms', () => {
	const page = renderAdminLogoutPage();
	assert.match(page, /<form method="POST" action="\/logout">/);
	assert.match(page, /<button type="submit">登出<\/button>/);
	assert.doesNotMatch(page, /<script|http-equiv=["']refresh|\.submit\(/i);
	const headers = adminLogoutHeaders();
	assert.match(headers['Cache-Control'], /no-store/);
	assert.match(headers['Content-Security-Policy'], /form-action 'self'/);
});

test('admin action injection remains idempotent when the egress shortcut already exists', async () => {
	const response = await injectEgressAdminShortcut(new Response('<html><body><a href="/admin/egress">Existing shortcut</a></body></html>', {
		headers: { 'Content-Type': 'text/html;charset=utf-8' }
	}));
	const reinjected = await injectEgressAdminShortcut(response);
	const html = await reinjected.text();
	assert.equal((html.match(/id="edgetunnel-admin-actions"/g) || []).length, 1);
	assert.equal((html.match(/href="\/admin\/egress"/g) || []).length, 1);
});

test('admin actions are injected into the outer page after inert HTML templates', async () => {
	const html = '<html><body><template id="preview"><html><body>Preview</body></html></template><script>function logout() { location.href = "/logout"; }</script></body></html>';
	const response = await injectEgressAdminShortcut(new Response(html, { headers: { 'Content-Type': 'text/html' } }));
	const result = await response.text();
	const scriptPosition = result.indexOf('<script id="edgetunnel-admin-actions"');
	assert.ok(scriptPosition > result.indexOf('</template>'));
	assert.ok(scriptPosition > result.indexOf('function logout()'));
	assert.ok(scriptPosition < result.lastIndexOf('</body>'));
	assert.equal(result.match(/id="edgetunnel-admin-actions"/g).length, 1);
});
