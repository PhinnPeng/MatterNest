-- 0022：案件编号改为 `A + YYYYMMDD + 4 位顺序号`（2026-10-23 用户裁定）
--
-- 旧格式 `AJ-YYYYMMDD-NNN`，新格式 `A202610210001`。已有行一起改写：两种格式
-- 混存会让列表按 `internal_code` 的字符串排序错位（`A2026…` 排在 `AJ-…` 之前）。
-- 风险事项的 `FX-` 编号不受影响。
--
-- 三条注意：
--   1. UPDATE 的多个 SET 表达式都读**旧行值**，所以 `case_no = internal_code` 的
--      判定用的是改写前的编号 —— 只改那些「案号留空、自动取内部编号」的行。
--   2. 序号过 9999 后是 4 位以上，`lpad` 会截断（2026-10-15 的事故）。这里先判
--      `length(...) < 4`，必要时才补零。
--   3. 计数器按旧 `AJ` 的 value 原样搬到 `A`，不按数据 max 重算：号可跳不可复，
--      空洞后的下一个号不能被复用。
UPDATE "mn_matter"
SET "case_no" = CASE
      WHEN "case_no" = "internal_code" THEN
        'A' || substr("internal_code", 4, 8) ||
        CASE
          WHEN length(substr("internal_code", 13)) < 4
            THEN lpad(substr("internal_code", 13), 4, '0')
          ELSE substr("internal_code", 13)
        END
      ELSE "case_no"
    END,
    "internal_code" =
      'A' || substr("internal_code", 4, 8) ||
      CASE
        WHEN length(substr("internal_code", 13)) < 4
          THEN lpad(substr("internal_code", 13), 4, '0')
        ELSE substr("internal_code", 13)
      END
WHERE "internal_code" ~ '^AJ-[0-9]{8}-[0-9]+$';--> statement-breakpoint
INSERT INTO "mn_code_seq" ("day_key", "prefix", "value")
SELECT "day_key", 'A', "value" FROM "mn_code_seq" WHERE "prefix" = 'AJ'
ON CONFLICT ("day_key", "prefix") DO UPDATE
SET "value" = GREATEST("mn_code_seq"."value", EXCLUDED."value");--> statement-breakpoint
DELETE FROM "mn_code_seq" WHERE "prefix" = 'AJ';
--> statement-breakpoint
-- DOWN（前滚优先，但人要看得懂丢了什么）：
--   编号是**已发出的业务事实**：审计、通知、导出文件里都留着旧字符串，回退不会把它们改回去。
--   旧格式是 3 位起、溢出后加宽 ⇒ `A2026101510000` 无法判断原本是 `1000` 还是 `10000`，
--   因此**不可逆**。真要回退只能人工按审计记录重排，并把 `A` 计数器搬回 `AJ`：
--     INSERT INTO mn_code_seq (day_key, prefix, value)
--     SELECT day_key, 'AJ', value FROM mn_code_seq WHERE prefix = 'A'
--     ON CONFLICT (day_key, prefix) DO UPDATE SET value = GREATEST(...);
--     DELETE FROM mn_code_seq WHERE prefix = 'A';

