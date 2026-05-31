import readline from 'readline';
import { planRoute } from './planner.js';
import type { RoutePlan, DrivingSegment, TransitSegment, WalkingSegment } from './types.js';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

/** 格式化时长（秒 → 小时+分钟） */
function fmtTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}小时${m}分钟`;
  return `${m}分钟`;
}

/** 格式化距离（米 → 公里） */
function fmtDist(meters: number): string {
  const km = meters / 1000;
  return km >= 1 ? `${km.toFixed(1)}公里` : `${Math.round(meters)}米`;
}

function formatDrivingSegment(s: DrivingSegment): string {
  return `    打车  ${s.from} → ${s.to}  ${fmtDist(s.distance)} / ${fmtTime(s.duration)} / 约${s.cost.toFixed(0)}元`;
}

function formatWalkingSegment(s: WalkingSegment): string {
  return `    步行  ${s.from} → ${s.to}  ${fmtDist(s.distance)} / ${fmtTime(s.duration)}`;
}

function formatTransitSummary(s: TransitSegment): string {
  const subwaySteps = s.steps.filter(st => st.mode === 'subway');
  const walkSteps = s.steps.filter(st => st.mode === 'walking');
  const walkDist = walkSteps.reduce((sum, st) => sum + st.distance, 0);
  const lines = [...new Set(subwaySteps.map(st => st.line).filter(Boolean))];
  return `    地铁  ${s.from} → ${s.to}  ${fmtDist(s.distance)} / ${fmtTime(s.duration)} / ￥${s.cost.toFixed(0)}`
    + (lines.length ? ` [${lines.join(' → ')}]` : '')
    + (walkDist > 0 ? ` (步行${fmtDist(walkDist)})` : '');
}

function formatTransitSteps(s: TransitSegment): string {
  const lines: string[] = [];
  for (const step of s.steps) {
    if (step.mode === 'subway') {
      lines.push(`       🚇 乘坐${step.line}  ${step.from} → ${step.to}${step.exitName ? `（${step.exitName}口出）` : ''}`);
    } else if (step.mode === 'bus') {
      lines.push(`       🚌 乘坐${step.line}  ${step.from} → ${step.to}`);
    } else if (step.mode === 'walking' && step.distance > 100) {
      lines.push(`       🚶 步行${fmtDist(step.distance)}`);
    }
  }
  return lines.join('\n');
}

function displayRoute(plan: RoutePlan, index: number) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(` 方案${index}: ${plan.description}`);
  console.log(` 总计: ${fmtTime(plan.totalDuration)} | ${fmtDist(plan.totalDistance)} | ￥${plan.totalCost.toFixed(0)}`);
  console.log(` ${'-'.repeat(56)}`);

  for (const seg of plan.segments) {
    if (seg.type === 'driving') {
      console.log(formatDrivingSegment(seg));
    } else if (seg.type === 'walking') {
      console.log(formatWalkingSegment(seg));
    } else if (seg.type === 'transit') {
      console.log(formatTransitSummary(seg));
      const details = formatTransitSteps(seg);
      if (details) console.log(details);
    }
  }
}

async function main() {
  console.log(`
╔══════════════════════════════════════════════╗
║         🚇 混合路线规划器 v0.1              ║
║      打车 + 地铁 混合路线最优方案            ║
╚══════════════════════════════════════════════╝
`);

  // 支持命令行参数：npx tsx src/index.ts "起点" "终点"
  const args = process.argv.slice(2);
  let origin: string, dest: string;
  if (args.length >= 2) {
    origin = args[0];
    dest = args[1];
  } else {
    origin = await ask('📍 起点地址: ');
    dest = await ask('📍 终点地址: ');
  }

  console.log('\n🔄 正在规划路线，请稍候...\n');

  try {
    const result = await planRoute({
      origin: { address: origin },
      destination: { address: dest },
      maxTaxiDistance: 5000,
      maxResults: 5,
    });

    if (result.mixedRoutes.length === 0) {
      console.log('\n⚠️  未找到合适的混合路线方案。');
      console.log('   可能原因：');
      console.log('   - 起点或终点附近没有地铁站');
      console.log('   - API Key 配置有误');
    } else {
      // 帕累托前沿总览
      const fastest = result.mixedRoutes[0];
      const cheapest = result.mixedRoutes.reduce((a, b) => a.totalCost <= b.totalCost ? a : b);

      console.log(`\n📊 帕累托前沿（时间 ↔ 价格 权衡）`);
      console.log(` ${'-'.repeat(60)}`);
      console.log(` ${'方案'.padEnd(36)} ${'时间'.padStart(10)} ${'价格'.padStart(10)}`);
      console.log(` ${'-'.repeat(60)}`);
      for (const r of result.mixedRoutes) {
        const label = r.description.padEnd(36);
        console.log(` ${label} ${fmtTime(r.totalDuration).padStart(10)} ${(`￥${r.totalCost.toFixed(0)}`).padStart(10)}`);
      }
      console.log(` ${'-'.repeat(60)}`);

      // 高亮极端值
      if (fastest.totalDuration < cheapest.totalDuration) {
        console.log(` ⚡ 最快:  ${fastest.description}  — ${fmtTime(fastest.totalDuration)} ￥${fastest.totalCost.toFixed(0)}`);
      }
      if (cheapest.totalCost < fastest.totalCost) {
        console.log(` 💰 最省:  ${cheapest.description}  — ${fmtTime(cheapest.totalDuration)} ￥${cheapest.totalCost.toFixed(0)}`);
      }

      // 详情
      console.log(`\n🏆 各方案详情`);
      result.mixedRoutes.forEach((route, i) => displayRoute(route, i + 1));
    }
  } catch (err: any) {
    console.error('\n❌ 规划失败:', err.message ?? err);
  }

  rl.close();
}

main();
