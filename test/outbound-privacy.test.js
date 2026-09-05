import assert from 'node:assert/strict';
import { createHash, randomUUID, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

Object.defineProperty(globalThis, 'crypto', {
	configurable: true,
	value: {
		getRandomValues: webcrypto.getRandomValues.bind(webcrypto), randomUUID,
		subtle: new Proxy(webcrypto.subtle, {
			get(target, property) {
				if (property === 'digest') return async (algorithm, data) => String(algorithm).toUpperCase() === 'MD5'
					? createHash('md5').update(Buffer.from(data)).digest()
					: target.digest(algorithm, data);
				const value = Reflect.get(target, property, target);
				return typeof value === 'function' ? value.bind(target) : value;
			}
		})
	}
});

const { default: worker } = await import('../_worker.js');
const source = await readFile(new URL('../_worker.js', import.meta.url), 'utf8');
// Exercise the private logger with URLs that normal routing may reject before
// logging, without exposing a production-only export or duplicating its code.
const loggerSource = source.slice(source.indexOf('function 获取日志URL摘要('), source.indexOf('function 掩码敏感信息('));
const workerOrigin = 'https://worker.example.test';
const coverOrigin = 'https://cover.example.test';
const publicUUID = '90cd4a77-141a-43c9-991b-08263cfe9c10';
const environment = { ADMIN: 'test-admin', KEY: 'test-key', UUID: publicUUID, URL: coverOrigin };
const context = { waitUntil() { } };

function request(pathname, init = {}) {
	const result = new Request(workerOrigin + pathname, init);
	Object.defineProperty(result, 'cf', { value: { colo: 'TPE', country: 'TW', asn: 0 } });
	return result;
}

test('camouflage forwards public request semantics without credentials or private headers', async t => {
	const original = request('/article?language=en', { headers: {
		Cookie: 'auth=cookie-secret', Authorization: 'Bearer bearer-secret',
		'Proxy-Authorization': 'Basic proxy-secret', 'X-API-Key': 'application-secret',
		Referer: workerOrigin + '/sub?token=referer-secret', Origin: workerOrigin,
		Accept: 'text/html', 'Accept-Language': 'en', Range: 'bytes=0-99', 'User-Agent': 'TestBrowser'
	} });
	let calls = 0;
	t.mock.method(globalThis, 'fetch', async (url, init) => {
		calls++;
		assert.equal(url, coverOrigin + '/article?language=en');
		assert.equal(init.method, 'GET');
		assert.equal(init.redirect, 'manual');
		const forwarded = new Headers(init.headers);
		for (const name of ['Cookie', 'Authorization', 'Proxy-Authorization', 'X-API-Key']) assert.equal(forwarded.get(name), null);
		assert.equal(forwarded.get('Referer'), coverOrigin);
		assert.equal(forwarded.get('Origin'), coverOrigin);
		for (const name of ['Accept', 'Accept-Language', 'Range', 'User-Agent']) assert.equal(forwarded.get(name), original.headers.get(name));
		return new Response('Links on cover.example.test', { headers: { 'Content-Type': 'text/html', 'Set-Cookie': 'auth=upstream-value; Path=/', 'X-Public': 'kept' } });
	});
	const response = await worker.fetch(original, environment, context);
	assert.equal(calls, 1);
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('Set-Cookie'), null);
	assert.equal(response.headers.get('X-Public'), 'kept');
	assert.equal(await response.text(), 'Links on worker.example.test');
	assert.equal(original.headers.get('Cookie'), 'auth=cookie-secret');
});

test('camouflage strips cookies from binary responses and preserves their bytes and status', async t => {
	const bytes = Uint8Array.of(0, 255, 1, 2);
	t.mock.method(globalThis, 'fetch', async () => {
		const headers = new Headers({ 'Content-Type': 'image/png', 'Content-Range': 'bytes 0-3/10', 'Set-Cookie2': 'obsolete=secret' });
		headers.append('Set-Cookie', 'auth=one');
		headers.append('Set-Cookie', 'session=two');
		return new Response(bytes, { status: 206, headers });
	});
	const response = await worker.fetch(request('/image.png'), environment, context);
	assert.equal(response.status, 206);
	assert.equal(response.headers.get('Content-Range'), 'bytes 0-3/10');
	assert.equal(response.headers.get('Set-Cookie'), null);
	assert.equal(response.headers.get('Set-Cookie2'), null);
	assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
});

for (const destination of [coverOrigin + '/next?public=1', 'https://other.example.test/next']) {
	test(`camouflage returns a sanitized redirect without following ${new URL(destination).hostname}`, async t => {
		let calls = 0;
		t.mock.method(globalThis, 'fetch', async (_url, init) => {
			calls++;
			assert.equal(init.redirect, 'manual');
			assert.equal(new Headers(init.headers).get('Cookie'), null);
			return new Response(null, { status: 302, headers: { Location: destination, 'Set-Cookie': 'auth=redirect-secret' } });
		});
		const response = await worker.fetch(request('/redirect', { headers: { Cookie: 'auth=client-secret' } }), environment, context);
		assert.equal(calls, 1);
		assert.equal(response.status, 302);
		assert.equal(response.headers.get('Location'), destination.replace(coverOrigin, workerOrigin));
		assert.equal(response.headers.get('Set-Cookie'), null);
		assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
	});
}

test('camouflage preserves a bodyless conditional response while stripping its cookies', async t => {
	t.mock.method(globalThis, 'fetch', async (_url, init) => {
		assert.equal(init.method, 'HEAD');
		assert.equal(new Headers(init.headers).get('If-None-Match'), 'public-etag');
		return new Response(null, { status: 304, headers: { 'Content-Type': 'text/html', ETag: 'public-etag', 'Set-Cookie': 'auth=secret' } });
	});
	const response = await worker.fetch(request('/article', { method: 'HEAD', headers: { 'If-None-Match': 'public-etag' } }), environment, context);
	assert.equal(response.status, 304);
	assert.equal(response.body, null);
	assert.equal(response.headers.get('Set-Cookie'), null);
});

function loggingFixture(existing = [], offLog) {
	const calls = { fetch: [], get: [], put: [], errors: [] };
	const entries = new Map([['tg.json', JSON.stringify({ BotToken: 'test-bot', ChatID: 'test-chat' })], ['log.json', JSON.stringify(existing)]]);
	const env = { OFF_LOG: offLog, KV: {
		async get(key) { calls.get.push(key); return entries.get(key) ?? null; },
		async put(key, value) { calls.put.push({ key, value }); entries.set(key, value); }
	} };
	const config = { TG: { 启用: true }, 优选订阅生成: { SUBNAME: 'test-subscription' }, CF: { Usage: { success: false } } };
	const log = runInNewContext(loggerSource + '\n请求日志记录', {
		URL, Date, console: { error: message => calls.errors.push(message) },
		fetch: async (url, init) => { calls.fetch.push({ url, init }); return new Response('ok'); }
	});
	return { calls, entries, env, config, log };
}

test('Telegram and KV receive only the origin for credential-bearing and historical URLs', async () => {
	const secrets = ['subscription-secret', publicUUID, 'proxy-user', 'proxy-password', 'nested-secret', 'fragment-secret'];
	const urls = [
		workerOrigin + '/sub?token=subscription-secret&url=' + encodeURIComponent('https://proxy-user:proxy-password@nested.example.test/' + publicUUID + '?token=nested-secret'),
		workerOrigin + '/' + publicUUID + '/socks5://proxy-user:proxy-password@proxy.example.test?url=' + encodeURIComponent(encodeURIComponent('https://nested.example.test/sub?token=nested-secret')),
		'https://proxy-user:proxy-password@worker.example.test/secret-path?token=subscription-secret#fragment-secret'
	];
	const { calls, entries, env, config, log } = loggingFixture(urls.map(URL => ({ TYPE: 'Get_SUB', URL, TIME: 0 })));
	for (const url of urls) await log(env, { ...request('/'), url, headers: new Headers({ 'User-Agent': 'TestClient' }), cf: { asn: 0 } }, '192.0.2.1', 'Get_SUB', config);
	assert.equal(calls.fetch.length, urls.length);
	assert.equal(calls.put.length, urls.length);
	const stored = JSON.parse(entries.get('log.json'));
	assert.ok(stored.every(record => record.URL === workerOrigin + '/'));
	for (const secret of secrets) {
		assert.ok(!JSON.stringify(calls.put).includes(secret));
		assert.ok(!calls.fetch.some(call => decodeURIComponent(call.url).includes(secret)));
	}
	assert.ok(calls.fetch.every(call => new URL(call.url).hostname === 'api.telegram.org'));
	assert.ok(calls.fetch.every(call => new URL(call.url).searchParams.get('text').includes('#Get_SUB')));
	assert.equal(calls.errors.length, 0);
});

test('OFF_LOG disables both Telegram and KV before reading notification configuration', async () => {
	for (const offLog of ['true', '1', ' TRUE ', true]) {
		const { calls, env, log } = loggingFixture([], offLog);
		await log(env, request('/sub?token=must-not-leave'), '192.0.2.1', 'Get_SUB', null);
		assert.deepEqual(calls, { fetch: [], get: [], put: [], errors: [] });
	}
});

test('the per-call KV opt-out retains enabled Telegram notifications', async () => {
	const { calls, env, config, log } = loggingFixture([], 'false');
	await log(env, request('/sub?token=secret'), '192.0.2.1', 'Get_Best_SUB', config, false);
	assert.equal(calls.fetch.length, 1);
	assert.deepEqual(calls.get, ['tg.json']);
	assert.equal(calls.put.length, 0);
});

test('log redaction preserves action deduplication and cleans a duplicate historical URL', async () => {
	const previous = { TYPE: 'Admin_Login', IP: '192.0.2.1', URL: workerOrigin + '/admin?token=old-secret', UA: 'TestClient', TIME: Date.now() };
	const { calls, entries, env, config, log } = loggingFixture([previous]);
	config.TG.启用 = false;
	const adminRequest = request('/admin?token=new-secret', { headers: { 'User-Agent': 'TestClient' } });
	await log(env, adminRequest, '192.0.2.1', 'Admin_Login', config);
	assert.equal(calls.put.length, 1);
	assert.equal(JSON.parse(entries.get('log.json')).length, 1);
	assert.ok(!entries.get('log.json').includes('old-secret'));
	await log(env, adminRequest, '192.0.2.1', 'Admin_Login', config);
	assert.equal(calls.put.length, 1);
	await log(env, adminRequest, '192.0.2.1', 'Save_Config', config);
	assert.deepEqual(JSON.parse(entries.get('log.json')).map(record => record.TYPE), ['Admin_Login', 'Save_Config']);
});

test('saved Telegram enablement and OFF_LOG control real subscription logging', async t => {
	const outbound = [];
	t.mock.method(globalThis, 'fetch', async url => {
		assert.equal(new URL(url).hostname, 'api.telegram.org', 'the local subscription must not fetch any other external service');
		outbound.push(String(url));
		return new Response('ok');
	});
	const entries = new Map([['ADD.txt', '104.16.1.1:443#TestNode']]);
	const writes = [];
	const env = { ...environment, OFF_LOG: 'true', KV: {
		async get(key) { return entries.get(key) ?? null; },
		async put(key, value) { writes.push({ key, value }); entries.set(key, value); }
	} };
	const login = await worker.fetch(request('/login', { method: 'POST', body: 'password=test-admin', headers: { Origin: workerOrigin, 'User-Agent': 'TestClient' } }), env, context);
	assert.equal(login.status, 200);
	const cookie = login.headers.get('Set-Cookie').split(';', 1)[0];
	const response = await worker.fetch(request('/admin/config.json', { headers: { Cookie: cookie, 'User-Agent': 'TestClient' } }), env, context);
	assert.equal(response.status, 200);
	const config = await response.json();
	config.TG.启用 = true;
	config.优选订阅生成.本地IP库.随机IP = false;
	entries.set('config.json', JSON.stringify(config));
	entries.set('tg.json', JSON.stringify({ BotToken: 'test-bot', ChatID: 'test-chat' }));
	const token = config.优选订阅生成.TOKEN;
	const pending = [];
	const subscribe = () => worker.fetch(request('/sub?token=' + token + '&note=' + encodeURIComponent('https://nested.example.test/?token=nested-secret'), { headers: { 'User-Agent': 'TestClient' } }), env, { waitUntil(promise) { pending.push(promise); } });
	assert.equal((await subscribe()).status, 200);
	await Promise.all(pending);
	assert.equal(outbound.length, 0);
	assert.equal(writes.filter(write => write.key === 'log.json').length, 0);
	env.OFF_LOG = 'false';
	assert.equal((await subscribe()).status, 200);
	await Promise.all(pending);
	assert.equal(outbound.length, 1);
	assert.equal(writes.filter(write => write.key === 'log.json').length, 1);
	for (const value of [entries.get('log.json'), decodeURIComponent(outbound[0])]) {
		assert.ok(!value.includes(token));
		assert.ok(!value.includes('nested-secret'));
	}
});

test('third-party HTML cannot grant itself script or same-origin privileges', async t => {
	t.mock.method(globalThis, 'fetch', async () => new Response('<script>fetch("/admin/config.json")</script>', {
		headers: {
			'Content-Type': 'text/html',
			'Content-Security-Policy': 'sandbox allow-scripts allow-same-origin',
			'Set-Cookie': 'auth=third-party'
		}
	}));
	const response = await worker.fetch(request('/'), environment, context);
	assert.equal(response.headers.get('Content-Security-Policy'), 'sandbox');
	assert.equal(response.headers.get('Set-Cookie'), null);
	assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
});
