/**
 * vitest setupFiles 入口：在生产用例之前挂上临时目录清理钩子。
 *
 * 单独一个文件是为了让 `vitest.config.ts` 的 setupFiles 指向它、而不是直接
 * 指向 `temp-dir.ts` —— 后者一旦被 setup 之外的入口 import 就会带副作用，
 * 在这里我们只要「注册钩子」这一件事。
 */
import { registerTempDirCleanup } from './temp-dir.js';

// 生成的子 shell 不能受宿主 locale 摆布。宿主若带一个本机没有的 locale
// （macOS 上最常见的 `LC_ALL=C.UTF-8`），bash 每次启动都会往 stderr 打
// 「warning: setlocale: LC_ALL: cannot change locale」——这条噪声会污染所有
// 「按字节断言 shell 输出」和「按事件序号断言 bash 事件流」的用例
// （2026-10-08 两条 anchor：bash-exit-cleanup、kimi terminal truncated）。
// 只删 LC_ALL：LC_CTYPE / LANG 保留给 UTF-8 编码解析，删多了会让非 ASCII
// 输出退化。
delete process.env.LC_ALL;

registerTempDirCleanup();
