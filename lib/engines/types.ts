// Common engine abstraction

export type EngineId =
  | "shaka"
  | "dashjs"
  | "hlsjs"
  | "native"
  | "avplayer"
  | "exoplayer";

export type LogType =
  | "info"
  | "abr"
  | "buffer"
  | "error"
  | "drm"
  | "warn"
  | "scte";

export type PlayerState =
  | "idle"
  | "loading"
  | "playing"
  | "buffering"
  | "paused"
  | "error";

export type DrmSystem = "widevine" | "playready" | "fairplay";

export interface Metrics {
  join: number | null;
  bufN: number;
  bufMs: number;
  bitrate: number;
  bw: number;
  latency: number | null;
  dropped: number;
  state: PlayerState;
}

export interface DrmConfig {
  enabled: boolean;
  system: DrmSystem;
  licenseUrl: string;
  certUrl: string;
  headers: Record<string, string>;
}

export interface AdvancedConfig {
  /** Shaka: run with default config like the SmartTV app (no streaming tuning). */
  matchTv: boolean;
  bufferGoal: number;
  rebufferGoal: number;
  audioLang: string;
  returnToLiveWindow: boolean;
  stalledMinDuration: number;
}

export interface NetOverrides {
  origin: string;
  referer: string;
  userAgent: string;
}

export interface LoadConfig {
  url: string;
  version: string; // CDN version string for the engine
  drm: DrmConfig;
  advanced: AdvancedConfig;
  net: NetOverrides;
  /** Emulated navigator.userAgent (Shaka platform detection). "" = no emulation. */
  deviceUserAgent: string;
}

// ── UI-level types (editable form state) ──

export interface HeaderPair {
  id: number;
  key: string;
  value: string;
}

export interface UiDrmConfig {
  enabled: boolean;
  system: DrmSystem;
  licenseUrl: string;
  certUrl: string;
  headers: HeaderPair[];
}

/** Full per-panel configuration held in the UI. */
export interface PanelConfig {
  engine: EngineId;
  version: string;
  url: string;
  drm: UiDrmConfig;
  advanced: AdvancedConfig;
  net: NetOverrides;
  deviceUserAgent: string;
}

/** Convert editable UI config into the engine-facing LoadConfig. */
export function toLoadConfig(cfg: PanelConfig): LoadConfig {
  const headers: Record<string, string> = {};
  for (const h of cfg.drm.headers) {
    const k = h.key.trim();
    if (k) headers[k] = h.value.trim();
  }
  return {
    url: cfg.url.trim(),
    version: cfg.version,
    drm: {
      enabled: cfg.drm.enabled,
      system: cfg.drm.system,
      licenseUrl: cfg.drm.licenseUrl.trim(),
      certUrl: cfg.drm.certUrl.trim(),
      headers,
    },
    advanced: cfg.advanced,
    net: {
      origin: cfg.net.origin.trim(),
      referer: cfg.net.referer.trim(),
      userAgent: cfg.net.userAgent.trim(),
    },
    deviceUserAgent: cfg.deviceUserAgent.trim(),
  };
}

export type NetworkKind =
  | "manifest"
  | "segment"
  | "init"
  | "license"
  | "other";

export interface NetworkEntry {
  time: Date;
  kind: NetworkKind;
  mediaType?: string; // video | audio | text
  url: string;
  bytes?: number;
  durationMs?: number;
  /** Headers the proxy actually injected on this request (echoed back). */
  sent?: { origin?: string; referer?: string; userAgent?: string };
}

/** A manifest received by an engine (raw text, or serialized parsed model). */
export interface EngineManifest {
  text: string;
  format?: "dash" | "hls" | "smooth" | "unknown";
  periodCount?: number;
  note?: string;
  bytes?: number;
}

export interface EngineCallbacks {
  onLog(type: LogType, msg: string): void;
  onAbr(
    prevBps: number,
    currBps: number,
    dims?: { w?: number; h?: number }
  ): void;
  onMetrics(patch: Partial<Metrics>): void;
  onState(state: PlayerState): void;
  onNetwork(entry: NetworkEntry): void;
  onManifest(m: EngineManifest): void;
}

export interface EngineController {
  load(video: HTMLVideoElement, cfg: LoadConfig): Promise<void>;
  destroy(): void;
}

export type EngineFactory = (cb: EngineCallbacks) => EngineController;
