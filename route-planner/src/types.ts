/** 坐标点 */
export interface LatLng {
  lat: number;
  lng: number;
}

/** 地址或坐标输入 */
export interface LocationInput {
  address: string;
  coords?: LatLng;
}

/** 地铁站信息 */
export interface MetroStation {
  name: string;
  address: string;
  coords: LatLng;
  /** 到起终点的直线距离（米） */
  distance: number;
  /** 所在线路名称 */
  lines: string[];
}

/** 步行段规划结果 */
export interface WalkingSegment {
  type: 'walking';
  from: string;
  to: string;
  distance: number;     // 米
  duration: number;     // 秒
  cost: number;         // 0
}

/** 驾车段规划结果 */
export interface DrivingSegment {
  type: 'driving';
  from: string;
  to: string;
  distance: number;     // 米
  duration: number;     // 秒
  cost: number;         // 预估价格（元）
  polyline?: string;
}

/** 公共交通段规划结果 */
export interface TransitSegment {
  type: 'transit';
  from: string;
  to: string;
  distance: number;     // 米
  duration: number;     // 秒
  cost: number;         // 票价（元）
  steps: TransitStep[];
}

export interface TransitStep {
  mode: 'walking' | 'subway' | 'bus';
  from: string;
  to: string;
  distance: number;
  duration: number;
  line?: string;        // 地铁或公交线路名
  lineType?: string;    // 'subway' | 'bus'
  exitName?: string;    // 地铁出口
}

/** 完整路线方案 */
export interface RoutePlan {
  segments: (DrivingSegment | TransitSegment | WalkingSegment)[];
  totalDistance: number;
  totalDuration: number;
  totalCost: number;
  description: string;
}

/** 路线规划请求 */
export interface RouteRequest {
  origin: LocationInput;
  destination: LocationInput;
  /** 打车段最大距离（米），默认 5000 */
  maxTaxiDistance?: number;
  /** 最大结果数 */
  maxResults?: number;
}

/** 路线规划结果 */
export interface RouteResult {
  origin: LocationInput;
  destination: LocationInput;
  /** 纯公共交通方案（基线） */
  pureTransit: RoutePlan | null;
  /** 纯打车方案（基线） */
  pureDriving: RoutePlan | null;
  /** 混合路线方案列表 */
  mixedRoutes: RoutePlan[];
}
