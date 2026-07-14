import { hasNetOverrides, proxifyUrl } from "@/lib/proxy";
import type { EngineCallbacks, EngineController, LoadConfig } from "./types";

/**
 * Native <video> playback. Also backs the "avplayer" engine, since on
 * Apple platforms native HLS/FairPlay is handled by AVPlayer under the hood.
 */
export function createNative(cb: EngineCallbacks, isAvPlayer = false): EngineController {
  let el: HTMLVideoElement | null = null;

  async function load(video: HTMLVideoElement, cfg: LoadConfig) {
    el = video;
    if (isAvPlayer) {
      const canHls = video.canPlayType("application/vnd.apple.mpegurl");
      if (!canHls) {
        cb.onLog(
          "warn",
          "AVPlayer maps to native Apple playback — open in Safari for HLS/FairPlay."
        );
      } else {
        cb.onLog("info", "AVPlayer (native Apple HLS): " + cfg.url);
      }
      if (cfg.drm.enabled && cfg.drm.system !== "fairplay") {
        cb.onLog("warn", "AVPlayer only supports FairPlay DRM.");
      }
    } else {
      cb.onLog("info", "Native video: " + cfg.url);
    }
    if (hasNetOverrides(cfg.net)) {
      cb.onLog(
        "warn",
        "Native playback: only the top-level URL is proxied; segments load directly (headers won't apply to them)."
      );
    }
    video.src = proxifyUrl(cfg.url, cfg.net);
    video.load();
    video.play().catch((e) => cb.onLog("warn", "Autoplay blocked: " + e.message));
  }

  function destroy() {
    if (el) {
      el.removeAttribute("src");
      el.load();
      el = null;
    }
  }

  return { load, destroy };
}
