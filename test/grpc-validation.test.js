import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, webcrypto } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
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
globalThis.fetch = async () => assert.fail('gRPC validation must not contact external services');
const { default: worker } = await import('../_worker.js');
const uuid = '90cd4a77-141a-43c9-991b-08263cfe9c10';
const maxFrameBytes = 1024 * 1024;

function header(length, compression = 0) {
	const bytes = Buffer.alloc(5);
	bytes[0] = compression;
	bytes.writeUInt32BE(length, 1);
	return bytes;
}

function field(data) {
	const length = [];
	for (let n = data.length; ; n >>>= 7) {
		length.push((n & 127) | (n > 127 ? 128 : 0));
		if (n <= 127) break;
	}
	return Buffer.concat([Buffer.from([10, ...length]), data]);
}

function frame(...data) {
	const protobuf = Buffer.concat(data.map(field));
	return Buffer.concat([header(protobuf.length), protobuf]);
}

function packet(protocol = 'trojan', data = Buffer.from([42])) {
	const host = Buffer.from('example.com');
	if (protocol === 'vless') return Buffer.concat([
		Buffer.from([0]), Buffer.from(uuid.replaceAll('-', ''), 'hex'),
		Buffer.from([0, 1, 1, 187, 2, host.length]), host, data
	]);
	return Buffer.concat([
		Buffer.from(createHash('sha224').update(uuid).digest('hex')),
		Buffer.from([13, 10, protocol === 'udp' ? 3 : 1, 3, host.length]), host,
		Buffer.from([1, 187, 13, 10]), data
	]);
}

function fixture(chunks, { end = false } = {}) {
	const abort = new AbortController();
	const state = { calls: [], writes: [], bodyCanceled: false, socketClosed: false };
	let bodyController, readableController, resolveClosed;
	const socket = {
		opened: Promise.resolve({}),
		closed: new Promise(resolve => { resolveClosed = resolve; }),
		readable: new ReadableStream({ start(controller) { readableController = controller; } }),
		writable: new WritableStream({ write(data) { state.writes.push(Buffer.from(data)); } }),
		close() {
			state.socketClosed = true;
			try { readableController.close(); } catch { }
			resolveClosed();
		}
	};
	const request = {
		url: 'https://grpc.example.test/tunnel', method: 'POST', signal: abort.signal,
		headers: new Headers({ 'content-type': 'application/grpc' }),
		body: new ReadableStream({
			start(controller) {
				bodyController = controller;
				for (const chunk of chunks) controller.enqueue(chunk);
				if (end) controller.close();
			},
			cancel() { state.bodyCanceled = true; }
		}),
		cf: { colo: 'TPE', asn: 0, country: 'TW' },
		fetcher: { connect() { assert.fail('public fallback must not be used'); } }
	};
	const env = {
		ADMIN: 'grpc-test-admin', KEY: 'grpc-test-key', UUID: uuid,
		HOME_EGRESS: '192.168.50.2:19090',
		HOME_NET: { connect(address) { state.calls.push(address); return socket; } }
	};
	return {
		state, abort, bodyController,
		fetch: () => worker.fetch(request, env, {}),
		async close(response) {
			abort.abort();
			await response.body.cancel().catch(() => {});
		}
	};
}

async function waitFor(predicate) {
	for (let i = 0; i < 100; i++) {
		if (predicate()) return;
		await nextTurn();
	}
	assert.ok(predicate(), 'expected gRPC state was not reached');
}

async function rejectBeforeDial(chunks, options) {
	const f = fixture(chunks, options);
	const response = await f.fetch();
	try {
		assert.equal(response.headers.get('content-type'), 'application/grpc');
		assert.equal(await response.text(), '');
		assert.deepEqual(f.state.calls, []);
		if (!options?.end) assert.equal(f.state.bodyCanceled, true);
	} finally {
		f.abort.abort();
	}
}

if (process.env.EDGETUNNEL_GRPC_VALIDATION_CHILD === '1') {
	// A synchronous parser regression must be killable without hanging node --test.
	for (const length of [0x80000000, 0xfffffffa, 0xfffffffb, 0xfffffffc, 0xffffffff, maxFrameBytes + 1]) {
		await rejectBeforeDial([header(length)]);
	}
	process.stdout.write('unsigned lengths rejected\n');
} else {
	test('unsigned high-bit lengths and oversized frames terminate in an isolated worker', () => {
		const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
			env: { ...process.env, EDGETUNNEL_GRPC_VALIDATION_CHILD: '1' },
			timeout: 3000, encoding: 'utf8'
		});
		assert.ifError(result.error);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /unsigned lengths rejected/);
	});

	for (const compression of [1, 2, 255]) {
		test(`compression flag ${compression} is rejected before reading its body`, { timeout: 3000 }, async () => {
			await rejectBeforeDial([header(10, compression)]);
		});
	}

	for (const [name, protobuf] of [
		['missing length', [10]],
		['unfinished varint', [10, 128]],
		['uint32 overflow', [10, 255, 255, 255, 255, 16]],
		['six-byte varint', [10, 128, 128, 128, 128, 128, 0]],
		['length beyond frame', [10, 2, 42]],
		['unsupported protobuf field', [18, 1, 42]],
		['trailing malformed field', [10, 1, 42, 10]]
	]) {
		test(`protobuf ${name} closes without forwarding`, { timeout: 3000 }, async () => {
			await rejectBeforeDial([header(protobuf.length), Buffer.from(protobuf)]);
		});
	}

	for (const [name, chunks] of [
		['header', [header(20).subarray(0, 4)]],
		['body', [header(20), Buffer.from([10, 18, 42])]]
	]) {
		test(`EOF during a gRPC ${name} closes the response`, { timeout: 3000 }, async () => {
			await rejectBeforeDial(chunks, { end: true });
		});
	}

	for (const protocol of ['trojan', 'vless', 'udp']) {
		test(`${protocol} preserves fragmented HTTP input and multiple gRPC frames`, { timeout: 3000 }, async () => {
			const udpPacket = data => Buffer.concat([Buffer.from([1, 8, 8, 8, 8, 0, 53, 0, data.length, 13, 10]), data]);
			const firstData = protocol === 'udp'
				? udpPacket(Buffer.from([42])) : Buffer.from([42]);
			const firstPacket = packet(protocol, firstData);
			const second = protocol === 'udp' ? udpPacket(Buffer.from([43, 44, 45])) : Buffer.from([43, 44, 45]); // TCP protobuf body is exactly five bytes.
			const third = protocol === 'udp' ? udpPacket(Buffer.from([46, 47])) : Buffer.from([46, 47]);
			const input = Buffer.concat([
				header(0), frame(Buffer.alloc(0)), frame(firstPacket),
				frame(second), header(0), frame(third.subarray(0, 1), third.subarray(1))
			]);
			const f = fixture([...input].map(byte => Buffer.from([byte])));
			const response = await f.fetch();
			try {
				if (protocol === 'vless') {
					const reader = response.body.getReader();
					assert.deepEqual(Buffer.from((await reader.read()).value), frame(Buffer.from([0, 0])));
					reader.releaseLock();
				}
				await waitFor(() => f.state.writes.length === 3);
				assert.deepEqual(f.state.calls, [{ hostname: '192.168.50.2', port: 19090 }]);
				assert.deepEqual(f.state.writes, [protocol === 'vless' ? packet('trojan', firstData) : firstPacket, second, third]);
				assert.equal(f.state.bodyCanceled, false);
			} finally {
				await f.close(response);
			}
			assert.equal(f.state.socketClosed, true);
		});
	}

	test('the 1 MiB cap applies per frame and accepts its exact boundary', { timeout: 3000 }, async () => {
		const first = packet();
		const large = Buffer.alloc(maxFrameBytes - 4, 90); // tag + three-byte length
		const following = Buffer.alloc(64 * 1024, 91);
		assert.equal(frame(large).length - 5, maxFrameBytes);
		const f = fixture([Buffer.concat([frame(first), frame(large), frame(following)])]);
		const response = await f.fetch();
		try {
			await waitFor(() => f.state.writes.length === 3);
			assert.deepEqual(f.state.writes, [first, large, following]);
			assert.equal(f.state.calls.length, 1);
		} finally {
			await f.close(response);
		}
	});

	test('a malformed frame after authentication closes the relay without forwarding it', { timeout: 3000 }, async () => {
		const first = packet();
		const f = fixture([frame(first)]);
		const response = await f.fetch();
		try {
			await waitFor(() => f.state.writes.length === 1);
			f.bodyController.enqueue(Buffer.concat([header(3), Buffer.from([10, 2, 42])]));
			assert.equal(await response.text(), '');
			assert.deepEqual(f.state.writes, [first]);
			assert.equal(f.state.bodyCanceled, true);
			assert.equal(f.state.socketClosed, true);
		} finally {
			f.abort.abort();
		}
	});
}
