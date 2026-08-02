# NAS Docker 出口站點

這套 bundle 在 NAS 上以 Docker Compose 同時執行 `cloudflared` 與 sing-box：

```text
Worker VPC binding -> Named Tunnel -> cloudflared (.3) -> sing-box relay (.2) -> NAS 家庭網路出口
```

`cloudflared` 只把 Worker 的 private-network 連線送進站點，不能自行解析 VLESS／
Trojan 或替任意目的地建立 Internet 連線；sing-box relay 仍是必要元件。兩者放在
獨立 `/29` Docker bridge，不 publish host port、不使用 host network，也不需 router
開放 inbound port。

## 相容性

- Linux Docker `amd64` 或 `arm64`。固定版本的兩個 image 都支援這兩種架構；舊式
  ARMv7 NAS 不支援目前的 cloudflared image，`prepare.sh` 會直接停止。
- Docker Engine 與 Compose v2；script 也接受舊的 `docker-compose` 指令。
- Synology DSM 7.2 可在 Container Manager 的 **Project** 匯入 Compose；QNAP
  Container Station 可用 **Application** 建立 Compose application。建議先透過 SSH
  執行準備與驗證，再回到 NAS UI 管理啟停。

官方參考：

- [Cloudflare Tunnel Docker setup](https://developers.cloudflare.com/tunnel/setup/)
- [Cloudflare Tunnel run parameters](https://developers.cloudflare.com/tunnel/advanced/run-parameters/)
- [Docker Compose services and secrets](https://docs.docker.com/reference/compose-file/services/)
- [Synology Container Manager projects](https://kb.synology.com/en-us/DSM/help/ContainerManager/docker_project)
- [QNAP Container Station Compose applications](https://docs.qnap.com/operating-system/qne-network/1.0.x/en-us/container-creation-1A95801A.html)

## 1. Owner 建立站點資源

每一台 NAS／每一個地點都要有自己的 remotely-managed Named Tunnel、Workers VPC
binding 與 relay secret。不要把 NAS 加成 Mac Tunnel 的 replica；replica 只提供同一
route 的 HA，不能形成可選擇的另一個家庭出口。

1. 在 Cloudflare Dashboard 建立專用 Tunnel，記下 Tunnel ID 與該 Tunnel 的 run
   token。不要在 NAS 執行 `cloudflared tunnel login`。
2. 為站點分配未使用的 `EGRESS_SITE_INDEX`（1–254）。站點 `N` 固定使用：

   - bridge：`172.30.N.0/29`
   - relay：`172.30.N.2:19090`
   - cloudflared：`172.30.N.3`

3. 在 Tunnel 建立且只建立 relay 的 private route：`172.30.N.2/32`。不要宣告 NAS
   LAN、Docker subnet、`0.0.0.0/0` 或朋友家的其他網段。
4. 產生 64 字元 hexadecimal relay password，放入該站點專屬 Worker secret：

   ```sh
   openssl rand -hex 32
   npx wrangler secret put EGRESS_NAS_RELAY_PASSWORD
   ```

5. 在忽略的 `wrangler.toml` 加入站點與 binding；設定只引用 secret 名稱，不放值：

   ```toml
   EGRESS_SITES = '''
   [
     { "id": "mac", "name": "Taiwan Mac mini", "binding": "EGRESS_MAC_NET", "address": "192.0.2.10:19090", "secret_env": "EGRESS_MAC_RELAY_PASSWORD" },
     { "id": "nas", "name": "Site B NAS", "binding": "EGRESS_NAS_NET", "address": "172.30.42.2:19090", "secret_env": "EGRESS_NAS_RELAY_PASSWORD" }
   ]
   '''
   DEFAULT_EGRESS = "mac"
   EGRESS_PROTOCOL = "vless"

   [[vpc_networks]]
   binding = "EGRESS_NAS_NET"
   tunnel_id = "<nas-tunnel-id>"
   remote = true
   ```

上例假設 NAS index 是 `42`。文件中的 TEST-NET 位址只是去敏範例，不可直接部署。

## 2. NAS 準備 Compose bundle

在互動式 SSH terminal 執行，其中 `42` 必須與 owner 建立 route 時的 index 相同：

```sh
EGRESS_SITE_INDEX=42 ./deploy/nas/prepare.sh
```

Script 會隱藏讀取該 Tunnel token 與該站點 relay password，然後：

- 驗證 Docker 架構與 Compose；
- 生成 Git 忽略且 mode `0600` 的 `deploy/nas/runtime/`；
- 固定 cloudflared 與 relay 位址，避免 Docker 動態 allocator 搶到 `.2`；
- 拉取 pinned images 並執行 `sing-box check`；
- 不把 credential 放進 CLI argument、shell history、Compose environment 或
  process list。Cloudflared 以 `--token-file` 讀取 token。

啟動與查看狀態：

```sh
docker compose -f deploy/nas/runtime/compose.yaml up -d
docker compose -f deploy/nas/runtime/compose.yaml ps
docker compose -f deploy/nas/runtime/compose.yaml logs --tail=100
```

若 NAS 只提供 `docker-compose`，將上面三行的 `docker compose` 換成
`docker-compose`。

### Synology Container Manager

1. 保留整個 `deploy/nas/runtime/` 目錄，三個檔案必須放在同一 Project path。
2. Container Manager → **Project** → **Create**，選該目錄並匯入
   `compose.yaml`。
3. 不啟用 Web Station portal，不新增 port mapping；完成後以 Project 頁面啟動。

### QNAP Container Station

1. 保留整個 `deploy/nas/runtime/` 目錄，確認 Container Station 執行帳號可讀取。
2. 在 **Applications** 建立 Compose application，YAML 使用 `compose.yaml`，並讓
   相對路徑仍指向同目錄的 `tunnel-token` 與 `sing-box.json`。
3. 不新增 published port、privileged mode 或 host network。

不同 NAS UI 對 Compose 相對檔案的匯入方式不完全一致；若 UI 會把 YAML 複製到
另一目錄，請用 SSH 的 `docker compose -f ... up -d` 啟動，UI 仍可查看 container。

## 3. 網路與安全邊界

- NAS firewall 需允許 DNS 到既有 resolver，以及 cloudflared 對外 TCP/UDP 7844。
  `auto` 優先 QUIC；UDP 受阻時只會把同一 Tunnel transport 改成 HTTP/2 TCP
  7844，不會切到其他出口。
- sing-box 需要一般 DNS 與 Internet outbound，才能讓流量從 NAS 的 public IP 出口。
- relay 沒有 host/LAN port。Container 使用 read-only filesystem、drop all
  capabilities 與 `no-new-privileges`；沒有掛載 Docker socket、`cert.pem`、Cloudflare
  credentials directory 或 NAS 資料目錄。
- cloudflared container 只為讀取 mode `0600` 的 file-backed Compose secret 而以
  root 啟動；它仍採 read-only filesystem、drop all capabilities 與
  `no-new-privileges`。這避免把 host 上的 Tunnel token 改成其他使用者可讀。
- NAS 原有的 cloudflared service 可以保留；這個 bundle 使用獨立 container 與
  Tunnel token，不讀取或掛載原有的 `~/.cloudflared`。
- relay 會先解析 domain，再拒絕 private、loopback、link-local、CGNAT、multicast
  與保留網段，避免代理使用者以 domain 繞過規則掃描 NAS LAN 或 metadata service。
- Tunnel run token 不是一次性 token；持有人能啟動該 Tunnel connector，直到 owner
  輪替或撤銷。若 NAS 屬於朋友，依
  [`deploy/friend/README.md`](../friend/README.md) 的最小揭露流程交付 credential。

## 4. 驗收與 fail closed

1. Owner 確認只有 NAS Tunnel Healthy，private route 恰為 relay `/32`。
2. 更新 Shadowrocket 訂閱；家庭出口啟用時節點固定採 VLESS/WebSocket，每個站點的
   path 都帶自己的 `egress=<site-id>` selector。
3. 選 NAS 節點開啟真實 HTTPS 網站，確認 public IP 是 NAS 所在地。
4. 停止 NAS relay：

   ```sh
   docker compose -f deploy/nas/runtime/compose.yaml stop sing-box
   ```

   NAS 節點必須直接失敗，不能回退 Mac、其他家庭站點、PROXYIP、SOCKS 或
   Cloudflare public egress。再啟動 relay 並確認恢復。

## 5. 更新、撤銷與移除

Images 固定版本，避免 NAS 自動拉到未驗證 breaking release。升級時先在測試站點修改
template tag、執行 `prepare.sh` 驗證，再 `pull` 與 `up -d`；不要使用 Watchtower
自動更新此安全邊界。

撤銷順序：先從 `EGRESS_SITES` 移除站點並部署 Worker，再移除 VPC binding 與 `/32`
route，輪替 Tunnel token、刪除 Tunnel 與 Worker relay secret，最後在 NAS 執行：

```sh
docker compose -f deploy/nas/runtime/compose.yaml down
```

接著安全刪除 `deploy/nas/runtime/`。不要把 runtime 目錄加入備份同步、Git 或支援工單。
