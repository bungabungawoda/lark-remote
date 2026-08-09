/**
 * P1-20 anchor: parseCliArgs must not swallow the flag following --config-dir
 *
 * The --config-dir branch does `args[++i]` to read its candidate value BEFORE
 * checking whether it is a flag; when the next arg starts with `--` it is
 * consumed and discarded, and `i` is never rolled back — the following flag
 * (and its own value) are silently dropped from parsing.
 *
 * review.md §P1-20: "parseCliArgs(['--config-dir','--settings','/tmp/s.json'])
 * → {}（settings 整个丢失）；parseCliArgs(['--config-dir','--help']) → {}
 * （help 被吞，进程正常启动 bridge 而不是打印帮助）。修复建议：不匹配时 i-- 回退。"
 */
import { describe, it, expect } from 'vitest';
import { parseCliArgs } from '../../../src/config/dir.js';

describe('P1-20 parseCliArgs flag consumption', () => {
  it('test_anchor_parse_cli_args_does_not_swallow_following_flag', () => {
    // ① 验证什么行为：--config-dir 后紧跟另一个合法 flag 时，该 flag 必须继续
    //    参与解析（及其值不被吞）；--config-dir 只在后项是普通值时消费它。
    // ② 缺失/错误会导致什么：--settings 丢失会静默改变 Claude 行为（配置路径
    //    不生效），--help 被吞则进程正常启动 bridge 而非打印帮助——用户参数被
    //    静默忽略且排查困难。
    // ③ 依据：review.md §P1-20 失败用例原文（已实测：当前返回 {}）。
    expect(parseCliArgs(['--config-dir', '--settings', '/tmp/s.json'])).toEqual({
      settings: '/tmp/s.json',
    });
    expect(parseCliArgs(['--config-dir', '--help'])).toEqual({ help: true });
    // 正常值路径不受影响
    expect(parseCliArgs(['--config-dir', '/tmp/cfg'])).toEqual({ configDir: '/tmp/cfg' });
  });
});
