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

class MemoryWebSocket extends EventTarget {
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	readyState = 1;
	received = [];
	accept() { }
	send(data) {
		assert.equal(this.readyState, 1);
		this.peer.received.push(Uint8Array.from(data));
		this.peer.dispatchEvent(Object.assign(new Event('message'), { data }));
	}
	close() {
		if (this.readyState === 3) return;
		this.readyState = 3;
		this.peer.readyState = 3;
		this.dispatchEvent(new Event('close'));
		this.peer.dispatchEvent(new Event('close'));
	}
}
globalThis.WebSocket = MemoryWebSocket;
globalThis.WebSocketPair = class {
	constructor() {
		this[0] = new MemoryWebSocket();
		this[1] = new MemoryWebSocket();
		this[0].peer = this[1];
		this[1].peer = this[0];
	}
};
const NativeResponse = globalThis.Response;
globalThis.Response = class extends NativeResponse {
	constructor(body, options) {
		super(body, options?.status === 101 ? { ...options, status: 200 } : options);
		if (options?.status === 101) {
			Object.defineProperty(this, 'status', { value: 101 });
			this.webSocket = options.webSocket;
		}
	}
};

const { default: worker } = await import('../_worker.js');
const uuid = '90cd4a77-141a-43c9-991b-08263cfe9c10';
const payload = Buffer.from('GET / HTTP/1.0\r\n\r\n');

function deferred() {
	let resolve;
	const promise = new Promise(r => { resolve = r; });
	return { promise, resolve };
}

function packet(protocol = 'trojan', hostname = 'example.com') {
	const host = Buffer.from(hostname);
	if (protocol === 'vless') return Buffer.concat([
		Buffer.from([0]), Buffer.from(uuid.replaceAll('-', ''), 'hex'),
		Buffer.from([0, 1, 1, 187, 2, host.length]), host, payload
	]);
	return Buffer.concat([
		Buffer.from(createHash('sha224').update(uuid).digest('hex')),
		Buffer.from([13, 10, 1, 3, host.length]), host,
		Buffer.from([1, 187, 13, 10]), payload
	]);
}

function grpcFrame(data) {
	const length = [];
	for (let n = data.length; ; n >>>= 7) {
		length.push((n & 127) | (n > 127 ? 128 : 0));
		if (n <= 127) break;
	}
	const protobuf = Buffer.concat([Buffer.from([10, ...length]), data]);
	const header = Buffer.alloc(5);
	header.writeUInt32BE(protobuf.length, 1);
	return Buffer.concat([header, protobuf]);
}

function memorySocket({ opened = Promise.resolve({}), write = null, chunks = 0 } = {}) {
	const closed = deferred();
	let readableController;
	const state = { writes: [], pulls: 0, closes: 0, writeCloses: 0 };
	const socket = {
		state, opened, closed: closed.promise,
		readable: new ReadableStream({
			start(controller) { readableController = controller; },
			pull(controller) {
				if (!chunks) return;
				if (state.pulls === chunks) return controller.close();
				controller.enqueue(new Uint8Array(65_536).fill(state.pulls++));
			}
		}),
		writable: new WritableStream({
			write(data) {
				state.writes.push(Uint8Array.from(data));
				return write?.(data);
			},
			close() { state.writeCloses++; }
		}),
		close() {
			if (state.closes++) return;
			try { readableController.error(new Error('socket closed')); } catch { }
			closed.resolve();
		}
	};
	return socket;
}

function fixture({ transport = 'xhttp', data = packet(), socket = memorySocket(), connect = null } = {}) {
	const abort = new AbortController();
	const state = { publicCalls: 0, calls: [], bodyCanceled: false };
	const body = new ReadableStream({
		start(controller) { controller.enqueue(transport === 'grpc' ? grpcFrame(data) : data); },
		cancel() { state.bodyCanceled = true; }
	});
	const request = {
		url: 'https://transport.example.test/tunnel',
		method: transport === 'ws' ? 'GET' : 'POST',
		headers: new Headers(transport === 'ws' ? { upgrade: 'websocket' } : {
			'content-type': transport === 'grpc' ? 'application/grpc' : 'application/octet-stream'
		}),
		body: transport === 'ws' ? null : body,
		signal: abort.signal,
		cf: { colo: 'TPE', asn: 0, country: 'TW' },
		fetcher: { connect() { state.publicCalls++; throw new Error('unexpected public connection'); } }
	};
	const env = {
		ADMIN: 'transport-test-admin', KEY: 'transport-test-key', UUID: uuid,
		HOME_EGRESS: '192.168.50.2:19090',
		HOME_NET: { connect(address) { state.calls.push(address); return connect ? connect() : socket; } }
	};
	return {
		abort, state, socket,
		async fetch() {
			const response = await worker.fetch(request, env, {});
			if (transport === 'ws') response.webSocket.send(data);
			return response;
		}
	};
}

async function settle() {
	for (let i = 0; i < 12; i++) await nextTurn();
}

async function waitFor(predicate) {
	for (let i = 0; i < 100; i++) {
		if (predicate()) return;
		await nextTurn();
	}
	assert.ok(predicate(), 'expected transport state was not reached');
}

test('WebSocket close releases the established relay TCP connection', async () => {
	const f = fixture({ transport: 'ws' });
	const response = await f.fetch();
	await waitFor(() => f.socket.state.writes.length === 1);
	response.webSocket.close();
	await waitFor(() => f.socket.state.closes > 0);
	assert.equal(f.state.publicCalls, 0);
});

test('WebSocket close cancels a relay that is still opening', async () => {
	const opening = deferred();
	const f = fixture({ transport: 'ws', socket: memorySocket({ opened: opening.promise }) });
	const response = await f.fetch();
	await waitFor(() => f.state.calls.length === 1);
	await settle();
	response.webSocket.close();
	await waitFor(() => f.socket.state.closes > 0);
	opening.resolve({});
	await settle();
	assert.equal(f.socket.state.writes.length, 0);
});

test('WebSocket close releases the relay even when a later upload write is pending', async () => {
	const uploading = deferred();
	let writes = 0;
	const f = fixture({ transport: 'ws', socket: memorySocket({ write: () => ++writes > 1 ? uploading.promise : undefined }) });
	const response = await f.fetch();
	await waitFor(() => writes === 1);
	response.webSocket.send(new Uint8Array([4, 5, 6]));
	await waitFor(() => writes === 2);
	response.webSocket.close();
	await waitFor(() => f.socket.state.closes > 0);
	uploading.resolve();
	await settle();
	assert.equal(f.state.calls.length, 1, 'closing a stalled upload must not redial the relay');
});

test('HTTP abort cancels relay opening without waiting for its deadline', async () => {
	const f = fixture({ socket: memorySocket({ opened: deferred().promise }) });
	const responsePromise = f.fetch();
	await waitFor(() => f.state.calls.length === 1);
	await settle();
	f.abort.abort(new Error('client disconnected'));
	assert.equal((await responsePromise).status, 502);
	assert.ok(f.socket.state.closes > 0);
	assert.equal(f.socket.state.writes.length, 0);
	assert.equal(f.state.bodyCanceled, true);
	assert.equal(f.state.publicCalls, 0);
});

test('a relay socket arriving after HTTP abort is closed without a handshake', async () => {
	const dial = deferred();
	const f = fixture({ connect: () => dial.promise });
	const responsePromise = f.fetch();
	await waitFor(() => f.state.calls.length === 1);
	f.abort.abort();
	assert.equal((await responsePromise).status, 502);
	dial.resolve(f.socket);
	await waitFor(() => f.socket.state.closes > 0);
	assert.equal(f.socket.state.writes.length, 0);
});

test('gRPC response cancellation interrupts a pending relay connection', async () => {
	const f = fixture({ transport: 'grpc', socket: memorySocket({ opened: deferred().promise }) });
	const response = await f.fetch();
	await waitFor(() => f.state.calls.length === 1);
	await settle();
	await response.body.cancel();
	await waitFor(() => f.socket.state.closes > 0 && f.state.bodyCanceled);
	assert.equal(f.socket.state.writes.length, 0);
});

test('XHTTP abort settles the unread VLESS response header write', async () => {
	const f = fixture({ data: packet('vless') });
	const response = await f.fetch();
	await waitFor(() => f.socket.state.writes.length === 1);
	f.abort.abort(new Error('header consumer disconnected'));
	await settle();
	assert.ok(f.socket.state.closes > 0);
	assert.equal(f.state.bodyCanceled, true);
	await assert.rejects(response.body.getReader().read(), /header consumer disconnected/);
});

for (const stage of ['opened', 'write']) {
	test(`relay ${stage} deadline closes the socket without public fallback`, async t => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		const gate = deferred();
		const socket = memorySocket(stage === 'opened' ? { opened: gate.promise } : { write: () => gate.promise });
		const f = fixture({ socket });
		const responsePromise = f.fetch();
		await waitFor(() => stage === 'opened' ? f.state.calls.length === 1 : socket.state.writes.length === 1);
		await settle();
		t.mock.timers.tick(10_000);
		assert.equal((await responsePromise).status, 502);
		assert.ok(socket.state.closes > 0);
		assert.equal(f.state.publicCalls, 0);
		gate.resolve({});
	});
}

for (const transport of ['xhttp', 'grpc']) {
	test(`${transport} pauses relay reads for a slow response consumer and closes on cancellation`, async () => {
		const f = fixture({ transport, socket: memorySocket({ chunks: 100 }) });
		const response = await f.fetch();
		await waitFor(() => f.socket.state.writes.length === 1);
		await settle();
		const pausedPulls = f.socket.state.pulls;
		assert.ok(pausedPulls > 0 && pausedPulls <= 3, `unexpected buffered source chunks: ${pausedPulls}`);
		await settle();
		assert.equal(f.socket.state.pulls, pausedPulls, 'source reads must stay paused without response demand');
		const reader = response.body.getReader();
		for (let i = 0; i < 4; i++) assert.ok((await reader.read()).value.byteLength > 0);
		await waitFor(() => f.socket.state.pulls > pausedPulls);
		await reader.cancel();
		await waitFor(() => f.socket.state.closes > 0 && f.state.bodyCanceled);
		assert.equal(f.state.publicCalls, 0);
	});
}

for (const transport of ['ws', 'xhttp', 'grpc']) {
	test(`${transport} translates the household VLESS speed-test request to a relay Trojan handshake`, async () => {
		const hostname = 'speed.cloudflare.com';
		const f = fixture({ transport, data: packet('vless', hostname) });
		const response = await f.fetch();
		const reader = transport === 'grpc' ? response.body.getReader() : null;
		if (reader) await reader.read();
		await waitFor(() => f.socket.state.writes.length === 1);
		assert.deepEqual(f.socket.state.writes[0], Uint8Array.from(packet('trojan', hostname)));
		assert.deepEqual(f.state.calls, [{ hostname: '192.168.50.2', port: 19090 }]);
		assert.equal(f.state.publicCalls, 0);
		if (transport === 'ws') response.webSocket.close();
		else if (reader) await reader.cancel();
		else await response.body.cancel();
		await waitFor(() => f.socket.state.closes > 0);
	});
}
