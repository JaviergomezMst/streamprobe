"use client";

import { useCallback, useRef, useState, type RefObject } from "react";
import { createEngine } from "@/lib/engines";
import { fmtBps, fmtMs } from "@/lib/fmt";
import { ENGINES } from "@/lib/engines/registry";
import {
  checkContinuity,
  countPeriods,
  detectFormatFromText,
  parseDashInfo,
  type CapturedManifest,
} from "@/lib/manifest";
import type { EngineManifest, NetOverrides } from "@/lib/engines/types";
import { proxifyUrl } from "@/lib/proxy";
import type {
  EngineController,
  EngineId,
  LoadConfig,
  LogType,
  Metrics,
  NetworkEntry,
  PlayerState,
  TrackInfo,
} from "@/lib/engines/types";

export interface LogEntry {
  time: Date;
  type: LogType;
  msg: string;
}

export interface BufferedState {
  ranges: { start: number; end: number }[];
  current: number;
  duration: number; // 0 when live / unknown
  seekableStart: number | null;
  seekableEnd: number | null; // live edge for live streams
}

const EMPTY_BUFFERED: BufferedState = {
  ranges: [],
  current: 0,
  duration: 0,
  seekableStart: null,
  seekableEnd: null,
};

const EMPTY_METRICS: Metrics = {
  join: null,
  bufN: 0,
  bufMs: 0,
  bitrate: 0,
  bw: 0,
  latency: null,
  dropped: 0,
  state: "idle",
};

// Rolling-window caps: on a long live session every log grows unbounded (netLog
// gets an entry per segment request), which eventually freezes the UI and makes
// it look like capture "stopped". Keep the newest N and drop the rest.
const LOG_LIMIT = 2000; // events / abr / scte / network
const MANIFEST_LIMIT = 2000; // captured MPDs (each holds full text) — newest kept

export interface UsePlayer {
  metrics: Metrics;
  state: PlayerState;
  evLog: LogEntry[];
  abrLog: LogEntry[];
  scteLog: LogEntry[];
  netLog: NetworkEntry[];
  manifests: CapturedManifest[];
  manifestError: string | null;
  manifestLoading: boolean;
  buffered: BufferedState;
  running: boolean;
  overlayHidden: boolean;
  audioTracks: TrackInfo[];
  textTracks: TrackInfo[];
  load: (engine: EngineId, cfg: LoadConfig) => Promise<void>;
  stop: () => void;
  reset: () => void;
  clear: (kind: "events" | "abr" | "scte" | "net" | "manifest") => void;
  selectAudio: (id: string) => void;
  selectText: (id: string | null) => void;
  exportJSON: (engine: EngineId, url: string) => void;
}

export function usePlayer(
  videoRef: RefObject<HTMLVideoElement>,
  panelId: string
): UsePlayer {
  const [metrics, setMetrics] = useState<Metrics>(EMPTY_METRICS);
  const [state, setStateVal] = useState<PlayerState>("idle");
  const [evLog, setEvLog] = useState<LogEntry[]>([]);
  const [abrLog, setAbrLog] = useState<LogEntry[]>([]);
  const [scteLog, setScteLog] = useState<LogEntry[]>([]);
  const [netLog, setNetLog] = useState<NetworkEntry[]>([]);
  const [manifests, setManifests] = useState<CapturedManifest[]>([]);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [manifestLoading, setManifestLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [audioTracks, setAudioTracks] = useState<TrackInfo[]>([]);
  const [textTracks, setTextTracks] = useState<TrackInfo[]>([]);
  const manifestSeqRef = useRef(0);
  const seamSigRef = useRef("");
  const urlRef = useRef("");
  const [overlayHidden, setOverlayHidden] = useState(false);
  const [buffered, setBuffered] = useState<BufferedState>(EMPTY_BUFFERED);

  const mRef = useRef<Metrics>(EMPTY_METRICS);
  const ctrlRef = useRef<EngineController | null>(null);
  const engineRef = useRef<EngineId>("shaka");
  const loadTRef = useRef<number | null>(null);
  const firstPlayRef = useRef(true);
  const bufTRef = useRef<number | null>(null);
  const framesIvRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const listenersRef = useRef<Record<string, (() => void) | null>>({});

  const patchMetrics = useCallback((patch: Partial<Metrics>) => {
    mRef.current = { ...mRef.current, ...patch };
    setMetrics(mRef.current);
  }, []);

  const setState = useCallback((s: PlayerState) => {
    mRef.current = { ...mRef.current, state: s };
    setStateVal(s);
  }, []);

  const log = useCallback((type: LogType, msg: string) => {
    const e: LogEntry = { time: new Date(), type, msg };
    setEvLog((prev) => [...prev, e].slice(-LOG_LIMIT));
    if (type === "abr") setAbrLog((prev) => [...prev, e].slice(-LOG_LIMIT));
    if (type === "scte") setScteLog((prev) => [...prev, e].slice(-LOG_LIMIT));
  }, []);

  const pushManifest = useCallback(
    (input: EngineManifest, source: "fetch" | "engine") => {
      const { text } = input;
      const format = detectFormatFromText(text, urlRef.current, input.format);
      const dash = format === "dash" ? parseDashInfo(text) ?? undefined : undefined;
      let periodCount = input.periodCount;
      if (periodCount == null && format === "dash")
        periodCount = dash ? dash.periods.length : countPeriods(text);
      const isMultiperiod = (periodCount ?? 0) > 1;
      const entry: CapturedManifest = {
        id: manifestSeqRef.current++,
        time: new Date(),
        format,
        periodCount,
        isMultiperiod,
        text,
        bytes: input.bytes,
        note: input.note,
        source,
        dash,
      };
      // Newest first; keep a large history so long sessions stay reviewable.
      setManifests((prev) => [entry, ...prev].slice(0, MANIFEST_LIMIT));

      // Live timestamp-consistency alert (de-duped). Catches both cases of the
      // multiperiod→one-period conversion going wrong:
      //  - multiperiod: content doesn't concord across an ad-break seam;
      //  - one-period: timestamps jump inside the stitched timeline, or the
      //    video/audio tracks fall out of alignment.
      if (dash) {
        const issues: string[] = [];
        for (let i = 1; i < dash.periods.length; i++) {
          const c = checkContinuity(dash.periods[i - 1], dash.periods[i]);
          if (c && !c.continuous) issues.push(`costura P${i - 1}→P${i}: ${c.reasons.join("; ")}`);
        }
        for (const p of dash.periods) {
          const vb = p.timeline?.internalBreaks ?? [];
          const ab = p.audioTimeline?.internalBreaks ?? [];
          if (vb.length) issues.push(`P${p.index} salto de timestamps en vídeo (${vb.map((b) => b.deltaSec.toFixed(2) + "s").join(",")})`);
          if (ab.length) issues.push(`P${p.index} salto de timestamps en audio (${ab.map((b) => b.deltaSec.toFixed(2) + "s").join(",")})`);
          if (Math.abs(p.vaStartSkewSec ?? 0) > 0.05 || Math.abs(p.vaEndSkewSec ?? 0) > 0.05)
            issues.push(`P${p.index} vídeo/audio desalineados ${(p.vaStartSkewSec ?? 0).toFixed(2)}s`);
        }
        const sig = `${dash.periods.length}|${issues.join(" | ")}`;
        if (sig !== seamSigRef.current) {
          seamSigRef.current = sig;
          if (issues.length)
            log("scte", `⚠ Inconsistencia de timestamps (posible stall en TV): ${issues.join(" · ")}`);
          else if (dash.periods.length > 1)
            log("scte", `Multiperiod (${dash.periods.length}) — timestamps consistentes`);
        }
      }
    },
    [log]
  );

  const fetchManifest = useCallback(
    async (url: string, net?: NetOverrides) => {
      setManifestError(null);
      setManifestLoading(true);
      try {
        const res = await fetch(proxifyUrl(url, net));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        pushManifest({ text }, "fetch");
        const fmt = detectFormatFromText(text, url);
        if (fmt === "dash") {
          const n = countPeriods(text);
          log("info", n > 1 ? `MPD multi-period — ${n} periods` : "MPD single-period");
        }
      } catch (e: any) {
        setManifestError(
          "Could not fetch initial manifest (CORS or network): " + (e?.message || e)
        );
      } finally {
        setManifestLoading(false);
      }
    },
    [log, pushManifest]
  );

  const clearFrames = useCallback(() => {
    if (framesIvRef.current) {
      clearInterval(framesIvRef.current);
      framesIvRef.current = null;
    }
  }, []);

  const detachListeners = useCallback(() => {
    const v = videoRef.current;
    const L = listenersRef.current;
    if (v) {
      (["waiting", "playing", "pause", "ended"] as const).forEach((ev) => {
        if (L[ev]) v.removeEventListener(ev, L[ev]!);
      });
    }
    listenersRef.current = {};
  }, [videoRef]);

  const attachListeners = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    detachListeners();

    const onWaiting = () => {
      if (!bufTRef.current) {
        bufTRef.current = Date.now();
        patchMetrics({ bufN: mRef.current.bufN + 1 });
        setState("buffering");
        log("buffer", `Buffering started — event #${mRef.current.bufN}`);
      }
    };
    const onPlaying = () => {
      if (firstPlayRef.current && loadTRef.current) {
        const join = Date.now() - loadTRef.current;
        patchMetrics({ join });
        firstPlayRef.current = false;
        log("info", `First frame — join time: ${fmtMs(join)}`);
        setOverlayHidden(true);
      }
      if (bufTRef.current) {
        const d = Date.now() - bufTRef.current;
        patchMetrics({ bufMs: mRef.current.bufMs + d });
        bufTRef.current = null;
        log("buffer", `Buffering ended — duration: ${fmtMs(d)}`);
      }
      setState("playing");
    };
    const onPause = () => setState("paused");
    const onEnded = () => {
      setState("idle");
      log("info", "Stream ended");
    };

    v.addEventListener("waiting", onWaiting);
    v.addEventListener("playing", onPlaying);
    v.addEventListener("pause", onPause);
    v.addEventListener("ended", onEnded);
    listenersRef.current = {
      waiting: onWaiting,
      playing: onPlaying,
      pause: onPause,
      ended: onEnded,
    };
  }, [videoRef, detachListeners, patchMetrics, setState, log]);

  const startFramePoll = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    clearFrames();
    framesIvRef.current = setInterval(() => {
      const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
      if (q) patchMetrics({ dropped: q.droppedVideoFrames });
      try {
        const b = v.buffered;
        const ranges: { start: number; end: number }[] = [];
        for (let i = 0; i < b.length; i++) {
          ranges.push({ start: b.start(i), end: b.end(i) });
        }
        let seekableStart: number | null = null;
        let seekableEnd: number | null = null;
        try {
          const s = v.seekable;
          if (s.length) {
            seekableStart = s.start(0);
            seekableEnd = s.end(s.length - 1);
          }
        } catch {
          /* seekable unavailable */
        }
        setBuffered({
          ranges,
          current: v.currentTime,
          duration: isFinite(v.duration) ? v.duration : 0,
          seekableStart,
          seekableEnd,
        });
      } catch {
        /* buffered unavailable */
      }
    }, 500);
  }, [videoRef, clearFrames, patchMetrics]);

  const stop = useCallback(() => {
    clearFrames();
    detachListeners();
    try {
      ctrlRef.current?.destroy();
    } catch {
      /* noop */
    }
    ctrlRef.current = null;
    const v = videoRef.current;
    if (v) {
      v.removeAttribute("src");
      v.load();
    }
    setOverlayHidden(false);
    setRunning(false);
    setState("idle");
    log("info", "Stream stopped");
  }, [videoRef, clearFrames, detachListeners, setState, log]);

  const load = useCallback(
    async (engine: EngineId, cfg: LoadConfig) => {
      const v = videoRef.current;
      if (!v) return;
      if (!cfg.url) {
        log("error", "No URL specified");
        return;
      }
      if (ctrlRef.current) stop();

      engineRef.current = engine;
      urlRef.current = cfg.url;
      mRef.current = { ...EMPTY_METRICS };
      setMetrics(mRef.current);
      setNetLog([]);
      setScteLog([]);
      setManifests([]);
      setBuffered(EMPTY_BUFFERED);
      setAudioTracks([]);
      setTextTracks([]);
      firstPlayRef.current = true;
      bufTRef.current = null;
      loadTRef.current = Date.now();

      setRunning(true);
      setOverlayHidden(false);
      setState("loading");
      attachListeners();
      startFramePoll();
      fetchManifest(cfg.url, cfg.net);

      const ctrl = createEngine(engine, {
        onLog: log,
        onAbr: (prev, curr, dims) => {
          const dir = curr > prev ? "↑" : "↓";
          const dimsTxt = dims ? ` [${dims.w || "?"}×${dims.h || "?"}]` : "";
          log("abr", `ABR ${dir} ${fmtBps(prev)} → ${fmtBps(curr)}${dimsTxt}`);
        },
        onMetrics: patchMetrics,
        onState: setState,
        onNetwork: (entry) => setNetLog((prev) => [...prev, entry].slice(-LOG_LIMIT)),
        onManifest: (m) => pushManifest(m, "engine"),
        onTracks: (a, t) => {
          setAudioTracks(a);
          setTextTracks(t);
        },
      });
      ctrlRef.current = ctrl;

      try {
        await ctrl.load(v, cfg);
      } catch (e: any) {
        log("error", "Init failed: " + (e?.message || e));
        setState("error");
        clearFrames();
        setRunning(false);
      }
    },
    [videoRef, stop, attachListeners, startFramePoll, fetchManifest, pushManifest, log, patchMetrics, setState, clearFrames]
  );

  const reset = useCallback(() => {
    mRef.current = { ...EMPTY_METRICS, state: mRef.current.state };
    setMetrics(mRef.current);
    firstPlayRef.current = true;
    loadTRef.current = null;
    bufTRef.current = null;
    setEvLog([]);
    setAbrLog([]);
    setScteLog([]);
    setNetLog([]);
    setManifests([]);
    log("info", "Metrics reset");
  }, [log]);

  const clear = useCallback(
    (kind: "events" | "abr" | "scte" | "net" | "manifest") => {
      if (kind === "events") setEvLog([]);
      else if (kind === "abr") setAbrLog([]);
      else if (kind === "scte") setScteLog([]);
      else if (kind === "net") setNetLog([]);
      else if (kind === "manifest") setManifests([]);
    },
    []
  );

  const selectAudio = useCallback((id: string) => {
    ctrlRef.current?.selectAudio?.(id);
  }, []);
  const selectText = useCallback((id: string | null) => {
    ctrlRef.current?.selectText?.(id);
  }, []);

  const exportJSON = useCallback(
    (engine: EngineId, url: string) => {
      const data = {
        timestamp: new Date().toISOString(),
        engine: ENGINES[engine].tag,
        url,
        metrics: mRef.current,
        abrSwitches: abrLog.map((e) => ({ time: e.time.toISOString(), msg: e.msg })),
        scte35: scteLog.map((e) => ({ time: e.time.toISOString(), msg: e.msg })),
        network: netLog.map((e) => ({
          time: e.time.toISOString(),
          kind: e.kind,
          mediaType: e.mediaType,
          url: e.url,
          bytes: e.bytes,
          durationMs: e.durationMs,
        })),
        events: evLog.map((e) => ({
          time: e.time.toISOString(),
          type: e.type,
          msg: e.msg,
        })),
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `streamprobe_${panelId}_${Date.now()}.json`;
      a.click();
    },
    [abrLog, scteLog, evLog, netLog, panelId]
  );

  return {
    metrics,
    state,
    evLog,
    abrLog,
    scteLog,
    netLog,
    manifests,
    manifestError,
    manifestLoading,
    buffered,
    running,
    overlayHidden,
    audioTracks,
    textTracks,
    load,
    stop,
    reset,
    clear,
    selectAudio,
    selectText,
    exportJSON,
  };
}
