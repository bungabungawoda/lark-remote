import { registerApp } from '@larksuite/channel';
import qrcode from 'qrcode-terminal';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { AppConfigSchema } from './index.js';

interface WizardResult {
  appId: string;
  appSecret: string;
}

/**
 * Run the QR-code registration wizard. The user scans the QR with their
 * Feishu/Lark app to create a new application; the SDK polls until the
 * creation completes and returns the credentials.
 */
async function runRegistrationWizard(): Promise<WizardResult> {
  console.log('\n[lark-remote] 未检测到飞书应用配置，进入扫码创建向导。\n');

  const result = await registerApp({
    source: 'lark-remote',
    onQRCodeReady: (info) => {
      console.log('请用飞书 App 扫描以下二维码完成应用创建：\n');
      qrcode.generate(info.url, { small: true });
      const mins = Math.max(1, Math.round(info.expireIn / 60));
      console.log(`\n二维码有效期：约 ${mins} 分钟`);
      console.log(`也可以直接在浏览器打开：${info.url}\n`);
    },
    onStatusChange: (info) => {
      if (info.status === 'domain_switched') {
        console.log('识别到国际版租户，已切换到 larksuite.com 域名。');
      } else if (info.status === 'slow_down') {
        console.log('轮询速度过快，已自动降速。');
      }
    },
  });

  console.log('\n✓ 应用创建成功');
  console.log(`  App ID:  ${result.client_id}`);
  if (result.user_info?.tenant_brand) {
    console.log(`  Tenant:  ${result.user_info.tenant_brand}`);
  }
  console.log('');

  return { appId: result.client_id, appSecret: result.client_secret };
}

function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** True when the config file already has non-empty feishu credentials. */
function hasFeishuCredentials(configPath: string): boolean {
  if (!fs.existsSync(configPath)) return false;
  let parsed: unknown;
  try {
    parsed = YAML.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return false;
  }
  const feishu = (parsed as { feishu?: { appId?: string; appSecret?: string } } | null)?.feishu;
  return Boolean(feishu && feishu.appId && feishu.appSecret);
}

/** Persist a full config file seeded with the given feishu credentials. */
function writeConfigWithCredentials(configPath: string, appId: string, appSecret: string): void {
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  const config = AppConfigSchema.parse({ feishu: { appId, appSecret } });
  fs.writeFileSync(configPath, YAML.stringify(config), 'utf-8');
}

/**
 * Ensure a usable config exists before `loadConfig` is called.
 *
 * - If credentials are already present, do nothing.
 * - In an interactive terminal with missing credentials, run the QR-code
 *   registration wizard and write the resulting credentials back to the
 *   config file so startup can proceed.
 * - In a non-interactive context, do nothing here; `loadConfig` will then
 *   generate its template and exit with instructions (preserving the
 *   original behavior for tests and headless setups).
 */
export async function ensureConfig(configPath: string): Promise<void> {
  if (hasFeishuCredentials(configPath)) return;

  if (!isInteractiveTerminal()) return;

  const { appId, appSecret } = await runRegistrationWizard();
  writeConfigWithCredentials(configPath, appId, appSecret);
  console.log(`[lark-remote] 凭证已写入 ${configPath}，继续启动...\n`);
}
