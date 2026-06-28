/**
 * 多服务契约模型 (design §11.2 / §11.4, 单服务 run 不涉及; zod 版, 等价 Python
 * `loop_engineering/schema/service_contracts.py`)。
 *
 * 规范源: design §11.2 (service-contracts.yaml 契约一等建模)、§11.4 (service-map.yaml 多 repo 映射)。
 *
 * 与 Pydantic 的差异处理:
 * - Python `_check_id_uniqueness` model_validator → zod `.superRefine` 检测重复 id,
 *   错误信息内嵌重复 id (与 Python `f"...{sorted(set(dup))}"` 同样可被测试断言命中)。
 * - `ServiceMapEntry` 的 `extra="allow"` → zod `.passthrough()` (保留未知字段)。
 * - 真实键 `schema` 默认值复刻 Python `schema_` 的 alias 默认。
 */
import { z } from "zod";

/**
 * 单个跨服务契约 (design §11.2)。
 * id 如 C-auth-token; provider/consumers 是 service name; surface 描述 API / 消息 / 共享类型。
 */
export const ContractSchema = z.object({
  id: z.string(),
  provider: z.string(),
  consumers: z.array(z.string()),
  surface: z.string(),
  acceptance_refs: z.array(z.string()).default([]),
  integration_cases: z.array(z.string()).default([]),
});
export type Contract = z.infer<typeof ContractSchema>;

/**
 * planning/service-contracts.yaml 模型 (design §11.2)。
 * 把跨服务接口显式登记, 防契约漂移。contract id 唯一。
 * 真实键 `schema` 默认 "loop-engineering.service-contracts.v1"。
 */
export const ServiceContractsSchema = z
  .object({
    schema: z.string().default("loop-engineering.service-contracts.v1"),
    contracts: z.array(ContractSchema),
  })
  .superRefine((sc, ctx) => {
    // contract id 必须唯一 (等价 Python _check_id_uniqueness)。
    const seen = new Set<string>();
    const dup: string[] = [];
    for (const c of sc.contracts) {
      if (seen.has(c.id)) {
        dup.push(c.id);
      }
      seen.add(c.id);
    }
    if (dup.length > 0) {
      const uniqueSorted = [...new Set(dup)].sort();
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contracts"],
        message: `contract id 重复 (design §11.2): ${JSON.stringify(uniqueSorted)}`,
      });
    }
  });
export type ServiceContracts = z.infer<typeof ServiceContractsSchema>;

/**
 * service → worktree 物理路径映射 (design §11.4)。
 * `.passthrough()` (≈ Pydantic extra="allow"): 允许未来加字段 (例如 lockfile 路径、构建命令)。
 */
export const ServiceMapEntrySchema = z
  .object({
    worktree: z.string(),
  })
  .passthrough();
export type ServiceMapEntry = z.infer<typeof ServiceMapEntrySchema>;

/**
 * planning/service-map.yaml 模型 (design §11.4)。
 * 多 repo 时把 service 落到物理树; monorepo 下 §11.1 的 service:path 已足够, 不用此文件。
 * 去掉了旧版 worktree-binding 的防伪 attestation。
 * 真实键 `schema` 默认 "loop-engineering.service-map.v1"。
 */
export const ServiceMapSchema = z.object({
  schema: z.string().default("loop-engineering.service-map.v1"),
  services: z.record(z.string(), ServiceMapEntrySchema).default({}),
});
export type ServiceMap = z.infer<typeof ServiceMapSchema>;

/** 解析并校验 service-contracts 数据 (对齐 Python `model_validate`)。 */
export function parseServiceContracts(data: unknown): ServiceContracts {
  return ServiceContractsSchema.parse(data);
}

/** 解析并校验 service-map 数据 (对齐 Python `model_validate`)。 */
export function parseServiceMap(data: unknown): ServiceMap {
  return ServiceMapSchema.parse(data);
}
