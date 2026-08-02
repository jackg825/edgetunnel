# 朋友家出口：零 Cloudflare 帳號權限 onboarding

這個流程把「Cloudflare 資源管理」與「朋友端執行 connector」完全分開。朋友不需
Cloudflare 帳號、Dashboard 權限、Wrangler、API token 或 `cert.pem`；他只取得
一個特定 Tunnel 的 run token，以及該站點專用的 relay password。

> `cloudflared` Tunnel token 不是一次性 token。持有人可以啟動該 Tunnel 的
> connector，直到你輪替或撤銷它；請把它視為長期 credential。

## 權限邊界

你（Cloudflare owner）負責：

1. 建立一個 remotely-managed Named Tunnel。每一位朋友／每一個地點使用不同
   Tunnel，不把任何 Tunnel token 跨站共用。
2. 為此站點分配未使用的 `EGRESS_SITE_INDEX`（1–254）。站點 `N` 的 Docker
   subnet 是 `172.30.N.0/29`，relay 是 `172.30.N.2:19090`。
3. 只建立 relay 的 `/32` private route，不宣告朋友 LAN、預設路由或其他 subnet。
4. 建立獨立 Workers VPC binding，以及 64 字元隨機 relay secret：
   `wrangler secret put EGRESS_FRIEND_RELAY_PASSWORD`。
5. 在忽略的 `wrangler.toml` 加入站點，但不寫 secret 值：

   ```toml
   EGRESS_SITES = '''
   [
     { "id": "friend", "name": "Friend Site", "binding": "EGRESS_FRIEND_NET", "address": "172.30.42.2:19090", "secret_env": "EGRESS_FRIEND_RELAY_PASSWORD" }
   ]
   '''

   [[vpc_networks]]
   binding = "EGRESS_FRIEND_NET"
   tunnel_id = "<friend-tunnel-id>"
   remote = true
   ```

6. 透過端對端加密且可過期的管道，把下列三項交給朋友：站點 index、該 Tunnel
   的 run token、該站點 relay password。

絕對不要交付：Cloudflare API token、Global API Key、帳號 `cert.pem`、Wrangler
設定／登入、其他 Tunnel credentials、Worker `ADMIN`、公開 VLESS `UUID`、訂閱
URL/token 或其他站點的 relay secret。`cert.pem` 可建立、刪除與管理帳戶內 Tunnel，
其權限遠大於朋友端所需。

朋友端能控制自己的 connector，因而可以讓該站點離線或冒充該站點，也能看到
出口目的地與流量時間／大小等 metadata。TLS 內容仍由端到端 TLS 保護，但這不是
把不受信任主機變成可信出口的方案；只能邀請你願意信任為網路出口營運者的人。

## 朋友端安裝

需求：`amd64`／`arm64` Linux NAS 或主機、Docker Engine 與 Docker Compose。共用的
[`deploy/nas` bundle](../nas/README.md) 會安裝（拉取）固定版本的官方
`cloudflared` 與 sing-box container；不執行
`cloudflared tunnel login`，也不呼叫任何 Cloudflare 管理 API。

1. 將這個 repository 的 `deploy/nas` 目錄與本文件交給朋友。
2. 朋友從互動式 terminal 執行，其中 `42` 換成你分配的 index：

   ```sh
   EGRESS_SITE_INDEX=42 ./deploy/nas/prepare.sh
   ```

3. Script 以隱藏輸入讀取兩個 credential，保存於被 Git 忽略且 mode `0600` 的
   `deploy/nas/runtime/`，不把 token 放在 CLI argument、shell history、Compose
   environment 或 process list。Cloudflared 以 `--token-file` 讀取 token。
4. Script 會驗證 Compose、拉取 pinned images，並執行 `sing-box check`。確認沒有
   錯誤後啟動：

   ```sh
   docker compose -f deploy/nas/runtime/compose.yaml up -d
   docker compose -f deploy/nas/runtime/compose.yaml ps
   ```

兩個 container 位於專用 Docker bridge。Relay 沒有 publish 到 NAS host 或朋友
LAN，只有同一 bridge 的 cloudflared 能連入；兩個服務皆採 read-only filesystem、
移除 Linux capabilities 並啟用 `no-new-privileges`。Router 不需且不得開 inbound
port。朋友網路需允許 cloudflared 對外使用 UDP 7844；若 UDP 不可用，`auto`
只會把同一條 Tunnel transport 改用 HTTP/2 TCP 7844，不會改走其他出口站點。
Relay 本身另需一般 Internet 出口流量。

朋友端 relay 預設拒絕 private、loopback、link-local、CGNAT、multicast 與保留
目的網段，包含 domain 解析後落入 private IP 的情況，避免代理使用者透過朋友出口
掃描 LAN、路由器或 metadata service。若改用其他 relay daemon，必須保留同等
目的位址限制。

朋友若已經有另一個 cloudflared service，可以保留；此 bundle 是獨立 container，
不讀取 `~/.cloudflared`，也不應掛載任何既有 `cert.pem` 或 credentials directory。

## 驗收

1. Owner 確認只有 friend Tunnel 變成 Healthy，其他 Tunnel／DNS／Worker 資源沒有
   變更。
2. 更新 Shadowrocket 訂閱，選擇 `Friend Site` 節點打開真實 HTTPS 網站。
3. 驗證出口 public IP 是朋友家，不是 Cloudflare 或其他家庭站點。
4. 停止 friend 的 sing-box container。該節點必須直接失敗，不能切到 Mac、NAS、
   PROXYIP、SOCKS 或 Cloudflare public egress。
5. 重新啟動並確認恢復：

   ```sh
   docker compose -f deploy/nas/runtime/compose.yaml restart sing-box
   ```

## 撤銷與離場

先從 `EGRESS_SITES` 和訂閱移除該站點並部署 Worker，再刪除 VPC binding 與 `/32`
route。接著在 Cloudflare Dashboard 輪替 Tunnel token，必要時強制斷開既有 connector，
最後刪除 Tunnel 與站點 relay secret。朋友端執行：

```sh
docker compose -f deploy/nas/runtime/compose.yaml down
```

然後安全刪除 `deploy/nas/runtime/`。因為朋友從未取得公開 VLESS UUID 或其他
站點 secret，正常撤銷不需要輪替所有 Shadowrocket 節點 credential。

Cloudflare 官方權限說明：

- [Tunnel tokens](https://developers.cloudflare.com/tunnel/advanced/tunnel-tokens/)
- [Tunnel permissions](https://developers.cloudflare.com/tunnel/advanced/local-management/tunnel-permissions/)
- [Run parameters and token-file](https://developers.cloudflare.com/tunnel/advanced/run-parameters/)
