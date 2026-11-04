/**
 * DSH 服务端目录探测（/config 卡片动态清单用）。
 *
 * 接口只声明卡片预取需要的三个 RPC 方法；具体传输客户端的构造（含 token
 * 解析路径）收在本模块——router 只依赖接口，不持有 DshClient。
 */
import type {
  DshModelCatalogValue,
  DshPermissionCatalogValue,
  DshPresetListValue,
} from '../../dsh/types.js';
import { DshClient } from './client.js';

/** 卡片预取只依赖的 client 方法子集。 */
export interface DshCatalogClient {
  listModels(): Promise<DshModelCatalogValue>;
  listPresets(): Promise<DshPresetListValue>;
  listPermissionPresets(): Promise<DshPermissionCatalogValue>;
}

/** 目录预取客户端工厂类型（测试注入 fake 用）。 */
export type DshCatalogClientFactory = (
  baseUrl: string,
  token?: string,
  credentialsFile?: string,
) => DshCatalogClient;

/** 生产实现：卡片预取是交互路径，DSH 卡死时最多等 5 秒后回退固定清单。 */
export function createDshCatalogClient(
  baseUrl: string,
  token?: string,
  credentialsFile?: string,
): DshCatalogClient {
  return new DshClient(baseUrl, {
    token,
    credentialsFile,
    requestTimeoutMs: 5_000,
  });
}
