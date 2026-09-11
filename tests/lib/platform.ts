/**
 * 平台门控测试 helper。
 *
 * 规则：现有「行为与 OS 无关」的测试不 skip；只有明确依赖 POSIX 原语的用例
 * （负 PID 组杀、sh wrapper fixture、真实 bash）才用 describePosix 门控。
 * win32-only 用例（CI windows job 中运行）用 describeWin32。
 *
 * 注意：mock 全部 OS 原语（如 spyOn(process,'kill')）的测试在任意宿主都能跑，
 * 不需要门控。
 */
import { describe } from 'vitest';
import { currentPlatform, isWin32 } from '../../src/platform/select.js';

/** 仅在非 Windows 宿主运行（依赖 POSIX 原语：进程组信号、bash、ps 等）。 */
export const describePosix = isWin32(currentPlatform) ? describe.skip : describe;

/** 仅在 Windows 宿主运行（供未来 CI windows job 使用）。 */
export const describeWin32 = isWin32(currentPlatform) ? describe : describe.skip;
