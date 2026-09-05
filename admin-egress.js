function escapeHTML(value) {
	return String(value ?? '')
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

function renderSite(site, defaultSite) {
	const bindingStatus = site.bindingConfigured ? '<span class="status ok">VPC Binding 已設定</span>' : '<span class="status bad">VPC Binding 缺少</span>';
	const secretStatus = site.secretConfigured ? '<span class="status ok">Relay Secret 已設定</span>' : '<span class="status bad">Relay Secret 缺少</span>';
	return `<article class="site" data-site-card data-site-id="${escapeHTML(site.id)}">
		<div class="site-head">
			<label class="switch"><input data-enabled type="checkbox"${site.enabled ? ' checked' : ''}><span>啟用站點</span></label>
			<div class="order"><button data-move="up" type="button" aria-label="向上移動">↑</button><button data-move="down" type="button" aria-label="向下移動">↓</button></div>
		</div>
		<label class="field"><span>顯示名稱</span><input data-name maxlength="64" value="${escapeHTML(site.name)}"></label>
		<label class="default"><input data-default type="radio" name="default-site" value="${escapeHTML(site.id)}"${site.id === defaultSite ? ' checked' : ''}> 設為無 selector 時的預設出口</label>
		<div class="meta"><code>${escapeHTML(site.id)}</code><span>${escapeHTML(site.address)}</span><span>${escapeHTML(site.binding)}</span></div>
		<div class="statuses">${bindingStatus}${secretStatus}</div>
	</article>`;
}

export function renderEgressAdminPage(configuration) {
	const sites = Array.isArray(configuration?.sites) ? configuration.sites : [];
	const defaultSite = String(configuration?.defaultSite || '');
	return `<!doctype html>
<html lang="zh-Hant">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width,initial-scale=1">
	<meta name="robots" content="noindex,nofollow">
	<title>出口站點管理</title>
	<style>
		:root{color-scheme:dark;--bg:#08111f;--panel:#101c2e;--card:#0b1627;--line:#263750;--text:#e8eef8;--muted:#9fb0c8;--blue:#66a6ff;--green:#63d8a2;--red:#ff7c8b;--amber:#f4c56a}
		*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top,#142846 0,var(--bg) 44%);color:var(--text);font:15px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{width:min(920px,calc(100% - 28px));margin:30px auto 72px}
		header{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:20px}h1{font-size:clamp(26px,5vw,38px);margin:0}.lead{max-width:650px;color:var(--muted);margin:8px 0 0}.back{border:1px solid var(--line);border-radius:10px;color:var(--text);padding:8px 12px;text-decoration:none;white-space:nowrap}
		.notice{border:1px solid #f4c56a55;border-radius:12px;background:#f4c56a10;color:#ffe4ad;padding:13px 15px;margin-bottom:18px}.site-list{display:grid;gap:14px}.site{border:1px solid var(--line);border-radius:16px;background:var(--card);padding:17px}.site[aria-disabled="true"]{opacity:.62}.site-head,.actions,.statuses,.meta{display:flex;align-items:center;gap:9px}.site-head{justify-content:space-between}.switch,.default{display:flex;align-items:center;gap:8px}.switch{font-weight:750}.order button{padding:5px 10px}.field{display:grid;gap:6px;margin-top:14px}.field span{font-size:13px;color:var(--muted)}input[type="text"],input[data-name]{width:100%;border:1px solid var(--line);border-radius:9px;background:#081321;color:var(--text);font:15px system-ui;padding:10px 12px}.default{margin:13px 0 11px;color:var(--muted)}.meta{flex-wrap:wrap;color:var(--muted);font-size:12px}.meta>*{border-radius:7px;background:#152239;padding:3px 7px;overflow-wrap:anywhere}.statuses{flex-wrap:wrap;margin-top:11px}.status{font-size:12px;border-radius:999px;background:#25344b;padding:3px 8px}.status.ok{color:var(--green)}.status.bad{color:var(--red)}button{appearance:none;border:1px solid var(--line);border-radius:9px;background:#182a43;color:var(--text);padding:9px 13px;font-weight:700;cursor:pointer}button:hover{filter:brightness(1.1)}button:disabled{cursor:not-allowed;opacity:.45}.actions{margin-top:18px}.save{background:var(--blue);border-color:var(--blue);color:#06101f}.message{color:var(--muted)}.message.error{color:var(--red)}.foot{color:var(--muted);font-size:13px;margin-top:17px}
		@media(max-width:640px){main{width:min(100% - 18px,920px);margin-top:18px}header{display:block}.back{display:inline-block;margin-top:12px}.actions{align-items:flex-start;flex-direction:column}.meta{align-items:flex-start;flex-direction:column}}
	</style>
</head>
<body>
<main>
	<header><div><h1>出口站點管理</h1><p class="lead">管理已完成 Cloudflare 底層佈建的站點。儲存後，訂閱節點與新連線會套用這裡的名稱、啟用狀態、順序和預設出口。</p></div><a class="back" href="/admin">返回後台</a></header>
	<p class="notice">這裡不會建立或刪除 Tunnel、VPC binding、private route 與 Worker Secret，也不會顯示密碼。新地點仍須由 Cloudflare Owner 預先佈建，部署 Worker 後才會出現在此頁。</p>
	<div class="site-list" id="site-list">${sites.map(site => renderSite(site, defaultSite)).join('')}</div>
	<div class="actions"><button class="save" id="save" type="button">儲存站點設定</button><span class="message" id="message" role="status"></span></div>
	<p class="foot">停用站點後，新訂閱不再輸出該站點，已有 selector 連線也會直接失敗，不會回退到其他出口。KV 變更在不同 Cloudflare 地區可能需要短暫時間才完全一致。</p>
</main>
<script>
(() => {
	'use strict';
	const list = document.getElementById('site-list');
	const save = document.getElementById('save');
	const message = document.getElementById('message');
	const cards = () => Array.from(list.querySelectorAll('[data-site-card]'));

	function sync() {
		let firstEnabled = null, selectedEnabled = false;
		for (const card of cards()) {
			const enabled = card.querySelector('[data-enabled]').checked;
			const radio = card.querySelector('[data-default]');
			card.setAttribute('aria-disabled', String(!enabled));
			radio.disabled = !enabled;
			if (enabled && !firstEnabled) firstEnabled = radio;
			if (enabled && radio.checked) selectedEnabled = true;
		}
		if (!selectedEnabled && firstEnabled) firstEnabled.checked = true;
		save.disabled = !firstEnabled;
	}

	list.addEventListener('change', event => {
		if (event.target.matches('[data-enabled]')) sync();
	});
	list.addEventListener('click', event => {
		const button = event.target.closest('[data-move]');
		if (!button) return;
		const card = button.closest('[data-site-card]');
		if (button.dataset.move === 'up' && card.previousElementSibling) list.insertBefore(card, card.previousElementSibling);
		if (button.dataset.move === 'down' && card.nextElementSibling) list.insertBefore(card.nextElementSibling, card);
	});

	save.addEventListener('click', async () => {
		message.className = 'message';
		message.textContent = '儲存中…';
		save.disabled = true;
		try {
			const defaultInput = list.querySelector('[data-default]:checked:not(:disabled)');
			const payload = {
				defaultSite: defaultInput?.value || '',
				sites: cards().map(card => ({
					id: card.dataset.siteId,
					name: card.querySelector('[data-name]').value.trim(),
					enabled: card.querySelector('[data-enabled]').checked
				}))
			};
			const response = await fetch('/admin/egress', {
				method: 'POST',
				credentials: 'same-origin',
				cache: 'no-store',
				redirect: 'error',
				headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
				body: JSON.stringify(payload)
			});
			const result = await response.json();
			if (!response.ok) throw new Error(result.error || '儲存失敗');
			message.textContent = '已儲存；請在客戶端更新訂閱。';
		} catch (error) {
			message.className = 'message error';
			message.textContent = error.message;
		} finally {
			sync();
		}
	});
	sync();
})();
</script>
</body>
</html>`;
}

export function egressAdminHeaders() {
	return {
		'Cache-Control': 'no-store, no-cache, must-revalidate',
		'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
		'Content-Type': 'text/html;charset=utf-8',
		'Referrer-Policy': 'no-referrer',
		'X-Content-Type-Options': 'nosniff',
		'X-Frame-Options': 'DENY'
	};
}

export function renderAdminLogoutPage() {
	return `<!doctype html>
<html lang="zh-Hant">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width,initial-scale=1">
	<meta name="robots" content="noindex,nofollow">
	<title>確認登出</title>
	<style>body{font:16px/1.6 system-ui;margin:15vh auto;padding:0 24px;max-width:480px}button{font:inherit;padding:8px 20px;cursor:pointer}a{margin-left:20px}</style>
</head>
<body>
	<h1>確認登出</h1>
	<p>按下登出後，此次管理登入將失效。</p>
	<form method="POST" action="/logout">
		<button type="submit">登出</button><a href="/admin">返回後台</a>
	</form>
</body>
</html>`;
}

export function adminLogoutHeaders() {
	return {
		...egressAdminHeaders(),
		'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
	};
}

const adminActionScript = `<script id="edgetunnel-admin-actions" data-cfasync="false">
(() => {
	'use strict';
	const report = (message, type) => {
		if (typeof window.showToast === 'function') window.showToast(message, type);
		else window.alert(message);
	};
	const postAction = async path => {
		const response = await fetch(path, {
			method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
			headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
			body: '{}'
		});
		if (!response.ok) {
			const result = await response.json().catch(() => ({}));
			throw new Error(result.error || result.msg || '請求失敗（HTTP ' + response.status + '）');
		}
		return response.json();
	};
	window.confirmReset = async () => {
		try {
			await postAction('/admin/init');
			if (typeof window.closeResetModal === 'function') window.closeResetModal();
			report('配置已重置為預設值', 'success');
			setTimeout(() => window.location.reload(), 1000);
		} catch (error) {
			report('重置失敗：' + error.message, 'error');
		}
	};
	window.logout = async () => {
		try {
			const result = await postAction('/logout');
			if (result.success !== true) throw new Error('伺服器未確認登出完成');
			window.location.replace('/login');
		} catch (error) {
			report('登出失敗：' + error.message, 'error');
		}
	};
})();
</script>`;

export async function injectEgressAdminShortcut(response) {
	if (!response?.ok || !(response.headers.get('Content-Type') || '').toLowerCase().includes('text/html')) return response;
	const html = await response.text();
	const shortcut = '<a href="/admin/egress" aria-label="出口站點管理" style="position:fixed;right:18px;bottom:18px;z-index:2147483647;padding:10px 14px;border-radius:999px;background:#2563eb;color:#fff;text-decoration:none;font:600 14px system-ui;box-shadow:0 8px 24px #0006">出口站點</a>';
	const additions = (html.includes('href="/admin/egress"') ? '' : shortcut)
		+ (html.includes('id="edgetunnel-admin-actions"') ? '' : adminActionScript);
	// The upstream page contains complete HTML documents inside inert templates.
	const bodyEnd = html.toLowerCase().lastIndexOf('</body>');
	const body = bodyEnd === -1 ? html + additions : html.slice(0, bodyEnd) + additions + html.slice(bodyEnd);
	const headers = new Headers(response.headers);
	headers.set('Cache-Control', 'no-store');
	headers.delete('Content-Encoding');
	headers.delete('Content-Length');
	headers.delete('ETag');
	return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
