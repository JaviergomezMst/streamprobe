import { loadLib } from "./loaders";
import { autoplay } from "./autoplay";
import { hasNetOverrides, proxifyUrl, unproxifyUrl } from "@/lib/proxy";
import { detectFormat } from "@/lib/format";
import { detectShakaPlatform, setDeviceUserAgent } from "@/lib/deviceEmu";
import type { EngineCallbacks, EngineController, LoadConfig } from "./types";

export function createShaka(cb: EngineCallbacks): EngineController {
  let player: any = null;
  let statsIv: ReturnType<typeof setInterval> | null = null;
  let curBitrate = 0;
  const audioSel = new Map<
    string,
    { language: string; role?: string; channelsCount?: number; label?: string }
  >();

  function reportTracks() {
    if (!player) return;
    try {
      audioSel.clear();
      const audio: any[] = [];
      for (const v of player.getVariantTracks()) {
        const roles = (v.audioRoles || []).join(",");
        const id = `${v.language}|${roles}|${v.channelsCount ?? ""}|${v.label ?? ""}`;
        let t = audio.find((a) => a.id === id);
        if (!t) {
          audioSel.set(id, {
            language: v.language,
            role: v.audioRoles?.[0],
            channelsCount: v.channelsCount,
            label: v.label,
          });
          const parts = [v.language || "und"];
          if (v.channelsCount) parts.push(`${v.channelsCount}ch`);
          if (v.label) parts.push(v.label);
          t = { id, lang: v.language, label: parts.join(" · "), active: false };
          audio.push(t);
        }
        if (v.active) t.active = true;
      }
      const visible = player.isTextTrackVisible();
      const text = player.getTextTracks().map((t: any) => ({
        id: String(t.id),
        lang: t.language,
        label: [t.language || "und", t.label, t.forced ? "forced" : ""]
          .filter(Boolean)
          .join(" · "),
        active: !!t.active && visible,
      }));
      cb.onTracks(audio, text);
    } catch {
      /* networking/tracks unavailable */
    }
  }

  function selectAudio(id: string) {
    const sel = audioSel.get(id);
    if (sel && player) {
      try {
        player.selectAudioLanguage(sel.language, sel.role, sel.channelsCount, sel.label);
      } catch {
        player.selectAudioLanguage(sel.language, sel.role);
      }
    }
  }

  function selectText(id: string | null) {
    if (!player) return;
    if (id === null) {
      player.setTextTrackVisibility(false);
    } else {
      const t = player.getTextTracks().find((x: any) => String(x.id) === id);
      if (t) {
        player.selectTextTrack(t);
        player.setTextTrackVisibility(true);
      }
    }
    reportTracks();
  }

  async function load(video: HTMLVideoElement, cfg: LoadConfig) {
    // Emulate a SmartTV UA before Shaka loads so its platform detection engages
    // the TV code paths. With no override, the device's own UA is used as-is.
    setDeviceUserAgent(cfg.deviceUserAgent);
    cb.onLog(
      "info",
      `${cfg.deviceUserAgent ? "Emulated" : "Device"} User-Agent: ${navigator.userAgent}`
    );

    cb.onLog("info", `Loading Shaka Player ${cfg.version} (bundled)…`);
    const shaka: any = await loadLib("shaka", cfg.version);

    shaka.polyfill.installAll();
    if (!shaka.Player.isBrowserSupported()) {
      cb.onLog("error", "Browser not supported by Shaka Player");
      cb.onState("error");
      return;
    }

    player = new shaka.Player();
    await player.attach(video);

    const platform = detectShakaPlatform(shaka);
    cb.onLog(
      "info",
      `Shaka platform: ${platform} · smoothCodecSwitch=${
        (() => {
          try {
            return shaka.util.Platform.supportsSmoothCodecSwitching();
          } catch {
            return "?";
          }
        })()
      }`
    );

    const {
      matchTv,
      bufferGoal,
      rebufferGoal,
      audioLang,
      returnToLiveWindow,
      stalledMinDuration,
    } = cfg.advanced;

    // TV-faithful mode: mirror the SmartTV app (mitele), which runs Shaka with
    // default config and only sets drm.servers — no streaming/buffer tuning.
    const conf: any = {};
    if (matchTv) {
      cb.onLog("info", "Shaka config: TV-faithful (defaults, no streaming tuning)");
    } else {
      conf.streaming = {
        bufferingGoal: bufferGoal,
        rebufferingGoal: rebufferGoal,
        returnToEndOfLiveWindowWhenOutside: returnToLiveWindow,
        stallEnabled: true,
        stallThreshold: stalledMinDuration || 1,
      };
      if (audioLang) conf.preferredAudioLanguage = audioLang;
    }

    if (cfg.drm.enabled) {
      const { system, licenseUrl, certUrl, headers } = cfg.drm;
      conf.drm = { servers: {} as Record<string, string> };
      if (system === "widevine") {
        conf.drm.servers["com.widevine.alpha"] = licenseUrl;
        if (Object.keys(headers).length)
          conf.drm.advanced = { "com.widevine.alpha": { headers } };
      } else if (system === "playready") {
        conf.drm.servers["com.microsoft.playready"] = licenseUrl;
        if (Object.keys(headers).length)
          conf.drm.advanced = { "com.microsoft.playready": { headers } };
      } else if (system === "fairplay") {
        conf.drm.servers["com.apple.fps.1_0"] = licenseUrl;
        if (certUrl)
          conf.drm.advanced = {
            "com.apple.fps.1_0": { serverCertificateUri: certUrl },
          };
      }
      cb.onLog("drm", `DRM: ${system.toUpperCase()} → ${licenseUrl}`);
    }

    // Pin the highest rendition: turn off ABR so it can't drop the quality.
    if (cfg.advanced.lockMaxQuality) {
      conf.abr = { enabled: false };
      cb.onLog("info", "Calidad fijada al máximo (ABR desactivado)");
    }

    player.configure(conf);

    const RT = shaka.net.NetworkingEngine.RequestType;

    // Route media (not license) requests through the proxy to inject
    // Origin / Referer / User-Agent headers.
    if (hasNetOverrides(cfg.net)) {
      player.getNetworkingEngine().registerRequestFilter((type: number, request: any) => {
        if (type === RT.LICENSE) return;
        if (Array.isArray(request.uris))
          request.uris = request.uris.map((u: string) => proxifyUrl(u, cfg.net));
      });
      cb.onLog("info", "Proxy ON — injecting CDN headers on media requests");
    }

    // Network traces via a response filter.
    try {
      const kindOf = (type: number): any => {
        if (type === RT.MANIFEST) return "manifest";
        if (type === RT.SEGMENT) return "segment";
        if (type === RT.LICENSE) return "license";
        if (type === RT.INIT_SEGMENT) return "init";
        return "other";
      };
      player.getNetworkingEngine().registerResponseFilter((type: number, response: any) => {
        // Restore the real URI so relative segment/BaseURL resolution targets
        // the real CDN, not the local proxy (which would 404).
        const real = unproxifyUrl(response.uri);
        if (real) response.uri = real;

        const bytes = response.data ? response.data.byteLength : undefined;
        // Read the headers the proxy echoed back to confirm what was injected.
        const h = response.headers || {};
        const sentOrigin = h["x-sp-sent-origin"];
        const sentReferer = h["x-sp-sent-referer"];
        const sentUa = h["x-sp-sent-user-agent"];
        const sent =
          sentOrigin || sentReferer || sentUa
            ? { origin: sentOrigin, referer: sentReferer, userAgent: sentUa }
            : undefined;
        cb.onNetwork({
          time: new Date(),
          kind: kindOf(type),
          url:
            unproxifyUrl(response.originalUri || "") ||
            response.uri ||
            response.originalUri ||
            "",
          bytes,
          durationMs: typeof response.timeMs === "number" ? response.timeMs : undefined,
          sent,
        });
        // Capture every manifest (initial + live refreshes) as raw text.
        if (type === RT.MANIFEST && response.data) {
          try {
            const text = new TextDecoder().decode(new Uint8Array(response.data));
            cb.onManifest({ text, bytes });
          } catch {
            /* non-text manifest */
          }
        }
      });
    } catch {
      /* networking engine unavailable */
    }

    player.addEventListener("error", (e: any) => {
      cb.onLog("error", `Shaka [${e.detail.code}]: ${e.detail.message || "unknown"}`);
      cb.onState("error");
    });

    // ── Playback-health instrumentation (period-boundary stalls / gaps) ──
    // A gap Shaka jumps on desktop is exactly where an old TV MSE (no gap
    // jumping) would freeze. Report gaps, stalls and buffered ranges so the
    // period boundary can be inspected.
    const bufferedRanges = (): string => {
      try {
        const b = video.buffered;
        const parts: string[] = [];
        for (let i = 0; i < b.length; i++) {
          parts.push(`[${b.start(i).toFixed(2)}–${b.end(i).toFixed(2)}]`);
        }
        return parts.join(" ") || "empty";
      } catch {
        return "?";
      }
    };
    player.addEventListener("gapjumped", () => {
      cb.onLog(
        "warn",
        `GAP JUMPED @${video.currentTime.toFixed(2)}s — buffered ${bufferedRanges()} ` +
          `(a player without gap-jumping, e.g. an old TV, would stall here)`
      );
    });
    player.addEventListener("stalldetected", () => {
      cb.onLog(
        "buffer",
        `STALL detected @${video.currentTime.toFixed(2)}s — buffered ${bufferedRanges()}`
      );
    });

    // ── SCTE-35 / DASH event instrumentation ──
    const secs = (n: number | undefined) =>
      typeof n === "number" ? n.toFixed(2) + "s" : "?";
    const hex = (data: any): string => {
      try {
        const arr = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
        if (!arr || !arr.length) return "";
        return Array.from(arr.slice(0, 48) as Uint8Array)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      } catch {
        return "";
      }
    };
    const isScte = (uri: string) => /scte(35|_35|:35)?/i.test(uri || "");

    // In-band emsg boxes (often carry SCTE-35 splice info).
    player.addEventListener("emsg", (e: any) => {
      const d = e.detail || {};
      const data = hex(d.messageData);
      const tag = isScte(d.schemeIdUri) ? "SCTE-35 emsg" : "emsg";
      cb.onLog(
        "scte",
        `${tag} scheme=${d.schemeIdUri || "?"} value=${d.value ?? ""} id=${d.id ?? ""} ` +
          `@${secs(d.startTime)}→${secs(d.endTime)}${data ? " data=" + data : ""}`
      );
    });

    // MPD EventStream / Event regions (SCTE-35 markers, ad breaks, boundaries).
    ["timelineregionadded", "timelineregionenter", "timelineregionexit"].forEach(
      (evName) => {
        player.addEventListener(evName, (e: any) => {
          const r = e.detail || {};
          const phase = evName.replace("timelineregion", "");
          const tag = isScte(r.schemeIdUri) ? "SCTE-35 region" : "region";
          let xml = "";
          try {
            if (r.eventElement && (r.eventElement as Element).outerHTML) {
              xml = (r.eventElement as Element).outerHTML.replace(/\s+/g, " ").slice(0, 160);
            }
          } catch {
            /* no element */
          }
          cb.onLog(
            "scte",
            `${tag} ${phase} scheme=${r.schemeIdUri || "?"} value=${r.value ?? ""} ` +
              `id=${r.id ?? ""} @${secs(r.startTime)}→${secs(r.endTime)}${xml ? " " + xml : ""}`
          );
        });
      }
    );

    player.addEventListener("adaptation", () => {
      const t = player.getVariantTracks().find((v: any) => v.active);
      if (t) {
        cb.onAbr(curBitrate, t.bandwidth, { w: t.width, h: t.height });
        curBitrate = t.bandwidth;
        cb.onMetrics({ bitrate: t.bandwidth });
      }
    });

    statsIv = setInterval(() => {
      if (!player) return;
      const st = player.getStats();
      const patch: any = { bw: st.estimatedBandwidth || 0 };
      if (st.streamBandwidth) {
        patch.bitrate = st.streamBandwidth;
        curBitrate = st.streamBandwidth;
      }
      if (st.liveLatency !== undefined) patch.latency = st.liveLatency;
      if (st.droppedFrames) patch.dropped = st.droppedFrames;
      cb.onMetrics(patch);
    }, 1000);

    // Audio/subtitle track list — report on load and whenever it changes.
    ["trackschanged", "adaptation", "variantchanged", "textchanged", "texttrackvisibility"].forEach(
      (ev) => player.addEventListener(ev, reportTracks)
    );

    // Tell Shaka the manifest type explicitly. Its own guessing fails on URLs
    // with no basename before the extension (e.g. Unified Streaming's ".../.m3u8"
    // or ".../.mpd") → UNABLE_TO_GUESS_MANIFEST_TYPE. Our URL detection handles it.
    const MIME: Record<string, string> = {
      dash: "application/dash+xml",
      hls: "application/x-mpegurl",
      smooth: "application/vnd.ms-sstr+xml",
    };
    const mime = MIME[detectFormat(cfg.url)];

    cb.onLog("info", `Loading manifest: ${cfg.url}${mime ? ` (${mime})` : ""}`);
    try {
      await player.load(cfg.url, null, mime);
      const tracks = player.getVariantTracks();
      cb.onLog("info", `Manifest loaded — ${tracks.length} variants`);
      reportTracks();

      // With ABR off, pin the highest-bandwidth variant and re-assert it on
      // every track change (live period boundaries can otherwise reset it).
      if (cfg.advanced.lockMaxQuality) {
        const highest = (vs: any[]) =>
          vs.reduce((a: any, b: any) => (b.bandwidth > a.bandwidth ? b : a));
        const pinTop = () => {
          const vs = player.getVariantTracks();
          if (vs.length && !highest(vs).active)
            player.selectVariantTrack(highest(vs), /* clearBuffer */ true);
        };
        pinTop();
        player.addEventListener("trackschanged", pinTop);
        const top = highest(tracks);
        cb.onLog("info", `Fijado a ${Math.round(top.bandwidth / 1000)} kbps (${top.width || "?"}×${top.height || "?"})`);
      }

      const active = tracks.find((t: any) => t.active);
      if (active) {
        curBitrate = active.bandwidth;
        cb.onMetrics({ bitrate: active.bandwidth });
      }
      await autoplay(video, cb.onLog);
    } catch (e: any) {
      cb.onLog("error", "Load failed: " + (e?.message || e));
      cb.onState("error");
      throw e;
    }
  }

  function destroy() {
    if (statsIv) {
      clearInterval(statsIv);
      statsIv = null;
    }
    try {
      if (player?.destroy) player.destroy();
    } catch {
      /* noop */
    }
    player = null;
    audioSel.clear();
  }

  return { load, destroy, selectAudio, selectText };
}
