/**
 * vitest setupFiles 入口：在生产用例之前挂上临时目录清理钩子。
 *
 * 单独一个文件是为了让 `vitest.config.ts` 的 setupFiles 指向它、而不是直接
 * 指向 `temp-dir.ts` —— 后者一旦被 setup 之外的入口 import 就会带副作用，
 * 在这里我们只要「注册钩子」这一件事。
 */
import { registerTempDirCleanup } from './temp-dir.js';

registerTempDirCleanup();
