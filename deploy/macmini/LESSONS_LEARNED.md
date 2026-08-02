# Mac mini home egress: lessons learned

這份文件整理 Cloudflare Worker、Cloudflare Tunnel、Mac mini 家庭出口與
Shadowrocket 實際部署及排障時得到的結論。文件刻意只使用占位符，不記錄正式
網域、IP、UUID、訂閱 token、管理密碼或 Cloudflare 資源 ID。

## 最終架構與協議分工

```text
Shadowrocket
  -> VLESS / WebSocket / TLS
  -> Cloudflare 自訂網域與 Worker
  -> Workers VPC binding
  -> Cloudflare Tunnel 私有路由
  -> Mac mini Trojan relay
  -> 台灣家庭網路出口
```

- 公開端使用 VLESS，是為了讓 Shadowrocket 能直接匯入訂閱並使用標準
  WebSocket/TLS 節點。
- Worker 到 Mac mini 的私有段保留 Trojan。這一段位於 VPC/Tunnel 內，改成
  VLESS 對上海到台灣的主要網路延遲沒有實質幫助，反而會增加 relay 與 Worker
  的改造面。
- `EGRESS_SITES` 啟用時必須 fail closed：所選 VPC 或 relay 不可用就讓連線
  失敗，不得回退到另一地點、公開 `PROXYIP`、SOCKS5 或 Cloudflare 直接出口。
- 私有路由只宣告 relay 主機的 `/32`，Mac 的 LAN 位址應在路由器上保留；不要
  把 relay port 暴露到公網。

## GFW 與 Shadowrocket

### 可連線不等於可瀏覽

Shadowrocket 顯示延遲或握手成功，只證明測試端點在當下可達，不能證明完整的
VLESS、WebSocket、Worker、Tunnel 與家庭出口路徑可用。驗收至少要包含：

1. Shadowrocket 更新訂閱成功。
2. 經代理開啟真實 HTTPS 網站，而非只按延遲測試。
3. 出口地區與 Mac mini 的直接出口一致。
4. Worker 沒有使用公開 fallback。
5. 上海的行動網路與 Wi-Fi 各測一次，因為 DNS 和跨境路由可能不同。

### 網域、TLS 與 ECH

- `workers.dev` 在中國大陸可能解析不到或連線不穩，正式入口應使用 Cloudflare
  託管區域下的自訂子網域，例如 `<worker-hostname>`。
- 優先保留 443 節點。2053、2083、2087、2096、8443 等 Cloudflare TLS port
  可作備援，但部分網路會直接封鎖或繞遠，不能只因為 Cloudflare 支援就全部視為
  可用。
- Chrome fingerprint、Shadowrocket TLS fragment 與隨機 WebSocket path 可作為
  相容性選項，但它們不能修正品質差的跨境路由。
- ECH 在部分網路有幫助，在另一些 DNS 或客戶端組合則會出現「測速成功、實際
  網頁失敗」。保留一個 `ech=0` 相容訂閱，用 A/B 測試判斷，避免把 ECH 當成
  必須條件。
- 0-RTT 預設關閉。穩定性優先時，不值得為省一次握手承擔 early data 相容性與
  重放風險。

### 節點清單

- 節點多不代表可用性高。大量公開優選 IP 往往過期、繞路或在特定運營商超時，
  還會讓 Shadowrocket 產生大量探測與重連。
- 保留一組精簡的亞洲節點與美國備援即可。亞洲可涵蓋台灣、香港、日本、新加坡
  及一個自動選擇入口；美國節點用於跨境路由異常時容錯。
- Cloudflare 是 anycast。名稱中的 `TW`、`HK`、`JP` 或 `US` 是入口來源／路由
  分組，不保證每次都落在該國家的 Cloudflare colo。
- 節點名稱使用純文字，例如 `TW Telecom 01`，不要加入國旗 emoji。不同 iOS
  版本和訂閱轉換器的 emoji 顯示、排序與去重結果不一致。
- 調整節點後必須在 Shadowrocket 主動更新訂閱；畫面仍顯示舊節點通常是客戶端
  快取，不代表 KV 沒更新。

## UDP 的邊界

- 目前家庭出口模式的公開 VLESS/WebSocket 設定以 TCP 可用性為優先，不宣告
  未經端到端驗證的 VLESS UDP。
- Shadowrocket 顯示 `UDP` 標籤不代表 UDP 已經穿過 Worker、VPC、Tunnel 與
  Mac relay。錯誤宣告 UDP 常造成 DNS、HTTP/3 或影音應用看似連線但無資料。
- 如需 UDP，必須分別測 DNS、QUIC 與一般 UDP，並確認封包確實由 Mac 出口；
  在測試完成前，讓客戶端回退 TCP 比提供假的 UDP 能力可靠。

## 多地點出口

- 每個可選地點需要獨立 Named Tunnel、VPC binding、私有 `/32` route 與本地
  egress relay。把 NAS 加入 Mac 的 Tunnel 作為 replica 只會增加 HA，不會形成
  可獨立選擇的出口。
- `cloudflared` 不解析 VLESS/Trojan，也不會自己成為任意 Internet 目的地的 NAT
  gateway，因此不能單獨取代 relay。可先沿用 sing-box；若日後更換為小型 daemon，
  必須保留相同的目的位址轉送、驗證與 fail-closed 語意。
- `EGRESS_SITES` 只保存站點 ID、名稱、binding 名稱、私網 relay 位址及
  `secret_env` 名稱，不保存 secret 值。訂閱會為每個 ingress route 產生各站點
  版本，並把 `egress=<site-id>` 放入傳輸 path。
- `DEFAULT_EGRESS` 只處理沒有 selector 的舊客戶端，不是健康檢查或自動備援。
  selector 不存在、binding 缺失或 relay 失敗時均直接終止連線。
- 多站點訂閱固定使用 WebSocket。gRPC 的 `serviceName` 會丟棄 query string，若把
  `egress=<site-id>` 放在 query 會讓所有節點誤用 `DEFAULT_EGRESS`。
- NAS Docker 端固定 relay `.2` 與 cloudflared `.3`，避免動態 IP allocator 搶占
  private route 指向的位址。只 route relay `/32`，不要 route 整個 Docker subnet。
- 不受信任站點的 relay 必須先解析 domain，再套用 private/reserved IP 規則；只檢查
  原始目的 IP 會讓指向 LAN 或 metadata address 的 domain 繞過限制。

## KV、訂閱與外部依賴

- VLESS WebSocket 資料連線在主路徑上不讀 KV。KV 主要提供訂閱、管理設定和
  節點清單，因此代理流量大不會等比例增加 KV 成本。
- 一次本地訂閱生成會讀取少量設定鍵。保持 `OFF_LOG=true` 可避免每次訂閱或
  管理請求都寫入 KV 日誌，也減少保存來源 IP 與 User-Agent 的風險。
- 優先使用 Worker 本地生成的 mixed subscription。第三方訂閱轉換服務會增加
  可用性依賴，也可能看到完整訂閱 URL；使用前應視為需要信任的第三方。
- 訂閱 URL 是 credential，不應貼到 issue、commit、聊天截圖或 shell history。

## 成本模型

Workers 的主要計費量是 request 和 CPU time，不是經過 WebSocket 的 GB 數：

- 一次 WebSocket Upgrade 算一次 Worker request，連線後的每個 frame 不會各算
  一次 request。
- Worker 等待網路 I/O 的 wall time 不等於 CPU time。
- Workers 沒有額外 data transfer/egress 費；Workers VPC 在 beta 期間免費。
- 付費方案的固定月費、內含 request/CPU 配額及超額單價可能改變，估算前應重新
  核對 [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)、
  [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/) 與
  [Workers VPC](https://developers.cloudflare.com/workers-vpc/)。

成本估算應使用帳戶整體的 billing period 數據，因為額度由同帳戶下所有 Workers
共用。大量短連線、錯誤與自動重連通常比長時間傳輸更容易增加 request 與 CPU。

`cloudflared` 的本機 Prometheus metrics 可看到 tunnel request 與 QUIC bytes，但
counter 會在程序重啟後歸零，且 QUIC bytes 含協議 overhead，不能當作應用 payload
的精確帳單。若要做月報，應定期採集 counter，而不是月底才讀一次。

```sh
curl -fsS http://127.0.0.1:<metrics-port>/metrics |
  grep -E 'cloudflared_tunnel_total_requests|quic_client_(sent|receive)_bytes'
```

## 監控與排障順序

每次修改只改一層，依照以下順序驗證，可以避免同時猜 DNS、Worker 和 Mac：

1. `./deploy/macmini/status.sh`：確認 relay 與 cloudflared 正在運行。
2. `./deploy/macmini/test-local.sh`：確認 relay 能從 Mac 正常直接出站。
3. 確認 cloudflared 有四條 HA connection，且 private route 只有預期的 `/32`。
4. `./deploy/macmini/test-worker.sh`：確認 Worker 經 VPC 到 Mac，並驗證 fail closed。
5. 更新 Shadowrocket 訂閱，再從上海測真實 HTTPS 和出口。
6. 查看 Worker 的 request、CPU P50/P90、uncaught exception、client disconnect 和
   error rate。重連率高時先處理錯誤，不要先繼續增加節點。

效能瓶頸通常在上海運營商到 Cloudflare、Cloudflare 到台灣 Tunnel colo，或跨境
封包丟失，而不是 VLESS 與 Trojan 的解析成本。Mac 使用有線網路、cloudflared
使用 QUIC 並維持四條 HA connection，通常比更換私有段協議更有效。

## Secret 與設定衛生

- `ADMIN`、固定 `UUID` 與其他秘密使用 `wrangler secret`；relay credential 和
  訂閱 token 存在 macOS Keychain。
- 每個 `EGRESS_SITES` 站點以 `secret_env` 指向獨立 relay secret。relay secret
  不得與公開 VLESS UUID 共用，否則把朋友端加入出口時也會把所有公開節點的
  client credential 交給對方。
- 對外分享的 `wrangler.toml` 範例和文件只保留 `<tunnel-id>`、
  `<kv-namespace-id>`、`<lan-relay-ip>`、`<worker-hostname>` 這類占位符，
  不包含正式值。
- 若沒有明確設定 `UUID`，修改 `ADMIN` 或 `KEY` 可能連帶改變衍生 UUID 或訂閱
  token。要穩定客戶端身分就固定 UUID；要撤銷舊訂閱則另行輪替 UUID/token。
- 部署前檢查 staged diff，並搜尋 URL token、UUID、Cloudflare ID、私有／公網 IP
  與長字串 credential。不要假設私有 LAN IP 因為不可從公網路由就可以公開。
- `keep_vars=true` 可降低 deploy 覆蓋 Dashboard 變數的風險，但正式設定仍應有
  可重建的清單，並定期驗證 Worker binding、secret 和 custom domain。

## Upstream 更新注意事項

上游 edgetunnel 的預設假設包含公開 ProxyIP、SOCKS/HTTP fallback、第三方優選
API 與多種協議。家庭出口 fork 的安全邊界不同，因此更新上游時要逐項確認：

- `EGRESS_SITES` 的每個 selector 是否仍在所有 TCP 路徑強制使用對應 VPC
  connector，且舊的 `HOME_EGRESS` 相容模式沒有繞過此限制。
- 任一錯誤分支是否新增公開直連或 fallback。
- 訂閱是否錯誤宣告 UDP，或洩漏內部 relay 資訊。
- KV 日誌是否重新開啟，或新增高頻 write。
- 節點生成是否重新加入過多公開優選 IP、emoji 或第三方轉換器。

不要直接以「可以部署」作為合併成功的標準；本地測試、Worker-to-Mac 測試和上海
端到端測試都通過，才算完成。
