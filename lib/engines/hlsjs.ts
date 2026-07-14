import { loadLib } from "./loaders";
import { autoplay } from "./autoplay";
import { hasNetOverrides, proxifyUrl } from "@/lib/proxy";
import type { EngineCallbacks, EngineController, LoadConfig } from "./types";

export function createHlsjs(cb: EngineCallbacks): EngineController {
  let hls: any = null;
  let Hls: any = null;
  let statsIv: ReturnType<typeof setInterval> | null = null;
  let curBitrate = 0;

  async function load(video: HTMLVideoElement, cfg: LoadConfig) {
    cb.onLog("info", `Loading hls.js ${cfg.version} (bundled)…`);
    Hls = await loadLib("hlsjs", cfg.version);

    if (!Hls.isSupported()) {
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        cb.onLog("info", "Using native HLS (Safari)");
        video.src = proxifyUrl(cfg.url, cfg.net);
        video.load();
        await autoplay(video, cb.onLog);
        return;
      }
      cb.onLog("error", "HLS not supported in this browser");
      cb.onState("error");
      throw new Error("HLS not supported");
    }

    const hlsCfg: any = {
      maxBufferLength: cfg.advanced.bufferGoal || 30,
      maxMaxBufferLength: 120,
      startLevel: -1,
      enableWorker: true,
    };

    // Route all requests (playlists, fragments, keys) through the proxy to
    // inject Origin / Referer / User-Agent headers.
    if (hasNetOverrides(cfg.net)) {
      const Base = Hls.DefaultConfig.loader;
      class ProxyLoader extends Base {
        load(context: any, config: any, callbacks: any) {
          if (context?.url) context.url = proxifyUrl(context.url, cfg.net);
          super.load(context, config, callbacks);
        }
      }
      hlsCfg.loader = ProxyLoader;
      cb.onLog("info", "Proxy ON — injecting CDN headers on media requests");
    }

    if (cfg.drm.enabled) {
      const { system, licenseUrl } = cfg.drm;
      if (system === "fairplay") {
        cb.onLog("warn", "FairPlay + hls.js: use Native/AVPlayer engine in Safari");
      } else if (system === "widevine") {
        hlsCfg.emeEnabled = true;
        hlsCfg.widevineLicenseUrl = licenseUrl;
        cb.onLog("drm", "Widevine via EME enabled");
      } else {
        cb.onLog("warn", "PlayReady is not supported by hls.js");
      }
    }

    hls = new Hls(hlsCfg);
    hls.loadSource(cfg.url);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, (_ev: any, d: any) => {
      cb.onLog("info", `Manifest parsed — ${d.levels.length} levels`);
      autoplay(video, cb.onLog);
    });
    hls.on(Hls.Events.MANIFEST_LOADED, (_ev: any, d: any) => {
      cb.onNetwork({ time: new Date(), kind: "manifest", url: d?.url || cfg.url });
    });
    hls.on(Hls.Events.FRAG_LOADED, (_ev: any, d: any) => {
      const frag = d?.frag;
      if (!frag) return;
      const stats = d?.stats || frag.stats;
      const bytes = stats?.total ?? stats?.loaded;
      const dur =
        stats?.loading && stats.loading.end && stats.loading.start
          ? Math.round(stats.loading.end - stats.loading.start)
          : undefined;
      cb.onNetwork({
        time: new Date(),
        kind: "segment",
        mediaType: frag.type,
        url: frag.url,
        bytes,
        durationMs: dur,
      });
    });
    hls.on(Hls.Events.LEVEL_SWITCHED, (_ev: any, d: any) => {
      const l = hls.levels[d.level];
      cb.onAbr(curBitrate, l.bitrate, { w: l.width, h: l.height });
      curBitrate = l.bitrate;
      cb.onMetrics({ bitrate: l.bitrate });
    });
    hls.on(Hls.Events.ERROR, (_ev: any, d: any) => {
      if (d.fatal) {
        cb.onLog("error", `hls.js fatal: ${d.type}/${d.details}`);
        cb.onState("error");
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      } else {
        cb.onLog("warn", `hls.js: ${d.details}`);
      }
    });
    hls.on(Hls.Events.FRAG_BUFFERED, () => {
      cb.onMetrics({ bw: hls.bandwidthEstimate || 0 });
    });

    statsIv = setInterval(() => {
      if (!hls) return;
      cb.onMetrics({ bw: hls.bandwidthEstimate || 0 });
    }, 1000);

    cb.onLog("info", "Loading source: " + cfg.url);
  }

  function destroy() {
    if (statsIv) {
      clearInterval(statsIv);
      statsIv = null;
    }
    try {
      if (hls?.destroy) hls.destroy();
    } catch {
      /* noop */
    }
    hls = null;
  }

  return { load, destroy };
}
