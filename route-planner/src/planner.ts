import {
  geocode, searchMetroStations, drivingRoute, transitRoute,
} from './amap.js';
import type {
  LatLng, MetroStation, RouteRequest, RoutePlan, RouteResult,
  DrivingSegment, TransitSegment, WalkingSegment,
} from './types.js';

/** 步行速度 5km/h */
const WALKING_SPEED = 1.39; // m/s

/** 短距离阈值：<= 1km 时步行代替打车 */
const WALK_THRESHOLD = 1000;

/** 步行段估算 */
function walkingSegment(from: string, to: string, distanceMeters: number): WalkingSegment {
  return {
    type: 'walking',
    from, to,
    distance: distanceMeters,
    duration: Math.round(distanceMeters / WALKING_SPEED),
    cost: 0,
  };
}

/** 将短距离打车换成步行 */
async function resolveFirstMile(
  from: LatLng, to: LatLng,
  fromName: string, toName: string,
): Promise<DrivingSegment | WalkingSegment> {
  const drive = await drivingRoute(from, to, fromName, toName);
  if (drive.distance <= WALK_THRESHOLD) {
    return walkingSegment(fromName, toName, drive.distance);
  }
  return drive;
}

/** 帕累托前沿筛选：去掉被其他方案同时在时间和价格上碾压的方案 */
function paretoFilter(routes: RoutePlan[]): RoutePlan[] {
  return routes.filter((a, i) => {
    for (let j = 0; j < routes.length; j++) {
      if (i === j) continue;
      const b = routes[j];
      // b 在时间上不比 a 差，价格上不比 a 差，且至少一项严格优于 a → a 被 b 支配
      if (
        b.totalDuration <= a.totalDuration &&
        b.totalCost <= a.totalCost &&
        (b.totalDuration < a.totalDuration || b.totalCost < a.totalCost)
      ) {
        return false; // a 被支配，淘汰
      }
    }
    return true; // a 不被任何方案支配
  });
}

/** 主入口：规划混合路线 */
export async function planRoute(req: RouteRequest): Promise<RouteResult> {
  const maxTaxiDist = req.maxTaxiDistance ?? 5000;
  const maxResults = req.maxResults ?? 5;

  // 1. 解析坐标
  const originCoords = req.origin.coords ?? await geocode(req.origin.address);
  const destCoords = req.destination.coords ?? await geocode(req.destination.address);

  // 2. 并行获取基线 + 地铁站
  const [pureTransit, pureDriving, stationsA, stationsB] = await Promise.all([
    getPureTransit(originCoords, destCoords, req.origin.address, req.destination.address),
    getPureDriving(originCoords, destCoords, req.origin.address, req.destination.address),
    searchMetroStations(originCoords, maxTaxiDist, 8),
    searchMetroStations(destCoords, maxTaxiDist, 8),
  ]);

  const topA = stationsA.sort((a, b) => a.distance - b.distance).slice(0, 5);
  const topB = stationsB.sort((a, b) => a.distance - b.distance).slice(0, 5);

  // 3. 两种混合模式
  const promises: Promise<RoutePlan | null>[] = [];

  // 模式1: 打车→地铁
  for (const sa of topA) {
    promises.push(computeTaxiThenMetro(originCoords, destCoords, sa, req.origin.address, req.destination.address));
  }

  // 模式2: 地铁→打车
  for (const sb of topB) {
    promises.push(computeMetroThenTaxi(originCoords, destCoords, sb, req.origin.address, req.destination.address));
  }

  const mixedResults = await Promise.all(promises);

  // 4. 帕累托前沿筛选：加入两条基线 + 所有混合方案
  const allCandidates = [
    pureTransit,
    pureDriving,
    ...mixedResults,
  ].filter((r): r is RoutePlan => r !== null);

  const paretoRoutes = paretoFilter(allCandidates);
  // 按时间升序展示（用户从左往右看时间-价格权衡）
  paretoRoutes.sort((a, b) => a.totalDuration - b.totalDuration);

  return {
    origin: req.origin,
    destination: req.destination,
    pureTransit,
    pureDriving,
    mixedRoutes: paretoRoutes,
  };
}

/** 模式1：打车 → 地铁  （打车到最近地铁站，然后地铁到终点） */
async function computeTaxiThenMetro(
  origin: LatLng, dest: LatLng,
  station: MetroStation,
  originName: string, destName: string,
): Promise<RoutePlan | null> {
  try {
    const firstLeg = await resolveFirstMile(origin, station.coords, originName, station.name);
    const transit = await transitRoute(station.coords, dest, station.name, destName);

    const hasSubway = transit.steps.some(s => s.mode === 'subway');
    if (!hasSubway) return null;

    const totalDist = firstLeg.distance + transit.distance;
    const totalDur = firstLeg.duration + transit.duration;
    const totalCost = firstLeg.cost + transit.cost;

    const legIcon = firstLeg.type === 'walking' ? '🚶' : '🚕';

    return {
      segments: [firstLeg, transit],
      totalDistance: totalDist,
      totalDuration: totalDur,
      totalCost: totalCost,
      description: `${legIcon}→🚇  ${station.name} → ${destName}`,
    };
  } catch {
    return null;
  }
}

/** 模式2：地铁 → 打车  （步行到地铁站，地铁到B附近，打车到终点） */
async function computeMetroThenTaxi(
  origin: LatLng, dest: LatLng,
  station: MetroStation,
  originName: string, destName: string,
): Promise<RoutePlan | null> {
  try {
    const transit = await transitRoute(origin, station.coords, originName, station.name);

    const hasSubway = transit.steps.some(s => s.mode === 'subway');
    if (!hasSubway) return null;

    const lastLeg = await resolveFirstMile(station.coords, dest, station.name, destName);

    const totalDist = transit.distance + lastLeg.distance;
    const totalDur = transit.duration + lastLeg.duration;
    const totalCost = transit.cost + lastLeg.cost;

    const legIcon = lastLeg.type === 'walking' ? '🚶' : '🚕';

    return {
      segments: [transit, lastLeg],
      totalDistance: totalDist,
      totalDuration: totalDur,
      totalCost: totalCost,
      description: `🚇→${legIcon}  ${originName} → ${station.name}`,
    };
  } catch {
    return null;
  }
}

/** 纯公共交通路线 */
async function getPureTransit(
  from: LatLng, to: LatLng,
  fromName: string, toName: string,
): Promise<RoutePlan | null> {
  try {
    const transit = await transitRoute(from, to, fromName, toName);
    return {
      segments: [transit],
      totalDistance: transit.distance,
      totalDuration: transit.duration,
      totalCost: transit.cost,
      description: `🚌 全程公共交通`,
    };
  } catch {
    return null;
  }
}

/** 纯打车路线 */
async function getPureDriving(
  from: LatLng, to: LatLng,
  fromName: string, toName: string,
): Promise<RoutePlan | null> {
  try {
    const drive = await drivingRoute(from, to, fromName, toName);
    return {
      segments: [drive],
      totalDistance: drive.distance,
      totalDuration: drive.duration,
      totalCost: drive.cost,
      description: `🚕 全程打车`,
    };
  } catch {
    return null;
  }
}
