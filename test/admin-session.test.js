import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import test from 'node:test';

Object.defineProperty(globalThis, 'crypto', {
	configurable: true,
	value: {
		getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
		subtle: { async digest(algorithm, data) {
			return String(algorithm).toUpperCase() === 'MD5'
				? createHash('md5').update(Buffer.from(data)).digest()
				: webcrypto.subtle.digest(algorithm, data);
		} }
	}
});
const { default: worker } = await import('../_worker.js');
const origin = 'https://worker.example.test';
const context = { waitUntil() {} };

function request(path, { method = 'GET', body, cookie, source = origin, headers = {} } = {}) {
	const values = new Headers({ 'User-Agent': 'session-test', ...headers });
	if (cookie) values.set('Cookie', cookie);
	if (method === 'POST' && source !== undefined && source !== false) values.set('Origin', source);
	const result = new Request(origin + path, { method, body, headers: values });
	Object.defineProperty(result, 'cf', { value: { colo: 'TPE', asn: 0, country: 'TW' } });
	return result;
}
function environment() {
	const entries = new Map(), writes = [], deletes = [];
	return {
		ADMIN: 'test-admin', KEY: 'test-key', UUID: '90cd4a77-141a-43c9-991b-08263cfe9c10', OFF_LOG: 'true',
		KV: {
			entries, writes, deletes,
			async get(key) { return entries.get(key) ?? null; },
			async put(key, value, options) { entries.set(key, value); writes.push({ key, value, options }); },
			async delete(key) { entries.delete(key); deletes.push(key); }
		}
	};
}
async function login(env, cookie) {
	const response = await worker.fetch(request('/login', { method: 'POST', body: 'password=test-admin', cookie }), env, context);
	assert.equal(response.status, 200);
	assert.equal((await response.json()).success, true);
	return response.headers.get('set-cookie').split(';')[0];
}
async function readConfig(env, cookie, options) {
	return worker.fetch(request('/admin/config.json', { cookie, ...options }), env, context);
}

test.beforeEach(t => {
	t.mock.method(globalThis, 'fetch', async () => assert.fail('admin session checks must not contact external services'));
});

test('login uses independent random sessions with server expiration and protected cookies', async () => {
	const env = environment();
	const response = await worker.fetch(request('/login', { method: 'POST', body: 'password=test-admin' }), env, context);
	assert.equal(response.status, 200);
	const header = response.headers.get('set-cookie');
	assert.match(header, /^auth=[a-f0-9]{64}; Path=\/; Max-Age=86400; HttpOnly; Secure; SameSite=Lax$/);
	assert.equal(response.headers.get('cache-control'), 'no-store');
	const first = header.split(';')[0], second = await login(env);
	assert.notEqual(first, second);
	assert.equal((await readConfig(env, first)).status, 200);
	assert.equal((await readConfig(env, second)).status, 200);
	for (const write of env.KV.writes) {
		assert.match(write.key, /^admin-session:[a-f0-9]{64}$/);
		assert.deepEqual(write.options, { expirationTtl: 86400 });
		assert.equal(JSON.parse(write.value).expiresAt - JSON.parse(write.value).createdAt, 86400000);
		assert.ok(!write.key.includes(first.slice(5)));
		assert.doesNotMatch(write.value, /test-admin|test-key/);
	}
});

test('legacy deterministic cookies and fabricated sessions cannot authenticate', async () => {
	const env = environment();
	const md5 = value => createHash('md5').update(value).digest('hex');
	const legacy = md5(md5('session-testtest-keytest-admin').slice(7,27));
	for (const cookie of [`auth=${legacy}`, `auth=${'f'.repeat(64)}`, 'auth=undefined']) {
		const response = await readConfig(env, cookie);
		assert.equal(response.status, 302);
		assert.equal(response.headers.get('location'), '/login');
	}
	assert.equal(env.KV.writes.length, 0);
});

test('expiry is enforced even when KV still returns an expired record', async t => {
	const env = environment(), cookie = await login(env);
	const session = JSON.parse(env.KV.writes[0].value);
	t.mock.method(Date, 'now', () => session.expiresAt);
	assert.equal((await readConfig(env, cookie)).status, 302);
});

test('changing ADMIN, KEY, origin or user agent invalidates the session', async () => {
	const env = environment(), cookie = await login(env);
	for (const changed of [{ ...env, ADMIN: 'rotated-admin' }, { ...env, KEY: 'rotated-key' }]) {
		assert.equal((await readConfig(changed, cookie)).status, 302);
	}
	assert.equal((await readConfig(env, cookie, { headers: { 'User-Agent': 'another-browser' } })).status, 302);
	const anotherHost = request('/admin/config.json', { cookie });
	const changedRequest = new Request('https://another.example.test/admin/config.json', anotherHost);
	Object.defineProperty(changedRequest, 'cf', { value: anotherHost.cf });
	assert.equal((await worker.fetch(changedRequest, env, context)).status, 302);
});

test('re-authentication rotates the cookie and invalidates the previous session', async () => {
	const env = environment(), first = await login(env), second = await login(env, first);
	assert.notEqual(first, second);
	assert.equal(env.KV.deletes.length, 1);
	assert.equal((await readConfig(env, first)).status, 302);
	assert.equal((await readConfig(env, second)).status, 200);
});

test('logout revokes the server session before returning success; replay is denied', async () => {
	const env = environment(), cookie = await login(env);
	const response = await worker.fetch(request('/logout', { method: 'POST', cookie, headers: { Accept: 'application/json' } }), env, context);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { success: true });
	assert.match(response.headers.get('set-cookie'), /auth=; Path=\/; Max-Age=0; HttpOnly; Secure; SameSite=Lax/);
	assert.equal(env.KV.deletes.length, 1);
	assert.equal((await readConfig(env, cookie)).status, 302);
});

test('form logout redirects only after revocation, while GET logout and UUID navigation never revoke', async () => {
	const env = environment(), cookie = await login(env);
	const get = await worker.fetch(request('/logout', { cookie }), env, context);
	assert.equal(get.status, 200);
	assert.match(await get.text(), /method="post"/i);
	assert.equal(get.headers.get('set-cookie'), null);
	const uuid = await worker.fetch(request('/' + env.UUID, { cookie }), env, context);
	assert.equal(uuid.status, 302);
	assert.equal(uuid.headers.get('set-cookie'), null);
	assert.equal(env.KV.deletes.length, 0);
	assert.equal((await readConfig(env, cookie)).status, 200);
	const post = await worker.fetch(request('/logout', { cookie, method: 'POST' }), env, context);
	assert.equal(post.status, 303);
	assert.equal(post.headers.get('location'), '/login');
	assert.equal((await readConfig(env, cookie)).status, 302);
});

test('all management POST paths require an exact same-origin source before any write', async () => {
	const env = environment(), cookie = await login(env);
	const before = [...env.KV.entries], writeCount = env.KV.writes.length;
	for (const path of ['/login', '/admin', '/admin/init', '/admin/config.json', '/admin/cf.json', '/admin/tg.json', '/admin/ADD.txt', '/admin/egress', '/logout']) {
		for (const source of [false, 'null', 'https://attacker.example', origin + '.attacker.example']) {
			const response = await worker.fetch(request(path, { method: 'POST', cookie, source, body: 'password=test-admin' }), env, context);
			assert.equal(response.status, 403, `${path}: ${source}`);
		}
	}
	assert.equal(env.KV.writes.length, writeCount);
	assert.deepEqual([...env.KV.entries], before);
	assert.equal(env.KV.deletes.length, 0);
});

test('GET and HEAD cannot reset or initialize administrative configuration', async () => {
	const env = environment(), cookie = await login(env);
	const before = [...env.KV.entries], writeCount = env.KV.writes.length;
	for (const method of ['GET', 'HEAD']) {
		assert.equal((await worker.fetch(request('/admin/init', { method, cookie }), env, context)).status, 405);
		assert.equal((await readConfig(env, cookie, { method })).status, 200);
	}
	assert.deepEqual([...env.KV.entries], before);
	assert.equal(env.KV.writes.length, writeCount);
});

test('same-origin reset and configuration save remain functional', async () => {
	const env = environment(), cookie = await login(env);
	const config = await (await readConfig(env, cookie)).json();
	config.PATH = '/custom-path';
	const save = await worker.fetch(request('/admin/config.json', { cookie, method: 'POST', body: JSON.stringify(config), headers: { 'Content-Type': 'application/json' } }), env, context);
	assert.equal(save.status, 200);
	assert.equal(JSON.parse(env.KV.entries.get('config.json')).PATH, '/custom-path');
	const reset = await worker.fetch(request('/admin/init', { cookie, method: 'POST' }), env, context);
	assert.equal(reset.status, 200);
	assert.equal(JSON.parse(env.KV.entries.get('config.json')).PATH, '/');
});

test('KV read/write/delete failures cannot authenticate or claim a successful logout/reset', async t => {
	const env = environment(), cookie = await login(env);
	const originalGet = env.KV.get;
	env.KV.get = async () => { throw new Error('test read outage'); };
	assert.equal((await readConfig(env, cookie)).status, 503);
	env.KV.get = originalGet;
	env.KV.delete = async () => { throw new Error('test delete outage'); };
	assert.equal((await worker.fetch(request('/logout', { method: 'POST', cookie }), env, context)).status, 503);
	assert.equal((await readConfig(env, cookie)).status, 200);
	env.KV.put = async () => { throw new Error('test write outage'); };
	assert.equal((await worker.fetch(request('/login', { method: 'POST', body: 'password=test-admin' }), env, context)).status, 503);
	assert.equal((await worker.fetch(request('/admin/init', { method: 'POST', cookie }), env, context)).status, 500);
});

test('logout still revokes a cookie after the browser user agent has changed', async () => {
	const env = environment(), cookie = await login(env);
	const response = await worker.fetch(request('/logout', {
		method: 'POST', cookie, headers: { Accept: 'application/json', 'User-Agent': 'updated-browser' }
	}), env, context);
	assert.equal(response.status, 200);
	assert.equal(env.KV.deletes.length, 1);
	assert.equal((await readConfig(env, cookie)).status, 302);
});
