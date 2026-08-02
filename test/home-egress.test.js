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
const macRelayPassword = 'mac-relay-test-secret-00000001';
const nasRelayPassword = 'nas-relay-test-secret-00000002';

function trojanPacket({ command = 1, hostname = 'example.com', port = 443, payload = new Uint8Array([1, 2, 3]), authPassword = password } = {}) {
	const auth = Buffer.from(createHash('sha224').update(authPassword).digest('hex'));
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

function requestWithBody(body, publicConnect, url = 'https://home-egress.example.test/tunnel') {
	return {
		url,
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

function multiSiteEnvironment(macConnect, nasConnect) {
	return {
		ADMIN: 'test-admin',
		KEY: 'test-key',
		UUID: password,
		DEFAULT_EGRESS: 'mac',
		EGRESS_PROTOCOL: 'vless',
		EGRESS_SITES: JSON.stringify([
			{ id: 'mac', name: 'Taiwan Mac mini', binding: 'EGRESS_MAC_NET', address: '192.168.50.2:19090', secret_env: 'EGRESS_MAC_RELAY_PASSWORD' },
			{ id: 'nas', name: 'Site B NAS', binding: 'EGRESS_NAS_NET', address: '192.168.60.2:19090', secret_env: 'EGRESS_NAS_RELAY_PASSWORD' }
		]),
		EGRESS_MAC_RELAY_PASSWORD: macRelayPassword,
		EGRESS_NAS_RELAY_PASSWORD: nasRelayPassword,
		EGRESS_MAC_NET: { connect: macConnect },
		EGRESS_NAS_NET: { connect: nasConnect }
	};
}

function metadataRequest(url, userAgent = 'Shadowrocket') {
	return {
		url,
		method: 'GET',
		headers: new Headers({ 'user-agent': userAgent }),
		cf: { colo: 'TPE', asn: 0, asOrganization: 'test', country: 'TW', city: 'Taipei' },
		fetcher: { connect() { throw new Error('public connector must not be used') } }
	};
}

function memoryKV(initial = {}) {
	const entries = new Map(Object.entries(initial));
	return {
		async get(key) { return entries.has(key) ? entries.get(key) : null },
		async put(key, value) { entries.set(key, value) }
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

test('selects each configured egress site without contacting the other binding', async () => {
	const macCalls = [], nasCalls = [], writes = [];
	let publicCalls = 0;
	const response = await worker.fetch(
		requestWithBody(
			vlessPacket(),
			() => { publicCalls++; throw new Error('public fallback used') },
			'https://home-egress.example.test/tunnel?egress=nas'
		),
		multiSiteEnvironment(
			address => { macCalls.push(address); return fakeSocket(writes) },
			address => { nasCalls.push(address); return fakeSocket(writes) }
		),
		{ waitUntil() { } }
	);

	await waitFor(() => nasCalls.length === 1 && writes.length === 1, 'NAS VPC binding was not used');
	assert.deepEqual(macCalls, []);
	assert.deepEqual(nasCalls, [{ hostname: '192.168.60.2', port: 19090 }]);
	assert.deepEqual(writes[0], trojanPacket({ authPassword: nasRelayPassword }));
	assert.equal(publicCalls, 0);
	await response.body.cancel();
});

test('uses only DEFAULT_EGRESS when the client omits the site selector', async () => {
	const macCalls = [], nasCalls = [], writes = [];
	const response = await worker.fetch(
		requestWithBody(vlessPacket(), () => { throw new Error('public fallback used') }),
		multiSiteEnvironment(
			address => { macCalls.push(address); return fakeSocket(writes) },
			address => { nasCalls.push(address); return fakeSocket(writes) }
		),
		{ waitUntil() { } }
	);

	await waitFor(() => macCalls.length === 1 && writes.length === 1, 'default VPC binding was not used');
	assert.deepEqual(nasCalls, []);
	assert.deepEqual(writes[0], trojanPacket({ authPassword: macRelayPassword }));
	await response.body.cancel();
});

test('fails closed on an unknown egress selector', async () => {
	let macCalls = 0, nasCalls = 0, publicCalls = 0;
	await assert.rejects(
		worker.fetch(
			requestWithBody(
				vlessPacket(),
				() => { publicCalls++; throw new Error('public fallback used') },
				'https://home-egress.example.test/tunnel?egress=missing'
			),
			multiSiteEnvironment(
				() => { macCalls++; throw new Error('Mac binding used') },
				() => { nasCalls++; throw new Error('NAS binding used') }
			),
			{ waitUntil() { } }
		),
		/Unknown egress site: missing/
	);
	assert.equal(macCalls, 0);
	assert.equal(nasCalls, 0);
	assert.equal(publicCalls, 0);
});

test('fails closed when the selected site binding is missing', async () => {
	let macCalls = 0, publicCalls = 0;
	const environment = multiSiteEnvironment(
		() => { macCalls++; throw new Error('Mac fallback used') },
		() => { throw new Error('unused NAS connector') }
	);
	delete environment.EGRESS_NAS_NET;
	await assert.rejects(
		worker.fetch(
			requestWithBody(
				vlessPacket(),
				() => { publicCalls++; throw new Error('public fallback used') },
				'https://home-egress.example.test/tunnel?egress=nas'
			),
			environment,
			{ waitUntil() { } }
		),
		/EGRESS_NAS_NET VPC binding is required for egress site nas/
	);
	assert.equal(macCalls, 0);
	assert.equal(publicCalls, 0);
});

test('fails closed when the selected site relay secret is missing', async () => {
	let macCalls = 0, nasCalls = 0, publicCalls = 0;
	const environment = multiSiteEnvironment(
		() => { macCalls++; throw new Error('Mac binding used') },
		() => { nasCalls++; throw new Error('NAS binding used') }
	);
	delete environment.EGRESS_NAS_RELAY_PASSWORD;
	await assert.rejects(
		worker.fetch(
			requestWithBody(
				vlessPacket(),
				() => { publicCalls++; throw new Error('public fallback used') },
				'https://home-egress.example.test/tunnel?egress=nas'
			),
			environment,
			{ waitUntil() { } }
		),
		/EGRESS_NAS_RELAY_PASSWORD must contain a 16-128 character relay password/
	);
	assert.equal(macCalls, 0);
	assert.equal(nasCalls, 0);
	assert.equal(publicCalls, 0);
});

test('re-authenticates Trojan TCP with the selected site relay secret', async () => {
	const writes = [];
	const payload = new Uint8Array([6, 5, 4]);
	const response = await worker.fetch(
		requestWithBody(
			trojanPacket({ payload }),
			() => { throw new Error('public fallback used') },
			'https://home-egress.example.test/tunnel?egress=nas'
		),
		multiSiteEnvironment(
			() => { throw new Error('Mac fallback used') },
			() => fakeSocket(writes)
		),
		{ waitUntil() { } }
	);

	await waitFor(() => writes.length === 1, 'Trojan TCP was not written to the NAS relay');
	assert.deepEqual(writes[0], trojanPacket({ payload, authPassword: nasRelayPassword }));
	await response.body.cancel();
});

test('re-authenticates Trojan UDP with the selected site relay secret', async () => {
	const writes = [];
	const payload = new Uint8Array([0, 1, 0]);
	const response = await worker.fetch(
		requestWithBody(
			trojanPacket({ command: 3, port: 53, payload }),
			() => { throw new Error('public fallback used') },
			'https://home-egress.example.test/tunnel?egress=nas'
		),
		multiSiteEnvironment(
			() => { throw new Error('Mac fallback used') },
			() => fakeSocket(writes)
		),
		{ waitUntil() { } }
	);

	await waitFor(() => writes.length === 1, 'Trojan UDP was not written to the NAS relay');
	assert.deepEqual(writes[0], trojanPacket({ command: 3, port: 53, payload, authPassword: nasRelayPassword }));
	await response.body.cancel();
});

test('does not fall back to another site when the selected relay is unavailable', async () => {
	let macCalls = 0, nasCalls = 0, publicCalls = 0;
	const response = await worker.fetch(
		requestWithBody(
			vlessPacket(),
			() => { publicCalls++; throw new Error('public fallback used') },
			'https://home-egress.example.test/tunnel?egress=nas'
		),
		multiSiteEnvironment(
			() => { macCalls++; throw new Error('Mac fallback used') },
			() => { nasCalls++; throw new Error('NAS relay unavailable') }
		),
		{ waitUntil() { } }
	);

	await waitFor(() => nasCalls === 1, 'selected NAS binding was not attempted');
	assert.equal(macCalls, 0);
	assert.equal(publicCalls, 0);
	await response.body.cancel();
});

test('subscription emits one explicitly selected node per configured egress site', async () => {
	const environment = {
		...multiSiteEnvironment(() => fakeSocket([]), () => fakeSocket([])),
		OFF_LOG: 'true',
		KV: memoryKV()
	};
	const context = { waitUntil() { } };
	const quickResponse = await worker.fetch(
		metadataRequest('https://home-egress.example.test/test-key'),
		environment,
		context
	);
	const subscriptionLocation = quickResponse.headers.get('Location');
	assert.match(subscriptionLocation, /^\/sub\?token=/);
	const initialSubscription = await worker.fetch(
		metadataRequest(`https://home-egress.example.test${subscriptionLocation}`),
		environment,
		context
	);
	assert.equal(initialSubscription.status, 200);
	await initialSubscription.text();
	const storedConfig = JSON.parse(await environment.KV.get('config.json'));
	storedConfig.传输协议 = 'grpc';
	await environment.KV.put('config.json', JSON.stringify(storedConfig));

	const subscriptionResponse = await worker.fetch(
		metadataRequest(`https://home-egress.example.test${subscriptionLocation}`),
		environment,
		context
	);
	assert.equal(subscriptionResponse.status, 200);
	const decodedSubscription = Buffer.from(await subscriptionResponse.text(), 'base64').toString('utf8');
	assert.doesNotMatch(decodedSubscription, /EGRESS_(MAC|NAS)_RELAY_PASSWORD/);
	assert.doesNotMatch(decodedSubscription, /(?:mac|nas)-relay-test-secret/);
	const links = decodedSubscription.trim().split(/\r?\n/);
	const siteCounts = { mac: 0, nas: 0 };
	for (const link of links) {
		const node = new URL(link);
		assert.equal(node.searchParams.get('type'), 'ws');
		const path = node.searchParams.get('path');
		const site = new URL(path, 'https://worker.invalid').searchParams.get('egress');
		if (site === 'mac' || site === 'nas') siteCounts[site]++;
		const name = decodeURIComponent(node.hash.slice(1));
		if (site === 'mac') assert.match(name, /^Taiwan Mac mini · /);
		if (site === 'nas') assert.match(name, /^Site B NAS · /);
		assert.doesNotMatch(name, /[\u{1F1E6}-\u{1F1FF}]/u);
	}
	assert.ok(siteCounts.mac > 0);
	assert.equal(siteCounts.mac, siteCounts.nas);
});
