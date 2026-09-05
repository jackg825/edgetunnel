import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';

Object.defineProperty(globalThis, 'crypto', {
	configurable: true,
	value: {
		getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
		subtle: {
			async digest(algorithm, data) {
				return String(algorithm).toUpperCase() === 'MD5'
					? createHash('md5').update(Buffer.from(data)).digest()
					: webcrypto.subtle.digest(algorithm, data);
			}
		}
	}
});

const { default: worker } = await import('../_worker.js');
const uuid = '90cd4a77-141a-43c9-991b-08263cfe9c10';
const relayPassword = 'nas-relay-test-password';
const trojanPacket = Buffer.concat([
	Buffer.from(createHash('sha224').update(uuid).digest('hex')),
	Buffer.from([13, 10, 1, 3, 11]), Buffer.from('example.com'),
	Buffer.from([1, 187, 13, 10, 42])
]);
const vlessPacket = Buffer.concat([
	Buffer.from([0]), Buffer.from(uuid.replaceAll('-', ''), 'hex'),
	Buffer.from([0, 1, 1, 187, 2, 11]), Buffer.from('example.com'), Buffer.from([42])
]);
const padding = 'a'.repeat(200);

for (const scenario of [
	{ name: 'legacy Referer XHTTP', headers: { referer: 'https://transport.example.test/?x_padding=legacy-padding' } },
	{ name: 'legacy Referer VLESS XHTTP', vless: true, headers: { referer: 'https://transport.example.test/?x_padding=legacy-padding' } },
	{ name: 'UUID header XHTTP', headers: { '0cd4a7': `https://transport.example.test/?_8263cf=${padding}` } },
	{ name: 'UUID query XHTTP', query: `?_8263cf=${padding}` },
	{ name: 'ordinary gRPC', grpc: true, headers: { referer: 'https://transport.example.test/client' } }
]) {
	test(`${scenario.name} reaches the selected relay without changing transport framing`, { timeout: 3000 }, async t => {
		t.mock.method(globalThis, 'fetch', async () => assert.fail('transport routing must not fetch external services'));
		const calls = [], writes = [];
		const abort = new AbortController();
		let closeSocket, readableController;
		const closed = new Promise(resolve => { closeSocket = resolve; });
		const socket = {
			opened: Promise.resolve({}), closed,
			readable: new ReadableStream({ start(controller) { readableController = controller; } }),
			writable: new WritableStream({ write(chunk) { writes.push(Buffer.from(chunk)); } }),
			close() {
				try { readableController.close(); } catch { }
				closeSocket();
			}
		};
		let body = scenario.vless ? vlessPacket : trojanPacket;
		if (scenario.grpc) {
			const header = Buffer.alloc(5);
			header.writeUInt32BE(trojanPacket.length + 2, 1);
			body = Buffer.concat([header, Buffer.from([10, trojanPacket.length]), trojanPacket]);
		}
		const request = {
			url: `https://transport.example.test/egress=nas/tunnel${scenario.query || ''}`,
			method: 'POST', signal: abort.signal,
			headers: new Headers({ 'content-type': 'application/grpc', ...scenario.headers }),
			body: new ReadableStream({ start(controller) { controller.enqueue(body); } }),
			cf: { colo: 'TPE', asn: 0, country: 'TW' },
			fetcher: { connect() { assert.fail('public fallback must not be used'); } }
		};
		const environment = {
			ADMIN: 'test-admin', UUID: uuid, DEFAULT_EGRESS: 'mac',
			EGRESS_SITES: JSON.stringify([
				{ id: 'mac', name: 'Mac', binding: 'MAC_NET', address: '127.0.0.1:19090', secret_env: 'MAC_SECRET' },
				{ id: 'nas', name: 'NAS', binding: 'NAS_NET', address: '192.0.2.20:19090', secret_env: 'NAS_SECRET' }
			]),
			MAC_SECRET: 'mac-relay-test-password', NAS_SECRET: relayPassword,
			MAC_NET: { connect() { assert.fail('default relay must not be used'); } },
			NAS_NET: { connect(address) { calls.push(address); return socket; } }
		};
		const response = await worker.fetch(request, environment, {});
		try {
			assert.equal(response.status, 200);
			assert.equal(response.headers.get('content-type'), scenario.grpc ? 'application/grpc' : 'application/octet-stream');
			for (let attempt = 0; writes.length === 0 && attempt < 100; attempt++) await nextTurn();
			assert.deepEqual(calls, [{ hostname: '192.0.2.20', port: 19090 }]);
			assert.equal(writes.length, 1);
			assert.equal(writes[0].subarray(0, 56).toString(), createHash('sha224').update(relayPassword).digest('hex'));
			assert.deepEqual(writes[0].subarray(56), trojanPacket.subarray(56));
		} finally {
			abort.abort();
			await response.body.cancel().catch(error => assert.equal(error, abort.signal.reason));
		}
	});
}
