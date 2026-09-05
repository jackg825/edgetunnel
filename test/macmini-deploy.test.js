import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const repositoryURL = new URL('../', import.meta.url);
const macminiURL = new URL('deploy/macmini/', repositoryURL);

test('Mac relay resolves domains before rejecting local destinations', async () => {
	const template = await readFile(new URL('sing-box.json.template', macminiURL), 'utf8');
	const config = JSON.parse(template);
	assert.deepEqual(config.dns.servers, [{ type: 'local', tag: 'local' }]);
	assert.equal(config.dns.strategy, 'ipv4_only');
	const resolveRule = config.route.rules.findIndex(rule => rule.action === 'resolve');
	const privateRule = config.route.rules.findIndex(rule => rule.ip_is_private === true);
	const reservedRule = config.route.rules.findIndex(rule => rule.ip_cidr?.includes('127.0.0.0/8'));
	const ipv6Rule = config.route.rules.findIndex(rule => rule.ip_cidr?.includes('::/0'));
	assert.ok(resolveRule >= 0);
	assert.equal(config.route.rules[resolveRule].strategy, 'ipv4_only');
	assert.ok(resolveRule < privateRule);
	assert.ok(resolveRule < reservedRule);
	assert.equal(reservedRule, ipv6Rule);
});

test('Mac relay and Tunnel route use loopback by default', async () => {
	const [installScript, tunnelScript, workerExample] = await Promise.all([
		readFile(new URL('install.sh', macminiURL), 'utf8'),
		readFile(new URL('configure-cloudflared.sh', macminiURL), 'utf8'),
		readFile(new URL('wrangler.example.toml', repositoryURL), 'utf8')
	]);

	assert.match(installScript, /HOME_EGRESS_LISTEN:-127\.0\.0\.1/);
	assert.match(tunnelScript, /HOME_EGRESS_ROUTE_CIDR:-127\.0\.0\.1\/32/);
	assert.match(workerExample, /"id": "mac"[^\n]+"address": "127\.0\.0\.1:19090"/);
	assert.doesNotMatch(installScript, /ipconfig getifaddr/);
});
