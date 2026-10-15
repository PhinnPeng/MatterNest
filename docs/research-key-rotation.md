# 三把密钥的轮换代价：是不是必须全量重加密？

> 研究日期 2026-10-15 · 承接 `docs/research-secret-storage.md`（MATT-36 已裁定「只经 env 注入、不入库」——本文**不复议该裁定**，直接引用）
>
> 标注口径：**［来源］** = 一手来源原文；**［实测］** = 本仓读码/跑数得出；**［推断］** = 我的估算。
> 一手来源：OWASP `Cryptographic_Storage_Cheat_Sheet` 与 `Key_Management_Cheat_Sheet`（GitHub 原文）、PostgreSQL 官方文档、Node.js 官方 `errors` / `crypto` 文档。NIST SP 800-38D §8.3 与 800-57 §5.3.6 经 OWASP 与 Vault 官方文档转述（二手转一手，仅用于量级，标注为转述）。二手博客一篇未引。

---

## 1. 短答

**②不是「必须全量重加密」——但 OWASP 明说全量重加密是**首选**路径，两者不矛盾。**

「能不能不重加密继续读」的答案是**能**，代价是必须同时持有新旧两把密钥；而 OWASP 的取舍是相反的：重加密「greatly simplifies both the application code and key management processes」。所以**最小改动不是 keyring，而是一次性批处理**。你的直觉方向对，但最优解要反过来。

**③换 HMAC 与换 AES 不是同一个问题，且你那条路成立。** 唯一真实障碍不是唯一索引冲突，而是 `NULL` 哈希行。

---

## 2. 三把密钥轮换代价对比

| | `MN_AES_KEY` | `MN_HMAC_KEY` | `MN_SESSION_PEPPER` |
|---|---|---|---|
| 影响面 | `mn_party.id_number` / `.contact` 全部历史密文 | `mn_party.id_number_hash` 全列（仅此一列） | `mn_auth_session.token_hash` 全表 |
| 直接换掉的后果 | **历史 PII 永久不可读**（`:153` 无条件 `aesKey()`，无 fallback） | 查重失效；唯一索引拒收重复行 | 全部会话失效，人人重登 |
| 明文可取回？ | 否（唯一不可逆的一把） | **是**（AES 能解开） | 不适用 |
| 需不需要停机 | 否（keyring 只需重启） | 否（单事务批量 UPDATE） | 否（重启） |
| 回滚 | keyring：翻回 active version；重加密：**不可逆**，只能恢复 DB 备份 | 不可逆（哈希单向），同需备份 | 免费（换回旧值重启） |
| 平明经过内存 | 重加密批处理会让全表明文在批处理进程里过一遍（新暴露面） | 是，同左，但明文本就常在 | 否 |
| 改造工作量 | 一次性脚本 | 一次性脚本 | **改 env + 重启，零代码** |

---

## 3. ① 一直用同一把，可接受吗

**可接受（在这个仓的规模下）。** ［来源］OWASP KM CS §Cryptoperiods 明写「Organizations **should** define cryptoperiods **through risk assessment**」——cryptoperiod 是**风险评估产物，不是固定期限**；NIST 800-57 §5.3.6 的 ≤2 年是同一性质的建议。把它当硬要求是把建议当规范。

［推断］本仓的实际风险**不是密钥年龄，是密钥泄露**。内网自用、千级当事人、读多写少 ⇒ 单把 256-bit AES 密钥承载的「被攻破后一次性解密全部 PII」的期望损失很小，且备份/主机登录才是现实入口（此判断沿用 `research-secret-storage.md` §2）。**结论：不排期轮换，但要把「这把密钥要用到系统下线 + 泄露了怎么应急」写进部署文档。**

---

## 4. ② 换 `MN_AES_KEY` 是否必须全量重加密

**(a) 不重加密能否继续读？能。** ［来源］OWASP Cryptographic Storage CS §Key Lifetimes and Rotation 列出两条路：「1. Decrypting it and re-encrypting it with the new key. 2. **Marking each item with the ID of the key that was used to encrypt it, and storing multiple keys** to allow the old data to be decrypted.」本仓信封已带 `v1:` 前缀 ⇒ 方案 2 **纯代码改动，零数据迁移、零 schema 变更**（前缀本就是每次 `encryptField` 写进去的自描述数据，`field-crypto.ts:128`）。**这是最 fortunate 的事实：改造成本只落在 `decryptField:149-153` 这 5 行。**

**(b) 直接换掉会怎样：全库永久不可读，确认无误。** ［实测］`decryptField:149` `stored.slice(stored.indexOf(":")+1)` **丢弃前缀**，`:153` `createDecipheriv(..., aesKey(), ...)` **无条件用当前单值 env**；全函数**无 try/catch、无 fallback**。［来源］Node.js 官方 `errors` 文档：`ERR_CRYPTO_INVALID_AUTH_TAG`「An invalid authentication tag was provided.」—— 解密必抛。表现为「打开当事人详情 500」（`deploy/README.md:129` 已记录）。**没有任何兜底路径。**

**(c) 但 OWASP 明说重加密是首选** ［来源］：「The first option should **generally be preferred**, as it greatly simplifies both the application code and key management processes」。故**建议**：真要轮换时走重加密（一次性脚本，参照迁移 0009 已有的回填先例），不建 keyring。

⚠ **两条来源共同指出、你没列的一条**：［来源］即便走重加密，「old keys should **generally be stored for a certain period after they are retired**, in case old backups of copies of the data need to be decrypted」——**历史备份仍然需要旧 AES 密钥**。⇒ 无论哪条路，**旧密钥都不能真删**，「销毁旧钥」这一步做不了。

---

## 5. ③ 换 `MN_HMAC_KEY`：与换 AES 不是同一个问题

**你的路径成立：旧 AES 解密 → 新 HMAC 重算 → 整表重写。** 明文拿得到，所以无不可逆障碍。

**全部 `blindIndex` 调用点（生产 5 处 + 1 处脚本，均只碰同一列 `mn_party.id_number_hash`）：**
`services/parties.ts:361`（查重/复用）· `:445`（建档写入）· `:504`（关键词搜索，**只读**）· `:836`（更新前查重）· `:927`（改证件号）· `agent-work/revred-parties.mjs:73`（一次性脚本）。
`parties.spec.ts:248-257` 为单测，`:257` 传的 `"party.contact"` 域**只在测试里出现**。

**没有第三张表存哈希**［实测］：`mn_import_row.row_hash` 是**无密钥** `sha256(host_type + 归一化入参)`（`services/import.ts:54`）⇒ 不受影响；`mn_auth_session.token_hash` 依赖 pepper 不是 HMAC 密钥；`mn_app_user.password_hash` 走 scrypt。

**真实障碍（三条，按严重度）：**
1. **`NULL` 哈希行会撞唯一索引** —— 这是唯一的真冲突。［来源］PostgreSQL 官方：唯一索引「multiple table rows with equal indexed values are not allowed」，但「By default, **null values … are not considered equal**, allowing multiple nulls」。⇒ 迁移 0009 之前的存量行 `id_number_hash IS NULL`，唯一索引**从未约束过它们**；回填时两行**明文证件号相同**就会算出**相同的新哈希** ⇒ `uk_mn_party_identity (type, id_number_hash)` 拒收。必须**先按业务合并去重**（那是业务动作，不是密码学动作）。
2. **非 `NULL` 行不冲突**［推断，但可证］：HMAC 是单射，旧索引已保证无两行共享旧哈希 ⇒ 新哈希亦两两不同 ⇒ **单条批量 UPDATE 安全，不需要停机**。索引非 deferrable（`CREATE UNIQUE INDEX` 而非 UNIQUE CONSTRAINT）意味着逐行即时检查，但此处恰好不会触发。
3. **批处理期间关键词搜索漏命中**：`parties.ts:504` 用 `eq(idNumberHash, blindIndex(keyword))`，新旧哈希混存时**查不到旧哈希行**。只读、只影响搜索召回，不产生脏数据。

**耗时**［实测］：本仓实测 1000 行导入 82.5s（`agent-work/chk44-scale.txt`）。千级 `mn_party` 原地 UPDATE 在同一量级（**秒级到分钟级，非小时级**）。

---

## 6. ④ 最小设计改动

**我的建议排序（与你的候选不同）：**

1. **先做 (b)+(a) 的合并体，但只做 keyring 选钥、不建 (c) 那套 env**——即 `decryptField` 按信封前缀查密钥表。**~15 行、零数据迁移、零 schema 变更**。［来源］OWASP：「the code and processes required to rotate a key are in place **before they are required**」。
2. **(d) 批处理后置**——只在真要轮换时才写，且是一次性脚本（照 0009 回填的形状）。
3. **(e) 现在就写进 `deploy/README.md`**：这把密钥用到系统下线 + 泄露应急路径 + 旧钥不得销毁（因备份）。
4. **(c) 推迟**：只有「定下轮换日期」才值得付它的复杂度。

**对你候选的两点修正：**
- **(b) 单做是错的**：`MN_KEY_VERSION` 本身是单个标量，不参与选钥就毫无用处——(a) 和 (b) **必须同时做**才成立。
- **你漏掉的第 6 条 —— 轮换事件留痕**。［来源］OWASP KM CS：「rotation events should be **logged with the timestamp, operator identity, and management authorization reference**」。本仓 `mn_config`/审计表已有承载处，属一次性小改动。

---

## 7. ⑤ pepper 轮换的代价

**最便宜的一把：改 env + 重启，零代码。** ［实测］全仓 `MN_SESSION_PEPPER` 只在 `auth.ts:49` 被读一次，链路唯一：`pepper()` → `tokenHashOf():71` → 仅 `createSession:128` / `destroySession:151` / `readActor:182`。**没有任何非会话用途。**
`derive():76` 走 `scryptSync(password, "mn-demo-salt-"+username)`，**不使用 pepper**——你看到的是对的，**全仓确认无第三处**，`password_hash` 不受影响。

**没有硬编码 pepper 值**［实测］：`agent-work/_fix-pepper.mjs` 是**一次性开发脚本**，作用是把 `.env` 里被注释掉的 `MN_SESSION_PEPPER=` 行取消注释、并清掉注释态的 `KEY=` 占位；它**读取并搬运既有值，不写入任何字面量**。`instrumentation.spec.ts:184-208` 用的是 `"good"` / `GOOD` 占位串，CI（`.github/workflows/ci.yml`）自注入。**无风险。**

⚠ 一个已写进代码注释的坑：［实测］`pepper()` 现在是**模块级缓存**（`auth.ts:46`），改 `.env` **不重启不生效**。轮换手册必须写「改 env **+ 重启**」两步，漏第二步是静默失败。

---

## 8. ⑥ GCM 的 2^32 有多远

［实测+推断］上限 4,294,967,296 次（［来源］OWASP KM CS：「limit each key to at most `2^32` … across all devices sharing that key」，转述 SP 800-38D §8.3）。
本仓一次当事人写入 = **2 次** `encryptField`（`id_number` + `contact`），［推断］按「每天个位数写入」取 10 次写入/日 = 20 次/日 ⇒ **4.29e9 ÷ 20 ≈ 2.1e8 日 ≈ 59 万年**；即便放大到 1000 次写入/日（远超本仓）也仍需 ≈ 5900 年。birthday bound 独立算得同一结论（50% 碰撞需 ~2^48 次 IV）。
**结论：不可达。不要为它做任何设计。** 唯一值得做的是在本节留一句「用量未计数，且不需要计数」。

---

## 9. 未核实项

1. **NIST 两份 SP 未读 PDF 原件**——§8.3 的 2^32 与 §5.3.6 的 ≤2 年均引自 OWASP 官方 cheat sheet 与 Vault 官方文档的**转述**，非 `nvlpubs` 原文逐句定位。`research-secret-storage.md` §9 曾做原件抽取，本次未复现。
2. **`mn_party` 实际行数与 `id_number_hash IS NULL` 的存量行数未实测**（无生产库连接）。§5 障碍 1 的严重程度取决于这个数——若回填已完成（该行为 0），则**换 HMAC 零冲突**。
3. **批处理耗时的 82.5s 是导入实测**，非原地 UPDATE 实测；原地只改两列无报告生成，应更快，但**未实测**。
4. **`decryptField` 无 fallback 一节只核对了 `field-crypto.ts` 本体**，未逐一枚举全部调用点确认无人外层吞异常；`deploy/README.md:129` 记录的「详情页 500」与之一致，但**未跑起来复现**。
5. **生产部署形态未验证**（沿用 `research-secret-storage.md` §9 未核实项 1）：`docker compose up` 从未跑过，故「重启即可生效」「单进程」等结论仅在仓库配置契约内成立。
6. **`revred-parties.mjs` 等 `agent-work/` 一次性脚本是否曾在生产库上执行过、留下了何种状态的哈希行，未核实。**