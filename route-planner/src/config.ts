import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

export function getApiKey(): string {
  const key = process.env.AMAP_API_KEY;
  if (!key || key === 'your_api_key_here') {
    console.error('\n❌ 未配置高德地图 API Key');
    console.error('   1. 前往 https://lbs.amap.com/dev/key/app 申请 Web 服务 API Key');
    console.error('   2. 复制 .env.example 为 .env');
    console.error('   3. 在 .env 中填入你的 Key\n');
    process.exit(1);
  }
  return key;
}
