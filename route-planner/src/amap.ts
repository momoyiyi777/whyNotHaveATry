import axios from 'axios';
import { getApiKey } from './config.js';
import type { LatLng, MetroStation, DrivingSegment, TransitSegment, TransitStep } from './types.js';

const AMAP_BASE = 'https://restapi.amap.com/v3';

/** 简单限流器：控制并发数 + 请求间隔 */
class RateLimiter {
  private running = 0;
  private lastTime = 0;
  private queue: (() => void)[] = [];

  constructor(
    private maxConcurrent: number,
    private minIntervalMs: number,
    private maxRetries: number,
  ) {}

  async run<T>(fn: () => Promise<T>, retry = 0): Promise<T> {
    while (this.running >= this.maxConcurrent) {
      await new Promise<void>(resolve => this.queue.push(resolve));
    }
    this.running++;

    try {
      const now = Date.now();
      const wait = this.minIntervalMs - (now - this.lastTime);
      if (wait > 0) {
        await new Promise(resolve => setTimeout(resolve, wait));
      }
      this.lastTime = Date.now();
      return await fn();
    } catch (e: any) {
      // 限流错误自动重试
      if (this.maxRetries > retry && e.message?.includes('CUQPS_HAS_EXCEEDED_THE_LIMIT')) {
        this.running--;
        const next = this.queue.shift();
        if (next) next();
        await new Promise(resolve => setTimeout(resolve, 1500));
        return this.run(fn, retry + 1);
      }
      throw e;
    } finally {
      this.running--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

const amapLimiter = new RateLimiter(1, 800, 2); // 单并发，间隔800ms，最多重试2次

/** 地理编码：地址 → 坐标 */
export async function geocode(address: string): Promise<LatLng> {
  return amapLimiter.run(async () => {
    const key = getApiKey();
    const res = await axios.get(`${AMAP_BASE}/geocode/geo`, {
      params: { key, address, city: '北京' },
    });
    if (res.data.status !== '1' || !res.data.geocodes?.length) {
      throw new Error(`地理编码失败: ${address}，${res.data.info}`);
    }
    const [lng, lat] = res.data.geocodes[0].location.split(',');
    return { lat: parseFloat(lat), lng: parseFloat(lng) };
  });
}

/** 周边搜索：找附近的地铁站 */
export async function searchMetroStations(
  coords: LatLng,
  radius: number = 5000,
  limit: number = 10
): Promise<MetroStation[]> {
  return amapLimiter.run(async () => {
    const key = getApiKey();
    const res = await axios.get(`${AMAP_BASE}/place/around`, {
      params: {
        key,
        location: `${coords.lng},${coords.lat}`,
        radius,
        types: '地铁站',
        offset: limit,
        page: 1,
        extensions: 'all',
      },
    });

    if (res.data.status !== '1') {
      throw new Error(`周边搜索失败: ${res.data.info}`);
    }

    const pois = res.data.pois ?? [];
    return pois.map((poi: any) => {
      const [lng, lat] = poi.location.split(',');
      const lines: string[] = [];
      if (poi.business_area) {
        lines.push(poi.business_area);
      }
      return {
        name: poi.name,
        address: poi.address ?? '',
        coords: { lat: parseFloat(lat), lng: parseFloat(lng) },
        distance: parseInt(poi.distance ?? '0'),
        lines,
      };
    });
  });
}

/** 驾车路径规划（用于打车段） */
export async function drivingRoute(
  from: LatLng,
  to: LatLng,
  fromName: string = '',
  toName: string = ''
): Promise<DrivingSegment> {
  return amapLimiter.run(async () => {
    const key = getApiKey();
    const res = await axios.get(`${AMAP_BASE}/direction/driving`, {
      params: {
        key,
        origin: `${from.lng},${from.lat}`,
        destination: `${to.lng},${to.lat}`,
        strategy: 0,
        extensions: 'base',
      },
    });

    if (res.data.status !== '1' || !res.data.route?.paths?.length) {
      throw new Error(`驾车路径规划失败: ${res.data.info}`);
    }

    const path = res.data.route.paths[0];
    const distance = parseInt(path.distance);
    const duration = parseInt(path.duration);

    const cost = estimateRideCost(distance, duration);

    return {
      type: 'driving',
      from: fromName,
      to: toName,
      distance,
      duration,
      cost,
      polyline: path.polyline ?? '',
    };
  });
}

/** 公交路径规划（用于地铁段） */
export async function transitRoute(
  from: LatLng,
  to: LatLng,
  fromName: string = '',
  toName: string = ''
): Promise<TransitSegment> {
  return amapLimiter.run(async () => {
    const key = getApiKey();
    const res = await axios.get(`${AMAP_BASE}/direction/transit/integrated`, {
      params: {
        key,
        origin: `${from.lng},${from.lat}`,
        destination: `${to.lng},${to.lat}`,
        city: '北京',
        cityd: '北京',
        strategy: 0,
        extensions: 'all',
        nightflag: 0,
      },
    });

    if (res.data.status !== '1' || !res.data.route?.transits?.length) {
      throw new Error(`公交路径规划失败: ${res.data.info}`);
    }

    const transit = res.data.route.transits[0];
    const walkingDistance = parseInt(transit.walking_distance ?? '0');
    const totalDistance = parseInt(transit.distance ?? '0');
    const duration = parseInt(transit.duration ?? '0');

    const cost = transit.cost ? parseFloat(transit.cost) : 0;

    const steps: TransitStep[] = [];

    for (const segment of transit.segments ?? []) {
      if (segment.walking?.steps) {
        for (const step of segment.walking.steps) {
          steps.push({
            mode: 'walking',
            from: step.instruction ?? '',
            to: '',
            distance: parseInt(step.distance ?? '0'),
            duration: parseInt(step.duration ?? '0'),
          });
        }
      }

      if (segment.bus?.buslines?.length) {
        const busline = segment.bus.buslines[0];
        const isSubway = busline.type === '地铁' || busline.name?.includes('地铁') ||
                         busline.name?.startsWith('M') || (busline.name?.startsWith('S') && !busline.name?.startsWith('S_'));
        steps.push({
          mode: isSubway ? 'subway' : 'bus',
          from: busline.start_name ?? busline.departure_stop?.name ?? '',
          to: busline.end_name ?? busline.arrival_stop?.name ?? '',
          distance: parseInt(busline.distance ?? '0'),
          duration: parseInt(busline.duration ?? '0'),
          line: busline.name,
          lineType: isSubway ? 'subway' : 'bus',
        });
      }

      if (segment.bus?.buslines?.length) {
        const busline = segment.bus.buslines[0];
        if (busline.departure_stop?.exit?.name) {
          const lastStep = steps[steps.length - 1];
          if (lastStep) {
            lastStep.exitName = busline.departure_stop.exit.name;
          }
        }
      }

      if (segment.exit) {
        if (steps.length > 0) {
          const lastIdx = steps.length - 1;
          for (let i = lastIdx; i >= 0; i--) {
            if (steps[i].mode === 'subway' || steps[i].mode === 'bus') {
              steps[i].exitName = segment.exit.name ?? '';
              break;
            }
          }
        }
      }
    }

    return {
      type: 'transit',
      from: fromName,
      to: toName,
      distance: totalDistance || walkingDistance,
      duration,
      cost,
      steps,
    };
  });
}

// ---------------------------------------------------------------------------
// 网约车计价模型（基于滴滴北京实时用车计价规则）
// ---------------------------------------------------------------------------

interface PeriodPrice {
  baseFare: number;    // 起步价（含3km + 11min）
  perKm: number;       // 里程费 元/km
  perMin: number;      // 时长费 元/分钟
}

interface PeriodRule {
  startH: number;
  startM: number;
  endH: number;
  endM: number;
  price: PeriodPrice;
}

/** 分钟数转成当日分钟偏移 */
function toMin(h: number, m: number): number {
  return h * 60 + m;
}

/** 判断给定时间是否在区间内（含头不含尾）*/
function inRange(h: number, m: number, startH: number, startM: number, endH: number, endM: number): boolean {
  const now = toMin(h, m);
  return now >= toMin(startH, startM) && now < toMin(endH, endM);
}

/** 创建工作日的计价规则表 */
const WORKDAY_RULES: PeriodRule[] = [
  { startH: 0, startM: 0,  endH: 6, endM: 0,  price: { baseFare: 15.85, perKm: 2.27, perMin: 0.65 } },
  { startH: 6, startM: 0,  endH: 7, endM: 0,  price: { baseFare: 15.25, perKm: 1.73, perMin: 0.52 } },
  { startH: 7, startM: 0,  endH: 9, endM: 0,  price: { baseFare: 15.22, perKm: 1.64, perMin: 0.50 } },
  { startH: 9, startM: 0,  endH: 10, endM: 0, price: { baseFare: 15.25, perKm: 1.74, perMin: 0.49 } },
  { startH: 17, startM: 0, endH: 19, endM: 0, price: { baseFare: 15.37, perKm: 1.63, perMin: 0.52 } },
  { startH: 21, startM: 0, endH: 23, endM: 0, price: { baseFare: 15.30, perKm: 1.90, perMin: 0.60 } },
  { startH: 23, startM: 0, endH: 24, endM: 0, price: { baseFare: 15.65, perKm: 2.02, perMin: 0.51 } },
];

/** 创建休息日（周六日及法定节假日）的计价规则表 */
const RESTDAY_RULES: PeriodRule[] = [
  { startH: 0, startM: 0,  endH: 6, endM: 0,  price: { baseFare: 16.05, perKm: 2.15, perMin: 0.65 } },
  { startH: 11, startM: 0, endH: 15, endM: 0, price: { baseFare: 14.95, perKm: 1.51, perMin: 0.36 } },
  { startH: 17, startM: 0, endH: 19, endM: 0, price: { baseFare: 15.72, perKm: 1.56, perMin: 0.40 } },
  { startH: 21, startM: 0, endH: 23, endM: 0, price: { baseFare: 15.70, perKm: 1.79, perMin: 0.60 } },
  { startH: 23, startM: 0, endH: 24, endM: 0, price: { baseFare: 15.84, perKm: 2.25, perMin: 0.54 } },
];

/** 普通时段（默认） */
const DEFAULT_PERIOD: PeriodPrice = { baseFare: 14.58, perKm: 1.40, perMin: 0.27 };
const DEFAULT_PERIOD_REST: PeriodPrice = { baseFare: 14.92, perKm: 1.50, perMin: 0.33 };

/** 判断今天是工作日还是休息日 */
function getDayType(): 'workday' | 'restday' {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  return (day === 0 || day === 6) ? 'restday' : 'workday';
}

/** 查找当前时刻对应的计价规则 */
function findPeriod(h: number, m: number, isRestDay: boolean): PeriodPrice {
  const rules = isRestDay ? RESTDAY_RULES : WORKDAY_RULES;
  for (const r of rules) {
    if (inRange(h, m, r.startH, r.startM, r.endH, r.endM)) {
      return r.price;
    }
  }
  return isRestDay ? DEFAULT_PERIOD_REST : DEFAULT_PERIOD;
}

/** 网约车费用估算（基于滴滴实时用车计价规则） */
function estimateRideCost(distanceMeters: number, durationSeconds: number, dayType?: 'workday' | 'restday'): number {
  const dt = dayType ?? getDayType();
  const now = new Date();
  const period = findPeriod(now.getHours(), now.getMinutes(), dt === 'restday');

  const km = distanceMeters / 1000;
  const minutes = durationSeconds / 60;

  let cost = period.baseFare;                  // 起步价（含3km + 11min）

  if (km > 3) cost += (km - 3) * period.perKm; // 超出里程费
  if (minutes > 11) cost += (minutes - 11) * period.perMin; // 超出时长费

  // 远途费
  const extraKm20 = Math.min(km, 40) - 20;
  if (extraKm20 > 0) cost += extraKm20 * 0.30;
  if (km > 40) cost += (km - 40) * 1.20;

  // 取整到分
  return Math.round(cost * 100) / 100;
}
