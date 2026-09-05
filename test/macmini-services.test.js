import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile, symlink, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const macminiURL = new URL('../deploy/macmini/', import.meta.url);
const hasJq = spawnSync('jq', ['--version']).status === 0;
const shellTest = (name, fn) => test(name, { skip: !hasJq && 'jq is required for deployment script tests' }, fn);

test('Mac deployment scripts pass POSIX shell syntax checks', async () => {
  for (const script of (await readdir(macminiURL)).filter(name => name.endsWith('.sh'))) {
    const result = spawnSync('/bin/sh', ['-n', fileURLToPath(new URL(script, macminiURL))], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${script}: ${result.stderr}`);
  }
});

// All service, network, credential and privilege commands are intercepted.
// The scripts' system plist directory is also relocated into the fixture.
const mockSource = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const root = process.env.MAC_TEST_ROOT;
const state = JSON.parse(process.env.MAC_TEST_STATE);
fs.appendFileSync(path.join(root, 'events'), JSON.stringify({tool, args}) + '\n');
const output = value => process.stdout.write(value + '\n');
const fail = () => process.exit(1);
const ownProcess = role => {
  fs.writeFileSync(path.join(root, role + '.pid'), String(process.pid));
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1000);
};
switch (tool) {
case 'id': output(args[0] === '-un' ? 'relay-user' : '501'); break;
case 'brew':
  if (args[0] === '--prefix') output(path.join(root, 'brew'));
  else if (args.join(' ') !== 'services stop sing-box') fail();
  break;
case 'sing-box':
  if (args[0] === 'check') JSON.parse(fs.readFileSync(args[2], 'utf8'));
  else if (state.clientCollision) fail();
  else ownProcess('client');
  break;
case 'node':
  if (args[0] === '-e') ownProcess('probe');
  else output('UDP DNS through Trojan relay passed');
  break;
case 'security': output('11111111-1111-4111-8111-111111111111'); break;
case 'route': output('interface: en0'); break;
case 'ipconfig': output('192.168.10.25'); break;
case 'wrangler': if (args[0] !== 'whoami') fail(); break;
case 'cloudflared':
  if (args.join(' ') === 'tunnel list --output json') output(JSON.stringify([{name:'edgetunnel-macmini-egress',id:'test-tunnel'}]));
  else if (args.join(' ') === 'tunnel route ip show --output json') output(JSON.stringify([{network:'127.0.0.1/32',tunnel_id:'test-tunnel'}]));
  else fail();
  break;
case 'launchctl':
  if (args[0] !== 'print') break;
  if (state.inaccessibleSystem && args[1].startsWith('system/')) fail();
  const isTunnel = args[1].includes('cloudflared');
  if (state.missingTunnel && isTunnel) fail();
  if (!args[1].startsWith((state.domain || 'system') + '/')) fail();
  output('state = ' + (state.stoppedTunnel && isTunnel ? 'waiting' : 'running'));
  output('pid = ' + (isTunnel ? 4322 : 4321));
  break;
case 'lsof': {
  const pid = args[args.indexOf('-p') + 1];
  if (!args.includes('-a') || !args.includes('-p')) process.exit(90);
  if (state.clientCollision || state.foreignListener) fail();
  if (state.testClient) {
    const owns = ['client', 'probe'].some(role => {
      try { return fs.readFileSync(path.join(root, role + '.pid'), 'utf8') === pid; }
      catch { return false; }
    });
    if (!owns) fail();
  } else if (!['4321', '4322'].includes(pid)) fail();
  output('LISTEN');
  break;
}
case 'curl':
  if (args.at(-1).endsWith('/ready')) {
    if (state.notReady) process.exit(22);
    output(JSON.stringify({status:200,readyConnections:4}));
  } else if (args.at(-1).includes('cdn-cgi/trace')) output('ip=198.51.100.7\nloc=TW');
  else if (args.includes('--proxy')) process.exit(7);
  else output('local-only');
  break;
case 'plutil':
  JSON.parse(fs.readFileSync(args.at(-1), 'utf8'));
  break;
case 'sudo':
  if (args[0] === 'install') {
    const destination = args.at(-1);
    if (!destination.startsWith(path.join(root, 'system') + '/')) process.exit(91);
    fs.copyFileSync(args.at(-2), destination);
  } else if (!['-v', 'launchctl'].includes(args[0])) process.exit(92);
  break;
default: process.exit(93);
}
`;

async function fixture(t, state = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'edgetunnel-mac-tests-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixtureHome = path.join(root, 'user');
  const bin = path.join(root, 'bin');
  for (const directory of [bin, 'system', 'brew/etc/sing-box', 'user/.cloudflared', 'user/Library/LaunchAgents']) {
    await mkdir(path.isAbsolute(directory) ? directory : path.join(root, directory), { recursive: true });
  }
  await writeFile(path.join(root, 'events'), '');
  await writeFile(path.join(root, 'mock-tool'), `#!${process.execPath}\n${mockSource}`, { mode: 0o755 });
  for (const tool of ['id', 'brew', 'sing-box', 'node', 'security', 'route', 'ipconfig', 'wrangler', 'cloudflared', 'launchctl', 'lsof', 'curl', 'plutil', 'sudo']) {
    await symlink(path.join(root, 'mock-tool'), path.join(bin, tool));
  }
  await writeFile(path.join(root, 'brew/etc/sing-box/config.json'), await readFile(new URL('sing-box.json.template', macminiURL)));
  const credentialsPath = path.join(fixtureHome, '.cloudflared/test-tunnel.json');
  await writeFile(credentialsPath, '{}');
  await writeFile(path.join(fixtureHome, '.cloudflared/cert.pem'), 'test-only');
  await writeFile(path.join(fixtureHome, '.cloudflared/edgetunnel-macmini.json'), JSON.stringify({
    tunnel: 'test-tunnel', 'credentials-file': credentialsPath, metrics: '127.0.0.1:19094'
  }));
  const env = {
    ...process.env, HOME: fixtureHome, PATH: `${bin}:${process.env.PATH}`,
    MAC_TEST_ROOT: root, MAC_TEST_STATE: JSON.stringify(state),
    HOME_EGRESS_WORKER_HOST: 'worker.example.test', NO_PROXY: '*',
    HTTPS_PROXY: 'http://unreachable.example.test:1', ALL_PROXY: 'http://unreachable.example.test:1'
  };
  return {
    root, fixtureHome,
    async run(script) {
      const source = (await readFile(new URL(script, macminiURL), 'utf8'))
        .replaceAll('/Library/LaunchDaemons/', `${root}/system/`);
      const filename = path.join(root, script);
      await writeFile(filename, source);
      // configure-cloudflared resolves its template relative to the script.
      await writeFile(path.join(root, 'cloudflared-config.json.template'), await readFile(new URL('cloudflared-config.json.template', macminiURL)));
      await writeFile(path.join(root, 'sing-box.json.template'), await readFile(new URL('sing-box.json.template', macminiURL)));
      return spawnSync('/bin/sh', [filename], { env, encoding: 'utf8', timeout: 10000 });
    },
    async events() {
      return (await readFile(path.join(root, 'events'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    }
  };
}

for (const domain of ['system', 'gui']) {
  shellTest(`Mac status accepts ready ${domain} services with their own listeners`, async t => {
    const context = await fixture(t, { domain });
    const result = await context.run('status.sh');
    assert.equal(result.status, 0, result.stderr);
    const events = await context.events();
    const request = events.find(event => event.tool === 'curl').args;
    assert.equal(request[request.indexOf('--noproxy') + 1], '*');
    assert.equal(request.at(-1), 'http://127.0.0.1:19094/ready');
  });
}

for (const scenario of ['missingTunnel', 'stoppedTunnel', 'notReady', 'foreignListener']) {
  shellTest(`Mac status fails when ${scenario}`, async t => {
    const context = await fixture(t, { [scenario]: true });
    const result = await context.run('status.sh');
    assert.equal(result.status, 1, result.stderr);
  });
}

shellTest('Mac status distinguishes an unreadable installed system job from a missing service', async t => {
  const context = await fixture(t, { inaccessibleSystem: true, domain: 'gui' });
  await writeFile(path.join(context.root, 'system/com.edgetunnel.macmini.sing-box.plist'), 'test-system-job');
  const result = await context.run('status.sh');
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Cannot inspect installed sing-box service/);
  assert.ok(!(await context.events()).some(event => event.tool === 'launchctl' && event.args[1].startsWith('gui/')));
});

shellTest('Mac Tunnel setup preserves unrelated connector config and service', async t => {
  const context = await fixture(t);
  const oldConfig = path.join(context.fixtureHome, '.cloudflared/config.yml');
  const oldService = path.join(context.fixtureHome, 'Library/LaunchAgents/com.cloudflare.cloudflared.plist');
  await writeFile(oldConfig, 'unrelated-config');
  await writeFile(oldService, 'unrelated-service');
  for (const script of ['configure-cloudflared.sh', 'install-cloudflared-service.sh']) {
    const result = await context.run(script);
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(await readFile(oldConfig, 'utf8'), 'unrelated-config');
  assert.equal(await readFile(oldService, 'utf8'), 'unrelated-service');
  const events = await context.events();
  const jobs = events.filter(event => event.tool === 'launchctl');
  assert.ok(jobs.length > 0);
  assert.ok(jobs.every(event => event.args.some(argument => argument.includes('com.edgetunnel.macmini.cloudflared'))));
});

shellTest('Mac system jobs retain the relay owner and install protected plists before stopping user services', async t => {
  const context = await fixture(t);
  await writeFile(path.join(context.fixtureHome, 'Library/LaunchAgents/homebrew.mxcl.sing-box.plist'), 'test-user-relay');
  await writeFile(path.join(context.fixtureHome, 'Library/LaunchAgents/com.edgetunnel.macmini.cloudflared.plist'), 'test-user-tunnel');
  const result = await context.run('install-system-services.sh');
  assert.equal(result.status, 0, result.stderr);
  for (const service of ['sing-box', 'cloudflared']) {
    const plistPath = path.join(context.root, `system/com.edgetunnel.macmini.${service}.plist`);
    const plist = JSON.parse(await readFile(plistPath, 'utf8'));
    assert.equal(plist.UserName, 'relay-user');
    assert.equal(plist.RunAtLoad, true);
    assert.equal(plist.KeepAlive, true);
    assert.ok(plist.ProgramArguments.includes(service === 'sing-box' ? '-c' : '--config'));
    if (process.platform === 'darwin') {
      const nativePath = `${plistPath}.native`;
      const conversion = spawnSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', nativePath, plistPath], { encoding: 'utf8' });
      assert.equal(conversion.status, 0, conversion.stderr);
      assert.match(await readFile(nativePath, 'utf8'), /<key>UserName<\/key>/);
      const lint = spawnSync('/usr/bin/plutil', ['-lint', nativePath], { encoding: 'utf8' });
      assert.equal(lint.status, 0, lint.stderr);
    }
  }
  const events = await context.events();
  const installs = events.filter(event => event.tool === 'sudo' && event.args[0] === 'install');
  assert.equal(installs.length, 2);
  for (const event of installs) assert.deepEqual(event.args.slice(1, 7), ['-o', 'root', '-g', 'wheel', '-m', '644']);
  const stopped = events.findIndex(event => event.tool === 'brew' && event.args[0] === 'services');
  assert.ok(stopped > events.lastIndexOf(installs[1]));
});

shellTest('Relay updates restart the installed system job without creating a user service', async t => {
  const context = await fixture(t);
  await writeFile(path.join(context.root, 'system/com.edgetunnel.macmini.sing-box.plist'), 'test-system-job');
  const result = await context.run('install.sh');
  assert.equal(result.status, 0, result.stderr);
  const events = await context.events();
  assert.ok(events.some(event => event.tool === 'sudo' && event.args.join(' ') === 'launchctl kickstart -k system/com.edgetunnel.macmini.sing-box'));
  assert.ok(!events.some(event => event.tool === 'brew' && event.args[0] === 'services'));
});

shellTest('The user connector installer refuses to duplicate an installed system job', async t => {
  const context = await fixture(t);
  await writeFile(path.join(context.root, 'system/com.edgetunnel.macmini.cloudflared.plist'), 'test-system-job');
  const result = await context.run('install-cloudflared-service.sh');
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /System service is installed/);
  assert.ok(!(await context.events()).some(event => ['launchctl', 'sudo'].includes(event.tool)));
});

for (const script of ['test-local.sh', 'test-worker.sh']) {
  shellTest(`${script} uses IPv4 direct baselines and explicitly overrides proxy bypasses`, async t => {
    const context = await fixture(t, { testClient: true });
    const result = await context.run(script);
    assert.equal(result.status, 0, result.stderr);
    const requests = (await context.events()).filter(event => event.tool === 'curl');
    for (const { args } of requests) {
      assert.equal(args[args.indexOf('--noproxy') + 1], args.includes('--proxy') ? '' : '*');
      if (!args.includes('--proxy') && args.at(-1).includes('cdn-cgi/trace')) assert.ok(args.includes('--ipv4'));
    }
  });
  shellTest(`${script} rejects an occupied port when its own client fails to start`, async t => {
    const context = await fixture(t, { clientCollision: true });
    const result = await context.run(script);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /test client did not start/);
    assert.equal((await context.events()).filter(event => event.tool === 'curl').length, 0);
  });
}
