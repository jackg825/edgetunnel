import assert from 'node:assert/strict';
import { createHash, randomUUID, webcrypto } from 'node:crypto';
import test from 'node:test';

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
const password = '90cd4a77-141a-43c9-991b-08263cfe9c10';

function trojanPacket({ command = 1, hostname = 'example.com', port = 443, payload = new Uint8Array([1, 2, 3]) } = {}) {
	const auth = Buffer.from(createHash('sha224').update(password).digest('hex'));
	const host = Buffer.from(hostname);
	return Uint8Array.from(Buffer.concat([
		auth,
		Buffer.from([0x0d, 0x0a, command, 3, host.length]),
		host,
		Buffer.from([port >>> 8, port & 0xff, 0x0d, 0x0a]),
		Buffer.from(payload)
	]));
}

function vlessPacket({ hostname = 'example.com', port = 443, payload = new Uint8Array([1, 2, 3]) } = {}) {
	const uuid = Buffer.from(password.replaceAll('-', ''), 'hex');
	const host = Buffer.from(hostname);
	return Uint8Array.from(Buffer.concat([
		Buffer.from([0]),
		uuid,
		Buffer.from([0, 1, port >>> 8, port & 0xff, 2, host.length]),
		host,
		Buffer.from(payload)
	]));
}

function fakeSocket(writes) {
	let closeSocket;
	const closed = new Promise(resolve => { closeSocket = resolve });
	return {
		opened: Promise.resolve({}),
		closed,
		readable: new ReadableStream({ start() { } }),
		writable: new WritableStream({
			write(chunk) { writes.push(Uint8Array.from(chunk)) }
		}),
		close() { closeSocket() }
	};
}

function requestWithBody(body, publicConnect) {
	return {
		url: 'https://home-egress.example.test/tunnel',
		method: 'POST',
		headers: new Headers({ 'content-type': 'application/octet-stream', 'user-agent': 'node-test' }),
		body: new ReadableStream({
			start(controller) {
				controller.enqueue(body);
				controller.close();
			}
		}),
		cf: { colo: 'TPE', asn: 0, asOrganization: 'test', country: 'TW', city: 'Taipei' },
		fetcher: { connect: publicConnect }
	};
}

function homeEnvironment(connect) {
	return {
		ADMIN: 'test-admin',
		KEY: 'test-key',
		UUID: password,
		HOME_EGRESS: '192.168.50.2:19090',
		HOME_NET: { connect }
	};
}

async function waitFor(predicate, message) {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	assert.fail(message);
}

test('forces Trojan TCP through HOME_NET without public fallback', async () => {
	const calls = [], writes = [];
	let publicCalls = 0;
	const packet = trojanPacket();
	const response = await worker.fetch(
		requestWithBody(packet, () => { publicCalls++; throw new Error('public fallback used') }),
		homeEnvironment(address => {
			calls.push(address);
			return fakeSocket(writes);
		}),
		{ waitUntil() { } }
	);

	await waitFor(() => calls.length === 1 && writes.length === 1, 'HOME_NET was not used');
	assert.deepEqual(calls, [{ hostname: '192.168.50.2', port: 19090 }]);
	assert.deepEqual(writes[0], packet);
	assert.equal(publicCalls, 0);
	await response.body.cancel();
});

test('forwards Trojan UDP frames through HOME_NET', async () => {
	const calls = [], writes = [];
	let publicCalls = 0;
	const packet = trojanPacket({ command: 3, port: 53, payload: new Uint8Array([0, 1, 0]) });
	const response = await worker.fetch(
		requestWithBody(packet, () => { publicCalls++; throw new Error('public fallback used') }),
		homeEnvironment(address => {
			calls.push(address);
			return fakeSocket(writes);
		}),
		{ waitUntil() { } }
	);

	await waitFor(() => calls.length === 1 && writes.length === 1, 'UDP was not routed through HOME_NET');
	assert.deepEqual(writes[0], packet);
	assert.equal(publicCalls, 0);
	await response.body.cancel();
});

test('fails closed when the Mac relay is unavailable', async () => {
	let homeCalls = 0, publicCalls = 0;
	const response = await worker.fetch(
		requestWithBody(trojanPacket(), () => { publicCalls++; throw new Error('public fallback used') }),
		homeEnvironment(() => { homeCalls++; throw new Error('Mac relay unavailable') }),
		{ waitUntil() { } }
	);

	await waitFor(() => homeCalls === 1, 'HOME_NET connection was not attempted');
	assert.equal(publicCalls, 0);
	await response.body.cancel();
});

test('translates VLESS TCP to Trojan through HOME_NET', async () => {
	const calls = [], writes = [];
	let publicCalls = 0;
	const payload = new Uint8Array([9, 8, 7]);
	const response = await worker.fetch(
		requestWithBody(vlessPacket({ payload }), () => { publicCalls++; throw new Error('public fallback used') }),
		homeEnvironment(address => {
			calls.push(address);
			return fakeSocket(writes);
		}),
		{ waitUntil() { } }
	);

	await waitFor(() => calls.length === 1 && writes.length === 1, 'VLESS was not routed through HOME_NET');
	assert.equal(response.status, 200);
	assert.deepEqual(calls, [{ hostname: '192.168.50.2', port: 19090 }]);
	assert.deepEqual(writes[0], trojanPacket({ payload }));
	assert.equal(publicCalls, 0);
	await response.body.cancel();
});
