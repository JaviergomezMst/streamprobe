import { hasNetOverrides, proxifyUrl } from "@/lib/proxy";
import type { EngineCallbacks, EngineController, LoadConfig } from "./types";

/**
 * Native <video> playback. Also backs the "avplayer" engine, since on
 * Apple platforms native HLS/FairPlay is handled by AVPlayer under the hood.
 */
export function createNative(cb: EngineCallbacks, isAvPlayer = false): EngineController {
  let el: HTMLVideoElement | null = null;

  const lbl = (lang: string, label: string, fb: string) =>
    [lang, label].filter(Boolean).join(" · ") || fb;

  function reportTracks() {
    if (!el) return;
    const atl: any = (el as any).audioTracks;
    const audio = atl
      ? Array.from({ length: atl.length }, (_, i) => ({
          id: String(i),
          lang: atl[i].language,
          label: lbl(atl[i].language, atl[i].label, `Audio ${i + 1}`),
          active: !!atl[i].enabled,
        }))
      : [];
    const ttl = el.textTracks;
    const text = ttl
      ? Array.from({ length: ttl.length }, (_, i) => ({ t: ttl[i], i }))
          .filter(({ t }) => t.kind === "subtitles" || t.kind === "captions")
          .map(({ t, i }) => ({
            id: String(i),
            lang: t.language,
            label: lbl(t.language, t.label, `Sub ${i + 1}`),
            active: t.mode === "showing",
          }))
      : [];
    cb.onTracks(audio, text);
  }

  function selectAudio(id: string) {
    const atl: any = el && (el as any).audioTracks;
    if (!atl) return;
    const i = parseInt(id, 10);
    for (let j = 0; j < atl.length; j++) atl[j].enabled = j === i;
    reportTracks();
  }
  function selectText(id: string | null) {
    if (!el) return;
    const ttl = el.textTracks;
    for (let j = 0; j < ttl.length; j++) ttl[j].mode = "disabled";
    if (id !== null && ttl[parseInt(id, 10)]) ttl[parseInt(id, 10)].mode = "showing";
    reportTracks();
  }

  async function load(video: HTMLVideoElement, cfg: LoadConfig) {
    el = video;
    video.addEventListener("loadedmetadata", reportTracks);
    video.textTracks?.addEventListener?.("change", reportTracks);
    video.textTracks?.addEventListener?.("addtrack", reportTracks);
    (video as any).audioTracks?.addEventListener?.("change", reportTracks);
    (video as any).audioTracks?.addEventListener?.("addtrack", reportTracks);
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
      el.removeEventListener("loadedmetadata", reportTracks);
      el.removeAttribute("src");
      el.load();
      el = null;
    }
  }

  return { load, destroy, selectAudio, selectText };
}
