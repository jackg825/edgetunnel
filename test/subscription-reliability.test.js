import assert from 'node:assert/strict';
import { createHash, randomUUID, webcrypto } from 'node:crypto';
import test from 'node:test';

Object.defineProperty(globalThis, 'crypto', {
	configurable: true,
	value: {
		getRandomValues: webcrypto.getRandomValues.bind(webcrypto), randomUUID,
		subtle: {
			async digest(algorithm, data) {
				if (String(algorithm).toUpperCase() === 'MD5') return Uint8Array.from(createHash('md5').update(Buffer.from(data)).digest()).buffer;
				return webcrypto.subtle.digest(algorithm, data);
			}
		}
	}
});

const { default: worker } = await import('../_worker.js');
const context = { waitUntil() { } };

function request(path, { method = 'GET', body, cookie } = {}) {
	const headers = new Headers({ 'user-agent': 'Shadowrocket' });
	if (cookie) headers.set('cookie', cookie);
	const result = new Request(`https://worker.example.test${path}`, { method, body, headers });
	Object.defineProperty(result, 'cf', { value: { colo: 'TPE', country: 'TW', asn: 0 } });
	return result;
}

async function subscriptionEnvironment() {
	const entries = new Map([['ADD.txt', '104.16.1.1:443#TestNode']]);
	const environment = {
		ADMIN: 'test-admin', KEY: 'test-key', UUID: '90cd4a77-141a-43c9-991b-08263cfe9c10',
		OFF_LOG: 'true', DEFAULT_EGRESS: 'mac', EGRESS_PROTOCOL: 'trojan',
		EGRESS_SITES: JSON.stringify([
			{ id: 'mac', name: 'Mac', binding: 'MAC_NET', address: '127.0.0.1:19090', secret_env: 'MAC_SECRET' },
			{ id: 'nas', name: 'NAS', binding: 'NAS_NET', address: '192.0.2.20:19090', secret_env: 'NAS_SECRET' }
		]),
		KV: {
			async get(key) { return entries.get(key) ?? null; },
			async put(key, value) { entries.set(key, value); }
		}
	};
	const login = await worker.fetch(request('/login', { method: 'POST', body: 'password=test-admin' }), environment, context);
	const cookie = login.headers.get('set-cookie').split(';', 1)[0];
	const configuration = await worker.fetch(request('/admin/config.json', { cookie }), environment, context);
	assert.equal(configuration.status, 200);
	const config = await configuration.json();
	config.优选订阅生成.本地IP库.随机IP = false;
	await environment.KV.put('config.json', JSON.stringify(config));
	return { environment, cookie, path: `/sub?token=${config.优选订阅生成.TOKEN}` };
}

test('overlapping subscriptions keep their own ECH setting in the same environment', { timeout: 3000 }, async t => {
	t.mock.method(globalThis, 'fetch', async () => assert.fail('subscription must use the local IP list'));
	const { environment, path } = await subscriptionEnvironment();
	let reachedFirstRead, releaseFirstRead;
	const firstRead = new Promise(resolve => { reachedFirstRead = resolve; });
	const released = new Promise(resolve => { releaseFirstRead = resolve; });
	const originalGet = environment.KV.get;
	let pauseNextRead = true;
	environment.KV.get = async key => {
		if (key === 'ADD.txt' && pauseNextRead) {
			pauseNextRead = false;
			reachedFirstRead();
			await released;
		}
		return originalGet(key);
	};
	const first = worker.fetch(request(`${path}&ech=true`), environment, context);
	try {
		await firstRead;
		const second = await worker.fetch(request(`${path}&ech=false`), environment, context);
		assert.equal(second.status, 200);
		assert.doesNotMatch(Buffer.from(await second.text(), 'base64').toString('utf8'), /&ech=/);
	} finally {
		releaseFirstRead();
	}
	const response = await first;
	assert.equal(response.status, 200);
	const links = Buffer.from(await response.text(), 'base64').toString('utf8').trim().split('\n');
	assert.equal(links.length, 2);
	for (const link of links) assert.ok(new URL(link).searchParams.get('ech'), 'the earlier request must retain ech=true');
});

test('overlapping configuration reads retain the configuration loaded by each request', { timeout: 3000 }, async t => {
	t.mock.method(globalThis, 'fetch', async () => assert.fail('configuration reads must stay local'));
	const { environment, cookie } = await subscriptionEnvironment();
	const stored = JSON.parse(await environment.KV.get('config.json'));
	stored.PATH = '/before';
	await environment.KV.put('config.json', JSON.stringify(stored));
	let reachedFirstRead, releaseFirstRead;
	const firstRead = new Promise(resolve => { reachedFirstRead = resolve; });
	const released = new Promise(resolve => { releaseFirstRead = resolve; });
	const originalGet = environment.KV.get;
	let pauseNextRead = true;
	environment.KV.get = async key => {
		if (key === 'tg.json' && pauseNextRead) {
			pauseNextRead = false;
			reachedFirstRead();
			await released;
		}
		return originalGet(key);
	};
	const first = worker.fetch(request('/admin/config.json', { cookie }), environment, context);
	try {
		await firstRead;
		stored.PATH = '/after';
		await environment.KV.put('config.json', JSON.stringify(stored));
		const second = await worker.fetch(request('/admin/config.json', { cookie }), environment, context);
		assert.equal(second.status, 200);
		assert.equal((await second.json()).完整节点路径, '/egress=mac/after');
	} finally {
		releaseFirstRead();
	}
	const response = await first;
	assert.equal(response.status, 200);
	assert.equal((await response.json()).完整节点路径, '/egress=mac/before');
});

function surgeConfiguration(lines) {
	return `#!MANAGED-CONFIG placeholder\n[Proxy]\n${lines.join('\n')}\n`;
}

function surgeNode(name, options = '') {
	return `${name} = trojan, 104.16.1.1, 443, password=00000000-0000-4000-8000-000000000000, sni=example.com, skip-cert-verify=false${options}`;
}

test('Surge preserves each explicit egress selector independently of node names', async t => {
	const converted = surgeConfiguration([
		surgeNode('NAS label', ', ws=true, ws-path=/egress=mac/tunnel'),
		surgeNode('Mac label', ', ws=true, ws-path="/egress=nas/tunnel"')
	]);
	t.mock.method(globalThis, 'fetch', async () => new Response(converted));
	const { environment, path } = await subscriptionEnvironment();
	const response = await worker.fetch(request(`${path}&surge`), environment, context);
	assert.equal(response.status, 200);
	const content = await response.text();
	assert.match(content, /NAS label = trojan,.*ws-path=\/egress=mac\/tunnel/);
	assert.match(content, /Mac label = trojan,.*ws-path="\/egress=nas\/tunnel"/);
});

test('Surge rejects a multi-site conversion that loses its node selectors', async t => {
	t.mock.method(globalThis, 'fetch', async () => new Response(surgeConfiguration([
		surgeNode('Mac'), surgeNode('NAS', ', ws=true, ws-path=/tunnel')
	])));
	const { environment, path } = await subscriptionEnvironment();
	const response = await worker.fetch(request(`${path}&target=surge`), environment, context);
	assert.equal(response.status, 403);
	const content = await response.text();
	assert.match(content, /丢失出口站点选择器/);
	assert.doesNotMatch(content, /ws-path=\/egress=mac/);
});

test('Surge rejects selectors outside the currently enabled site list', async t => {
	t.mock.method(globalThis, 'fetch', async () => new Response(surgeConfiguration([
		surgeNode('Old site', ', ws=true, ws-path=/egress=retired/tunnel')
	])));
	const { environment, path } = await subscriptionEnvironment();
	const response = await worker.fetch(request(`${path}&surge`), environment, context);
	assert.equal(response.status, 403);
	assert.match(await response.text(), /未启用的出口站点: retired/);
});

test('Surge rejects an existing WebSocket path without a selector in a multi-site subscription', async t => {
	t.mock.method(globalThis, 'fetch', async () => new Response(surgeConfiguration([
		surgeNode('Mac', ', ws=true, ws-path=/egress=mac/tunnel'),
		surgeNode('NAS', ', ws=true, ws-path=/tunnel')
	])));
	const { environment, path } = await subscriptionEnvironment();
	const response = await worker.fetch(request(`${path}&surge`), environment, context);
	assert.equal(response.status, 403);
	assert.match(await response.text(), /丢失出口站点选择器/);
});

test('Surge can restore a selector on an existing path when only one site is available', async t => {
	t.mock.method(globalThis, 'fetch', async () => new Response(surgeConfiguration([
		surgeNode('Node', ', ws=false, ws-path=/tunnel')
	])));
	const { environment, path } = await subscriptionEnvironment();
	environment.EGRESS_SITES = JSON.stringify(JSON.parse(environment.EGRESS_SITES).filter(site => site.id === 'nas'));
	environment.DEFAULT_EGRESS = 'nas';
	const response = await worker.fetch(request(`${path}&surge`), environment, context);
	assert.equal(response.status, 200);
	const content = await response.text();
	assert.match(content, /ws=true, ws-path=\/egress=nas\/tunnel/);
	assert.doesNotMatch(content, /\/egress=mac/);
});
