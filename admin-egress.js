function escapeHTML(value) {
	return String(value ?? '')
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

function renderSiteRows(sites) {
	if (!sites.length) return '<p class="empty">尚未設定家庭出口站點。</p>';
	return `<div class="site-list">${sites.map(site => {
		const secretStatus = site.secretEnv
			? `<span class="status ${site.secretConfigured ? 'ok' : 'bad'}">${site.secretConfigured ? 'Secret 已設定' : 'Secret 缺少'}</span>`
			: '<span class="status warn">舊版共用 UUID</span>';
		const bindingStatus = `<span class="status ${site.bindingConfigured ? 'ok' : 'bad'}">${site.bindingConfigured ? 'Binding 已設定' : 'Binding 缺少'}</span>`;
		return `<article class="site-card">
			<div><strong>${escapeHTML(site.name)}</strong><code>${escapeHTML(site.id)}</code></div>
			<p>${escapeHTML(site.address)} · ${escapeHTML(site.binding)}</p>
			<div class="statuses">${bindingStatus}${secretStatus}</div>
		</article>`;
	}).join('')}</div>`;
}

export function renderEgressAdminPage(sites = []) {
	const siteRows = renderSiteRows(sites);
	return `<!doctype html>
<html lang="zh-Hant">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width,initial-scale=1">
	<meta name="robots" content="noindex,nofollow">
	<title>出口站點接入</title>
	<style>
		:root{color-scheme:dark;--bg:#08111f;--panel:#101c2e;--line:#263750;--text:#e8eef8;--muted:#9fb0c8;--blue:#5ea0ff;--green:#63d8a2;--red:#ff7c8b;--amber:#f4c56a}
		*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top,#142846 0,var(--bg) 42%);color:var(--text);font:15px/1.55 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
		main{width:min(980px,calc(100% - 32px));margin:32px auto 72px}header{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:24px}h1,h2{margin:0}h1{font-size:clamp(26px,5vw,40px)}h2{font-size:20px;margin-bottom:14px}.lead{color:var(--muted);max-width:680px;margin:8px 0 0}.back{color:var(--text);text-decoration:none;border:1px solid var(--line);border-radius:10px;padding:8px 12px;white-space:nowrap}
		section{background:color-mix(in srgb,var(--panel) 94%,transparent);border:1px solid var(--line);border-radius:18px;padding:22px;margin-top:18px;box-shadow:0 18px 45px #0004}.site-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px}.site-card{border:1px solid var(--line);border-radius:12px;padding:14px;background:#0b1627}.site-card>div:first-child{display:flex;justify-content:space-between;gap:12px}.site-card p{color:var(--muted);margin:8px 0 12px;overflow-wrap:anywhere}code,textarea,input{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.statuses{display:flex;gap:7px;flex-wrap:wrap}.status{font-size:12px;border-radius:999px;padding:3px 8px;background:#25344b}.status.ok{color:var(--green)}.status.bad{color:var(--red)}.status.warn{color:var(--amber)}.empty{color:var(--muted)}
		.notice{border-left:3px solid var(--amber);padding:10px 13px;background:#f4c56a12;color:#ffe4ad;border-radius:4px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.field{display:grid;gap:6px}.field.full{grid-column:1/-1}label{font-weight:650}small,.hint{color:var(--muted)}input,textarea{width:100%;border:1px solid var(--line);background:#081321;color:var(--text);border-radius:9px;padding:10px 12px;font-size:14px}input:focus,textarea:focus{outline:2px solid #5ea0ff66;border-color:var(--blue)}textarea{min-height:88px;resize:vertical}.secret{font-size:13px;word-break:break-all}.actions,.output-head{display:flex;align-items:center;justify-content:space-between;gap:10px}.actions{justify-content:flex-start;margin-top:16px}.output{margin-top:16px}.output-head{margin-bottom:6px}.output-head label{font-size:14px}
		button{appearance:none;border:1px solid var(--line);border-radius:9px;background:#182a43;color:var(--text);padding:9px 13px;font-weight:700;cursor:pointer}button.primary{background:var(--blue);border-color:var(--blue);color:#06101f}button:hover{filter:brightness(1.1)}button:disabled{cursor:not-allowed;opacity:.55}.copy{padding:5px 9px;font-size:12px}.security-list{color:var(--muted);padding-left:20px}.security-list strong{color:var(--text)}
		@media(max-width:700px){main{width:min(100% - 20px,980px);margin-top:20px}header{display:block}.back{display:inline-block;margin-top:14px}.grid{grid-template-columns:1fr}.field.full{grid-column:auto}section{padding:17px}}
	</style>
</head>
<body>
<main>
	<header>
		<div><h1>出口站點接入</h1><p class="lead">在本機瀏覽器產生站點 relay 密碼與設定片段。產物只存在目前頁面，重新整理後即消失。</p></div>
		<a class="back" href="/admin">返回管理後台</a>
	</header>

	<section aria-labelledby="current-title">
		<h2 id="current-title">目前 Worker 站點</h2>
		${siteRows}
	</section>

	<section aria-labelledby="generator-title">
		<h2 id="generator-title">產生 NAS 接入資料</h2>
		<p class="notice">這個頁面不會建立 Tunnel、VPC binding 或 Worker Secret。Owner 仍須在 Cloudflare 套用產生的設定，避免把具管理權限的 API token 放進 Worker。</p>
		<div class="grid">
			<div class="field"><label for="site-id">站點 ID</label><input id="site-id" value="nas" maxlength="32" pattern="[a-z0-9][a-z0-9_-]{0,31}" autocomplete="off"><small>小寫英數、底線或連字號</small></div>
			<div class="field"><label for="site-name">顯示名稱</label><input id="site-name" value="NAS Site" maxlength="64" autocomplete="off"></div>
			<div class="field"><label for="site-index">Site index</label><input id="site-index" type="number" value="42" min="1" max="254" inputmode="numeric"><small>決定 172.30.N.0/29 Docker subnet</small></div>
			<div class="field"><label for="tunnel-id">Tunnel ID</label><input id="tunnel-id" placeholder="建立 Tunnel 後貼上" autocomplete="off"><small>只放資源 ID，不要貼 Tunnel token</small></div>
			<div class="field"><label for="binding">VPC binding</label><input id="binding" value="EGRESS_NAS_NET" maxlength="64" autocomplete="off"></div>
			<div class="field"><label for="secret-env">Worker Secret 名稱</label><input id="secret-env" value="EGRESS_NAS_RELAY_PASSWORD" maxlength="64" autocomplete="off"></div>
		</div>
		<div class="actions"><button class="primary" id="generate" type="button">產生 256-bit 密碼與設定</button><span class="hint" id="message" role="status"></span></div>

		<div class="output">
			<div class="output-head"><label for="password">Relay password（只顯示一次）</label><button class="copy" data-copy="password" disabled type="button">複製</button></div>
			<textarea class="secret" id="password" readonly placeholder="按下產生後顯示；不會送到伺服器"></textarea>
		</div>
		<div class="output">
			<div class="output-head"><label for="site-entry">EGRESS_SITES 站點項目</label><button class="copy" data-copy="site-entry" disabled type="button">複製</button></div>
			<textarea id="site-entry" readonly></textarea>
		</div>
		<div class="output">
			<div class="output-head"><label for="binding-config">Wrangler VPC binding</label><button class="copy" data-copy="binding-config" disabled type="button">複製</button></div>
			<textarea id="binding-config" readonly></textarea>
		</div>
		<div class="output">
			<div class="output-head"><label for="owner-commands">Owner 指令（不含密碼值）</label><button class="copy" data-copy="owner-commands" disabled type="button">複製</button></div>
			<textarea id="owner-commands" readonly></textarea>
		</div>
		<div class="output">
			<div class="output-head"><label for="nas-command">NAS 指令</label><button class="copy" data-copy="nas-command" disabled type="button">複製</button></div>
			<textarea id="nas-command" readonly></textarea>
		</div>
	</section>

	<section aria-labelledby="security-title">
		<h2 id="security-title">安全交付</h2>
		<ul class="security-list">
			<li>朋友端只取得 <strong>site index、該 Tunnel run token、該站點 relay password</strong>。</li>
			<li>不要交付 Cloudflare API token、Global API Key、cert.pem、Wrangler 登入、公開 VLESS UUID 或訂閱 URL。</li>
			<li>每個地點使用獨立 Tunnel 與 relay password；selector 不是授權機制。</li>
		</ul>
	</section>
</main>
<script>
(() => {
	'use strict';
	let relayPassword = '';
	const byId = id => document.getElementById(id);
	const fields = ['site-id', 'site-name', 'site-index', 'tunnel-id', 'binding', 'secret-env'];
	const outputs = ['password', 'site-entry', 'binding-config', 'owner-commands', 'nas-command'];

	function normalizeNames() {
		const suffix = byId('site-id').value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');
		if (suffix) {
			if (!byId('binding').dataset.edited) byId('binding').value = 'EGRESS_' + suffix + '_NET';
			if (!byId('secret-env').dataset.edited) byId('secret-env').value = 'EGRESS_' + suffix + '_RELAY_PASSWORD';
		}
	}

	function validate() {
		const id = byId('site-id').value.trim();
		const name = byId('site-name').value.trim();
		const index = Number(byId('site-index').value);
		const binding = byId('binding').value.trim();
		const secretEnv = byId('secret-env').value.trim();
		if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) throw new Error('站點 ID 格式不正確');
		if (!name || name.length > 64) throw new Error('顯示名稱必須是 1–64 字元');
		if (!Number.isInteger(index) || index < 1 || index > 254) throw new Error('Site index 必須是 1–254');
		if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(binding)) throw new Error('VPC binding 格式不正確');
		if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(secretEnv)) throw new Error('Worker Secret 名稱格式不正確');
		return { id, name, index, binding, secretEnv, tunnelId: byId('tunnel-id').value.trim() };
	}

	function render() {
		if (!relayPassword) return;
		try {
			const value = validate();
			const relayAddress = '172.30.' + value.index + '.2:19090';
			byId('password').value = relayPassword;
			byId('site-entry').value = JSON.stringify({ id: value.id, name: value.name, binding: value.binding, address: relayAddress, secret_env: value.secretEnv }, null, 2);
			byId('binding-config').value = '[[vpc_networks]]\\n' +
				'binding = "' + value.binding + '"\\n' +
				'tunnel_id = "' + (value.tunnelId || '<TUNNEL_ID>') + '"\\n' +
				'remote = true';
			byId('owner-commands').value = 'npx wrangler secret put ' + value.secretEnv + '\\n' +
				'# 在提示中貼上本頁 relay password，再部署：\\n' +
				'npx wrangler deploy --config wrangler.toml';
			byId('nas-command').value = 'EGRESS_SITE_INDEX=' + value.index + ' ./deploy/nas/prepare.sh\\n' +
				'docker compose -f deploy/nas/runtime/compose.yaml up -d\\n' +
				'docker compose -f deploy/nas/runtime/compose.yaml ps';
			document.querySelectorAll('[data-copy]').forEach(button => { button.disabled = false; });
			byId('message').textContent = '已在本機產生；重新整理後會消失。';
		} catch (error) {
			byId('message').textContent = error.message;
		}
	}

	byId('generate').addEventListener('click', () => {
		const bytes = crypto.getRandomValues(new Uint8Array(32));
		relayPassword = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
		render();
	});
	byId('site-id').addEventListener('input', () => { normalizeNames(); render(); });
	for (const id of ['binding', 'secret-env']) byId(id).addEventListener('input', event => { event.target.dataset.edited = 'true'; render(); });
	for (const id of fields.filter(id => !['site-id', 'binding', 'secret-env'].includes(id))) byId(id).addEventListener('input', render);
	document.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', async () => {
		const target = byId(button.dataset.copy);
		try {
			await navigator.clipboard.writeText(target.value);
			button.textContent = '已複製';
			setTimeout(() => { button.textContent = '複製'; }, 1200);
		} catch {
			target.focus(); target.select();
			byId('message').textContent = '瀏覽器禁止剪貼簿存取，已選取文字。';
		}
	}));
	for (const id of outputs) byId(id).setAttribute('spellcheck', 'false');
})();
</script>
</body>
</html>`;
}

export function egressAdminHeaders() {
	return {
		'Cache-Control': 'no-store, no-cache, must-revalidate',
		'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; connect-src 'none'",
		'Content-Type': 'text/html;charset=utf-8',
		'Referrer-Policy': 'no-referrer',
		'X-Content-Type-Options': 'nosniff',
		'X-Frame-Options': 'DENY'
	};
}

export async function injectEgressAdminShortcut(response) {
	if (!response?.ok || !(response.headers.get('Content-Type') || '').toLowerCase().includes('text/html')) return response;
	const html = await response.text();
	const shortcut = '<a href="/admin/egress" aria-label="出口站點接入" style="position:fixed;right:18px;bottom:18px;z-index:2147483647;padding:10px 14px;border-radius:999px;background:#2563eb;color:#fff;text-decoration:none;font:600 14px system-ui;box-shadow:0 8px 24px #0006">出口站點</a>';
	const body = html.includes('href="/admin/egress"')
		? html
		: (/<\/body>/i.test(html) ? html.replace(/<\/body>/i, shortcut + '</body>') : html + shortcut);
	const headers = new Headers(response.headers);
	headers.set('Cache-Control', 'no-store');
	headers.delete('Content-Encoding');
	headers.delete('Content-Length');
	headers.delete('ETag');
	return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
