/**
 * 已迁移到平台 seam：`src/platform/terminator-posix.ts`（design.md §3.2）。
 *
 * 本文件只保留 re-export，使既有调用方（bash runner、jsonrpc transport 等）
 * 与既有测试不受影响；M2 调用点迁移时逐个换成 `createTerminator()` 后删除。
 */
export { ProcessStopper } from '../../platform/terminator-posix.js';
