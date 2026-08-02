import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const templateURL = new URL('../deploy/nas/', import.meta.url);

test('NAS relay resolves domains before rejecting private destinations', async () => {
	const template = await readFile(new URL('sing-box.json.template', templateURL), 'utf8');
	const config = JSON.parse(template.replace('__RELAY_PASSWORD__', 'a'.repeat(64)));
	assert.deepEqual(config.dns.servers, [{ type: 'local', tag: 'local' }]);
	const resolveRule = config.route.rules.findIndex(rule => rule.action === 'resolve');
	const privateRule = config.route.rules.findIndex(rule => rule.ip_is_private === true);
	const reservedRule = config.route.rules.findIndex(rule => Array.isArray(rule.ip_cidr));
	assert.ok(resolveRule >= 0);
	assert.ok(resolveRule < privateRule);
	assert.ok(resolveRule < reservedRule);
});

test('NAS Compose isolates the relay and fixes both endpoint addresses', async () => {
	const compose = await readFile(new URL('compose.yaml.template', templateURL), 'utf8');
	assert.match(compose, /cloudflared:[\s\S]*ipv4_address: __CLOUDFLARED_IP__/);
	assert.match(compose, /cloudflared:[\s\S]*user: "0:0"/);
	assert.match(compose, /sing-box:[\s\S]*ipv4_address: __RELAY_IP__/);
	assert.doesNotMatch(compose, /^\s*ports:/m);
	assert.doesNotMatch(compose, /docker\.sock|cert\.pem|privileged:|network_mode:/);
	assert.equal((compose.match(/read_only: true/g) || []).length, 2);
	assert.equal((compose.match(/no-new-privileges:true/g) || []).length, 2);
});

test('NAS preparation renders every network placeholder', async () => {
	const script = await readFile(new URL('prepare.sh', templateURL), 'utf8');
	for (const placeholder of ['__SITE_SUBNET__', '__RELAY_IP__', '__CLOUDFLARED_IP__']) {
		assert.match(script, new RegExp(`s\\|${placeholder}\\|`));
	}
	assert.match(script, /amd64\|arm64/);
});
