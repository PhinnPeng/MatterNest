# deploy

`docker-compose.yml`、`nginx.conf`、MinIO 桶策略、备份脚本、migrator 一次性服务（技术选型 §6、落地方案 W0-5）。

四件部署期必须落地的安全项，全部来自设计而非通用建议：

1. AES 主密钥与 HMAC 密钥**两把分离**，env/secret 注入，不入库不进镜像，`key_version` 列先留。
2. 云之家 `appId`/`appSecret` 同样 env 注入；**回调登记以云之家侧规则为准**，所以部署域名必须在联调前定死，改域名重走一次登记。
3. **请求体上限由 nginx 设死**（框架侧不设 body limit，附件走预签名 PUT 直传，后端不中转文件流）。
4. 明文导出与 `SENSITIVE_FIELD_READ` 审计同链路；另需一条口径：云之家不可达时保留哪些本地密码账号可用（至少一个 `sys_admin`），否则整所被锁在门外。
