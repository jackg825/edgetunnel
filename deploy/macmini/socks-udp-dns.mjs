import dgram from 'node:dgram';
import net from 'node:net';

const socksPort = Number(process.argv[2]);
if (!Number.isInteger(socksPort)) throw new Error('SOCKS port is required');

function readBytes(socket, length) {
	return new Promise((resolve, reject) => {
		let buffer = Buffer.alloc(0);
		const timeout = setTimeout(() => finish(new Error('SOCKS response timed out')), 5000);
		const finish = (error, value) => {
			clearTimeout(timeout);
			socket.off('data', onData);
			socket.off('error', onError);
			error ? reject(error) : resolve(value);
		};
		const onError = error => finish(error);
		const onData = chunk => {
			buffer = Buffer.concat([buffer, chunk]);
			if (buffer.length >= length) finish(null, buffer.subarray(0, length));
		};
		socket.on('data', onData);
		socket.on('error', onError);
	});
}

function dnsQuery() {
	const labels = 'example.com'.split('.');
	const question = Buffer.concat(labels.map(label => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])));
	return Buffer.concat([
		Buffer.from([0x45, 0x54, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
		question,
		Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01])
	]);
}

const tcp = net.createConnection({ host: '127.0.0.1', port: socksPort });
await new Promise((resolve, reject) => {
	tcp.once('connect', resolve);
	tcp.once('error', reject);
});

try {
	tcp.write(Buffer.from([0x05, 0x01, 0x00]));
	const method = await readBytes(tcp, 2);
	if (method[0] !== 0x05 || method[1] !== 0x00) throw new Error('SOCKS authentication failed');

	tcp.write(Buffer.from([0x05, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
	const associate = await readBytes(tcp, 10);
	if (associate[0] !== 0x05 || associate[1] !== 0x00 || associate[3] !== 0x01) throw new Error('SOCKS UDP associate failed');
	const relayHost = associate.subarray(4, 8).every(value => value === 0) ? '127.0.0.1' : Array.from(associate.subarray(4, 8)).join('.');
	const relayPort = associate.readUInt16BE(8);
	const query = dnsQuery();
	const packet = Buffer.concat([Buffer.from([0, 0, 0, 1, 1, 1, 1, 1, 0, 53]), query]);
	const udp = dgram.createSocket('udp4');

	try {
		const response = await new Promise((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error('UDP DNS response timed out')), 5000);
			udp.once('error', error => { clearTimeout(timeout); reject(error) });
			udp.once('message', message => { clearTimeout(timeout); resolve(message) });
			udp.send(packet, relayPort, relayHost);
		});
		let offset = 3;
		if (response[offset] === 1) offset += 1 + 4 + 2;
		else if (response[offset] === 3) offset += 2 + response[offset + 1] + 2;
		else if (response[offset] === 4) offset += 1 + 16 + 2;
		else throw new Error('Unexpected SOCKS UDP address type');
		const dns = response.subarray(offset);
		if (dns.length < 12 || dns[0] !== 0x45 || dns[1] !== 0x54 || (dns[2] & 0x80) === 0) throw new Error('Invalid DNS response');
	} finally {
		udp.close();
	}
} finally {
	tcp.destroy();
}

process.stdout.write('UDP DNS through Trojan relay passed\n');
