"use client";

import { type RefObject } from "react";
import MetricsBar from "./MetricsBar";
import LogView from "./LogView";
import { ENGINES } from "@/lib/engines/registry";
import type { UsePlayer } from "@/hooks/usePlayer";
import type { EngineId, PlayerState } from "@/lib/engines/types";

const DOT_CLASS: Record<PlayerState, string> = {
  idle: "bg-tx3",
  loading: "bg-ga animate-blink-load",
  playing: "bg-ga animate-blink-med",
  buffering: "bg-warn animate-blink-fast",
  paused: "bg-tx3",
  error: "bg-err",
};

interface Props {
  panel: "A" | "B";
  engine: EngineId;
  url: string;
  player: UsePlayer;
  videoRef: RefObject<HTMLVideoElement>;
}

/** Audio + subtitle track pickers (shown once the engine reports tracks). */
function TrackBar({ player, focusCls }: { player: UsePlayer; focusCls: string }) {
  const { audioTracks, textTracks } = player;
  if (audioTracks.length === 0 && textTracks.length === 0) return null;
  const activeAudio = audioTracks.find((t) => t.active)?.id ?? "";
  const activeText = textTracks.find((t) => t.active)?.id ?? "__off__";
  const sel =
    "fsel cursor-pointer rounded-[5px] border border-bd bg-sf2 px-[9px] py-[4px] font-mono text-[11px] text-tx1 outline-none " +
    focusCls;
  return (
    <div className="flex flex-shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-bd bg-sf1 px-3 py-[7px]">
      {audioTracks.length > 0 && (
        <label className="flex items-center gap-[7px] text-[10px] font-semibold uppercase tracking-[.06em] text-tx3">
          🔊 Audio
          <select
            className={sel}
            value={activeAudio}
            onChange={(e) => player.selectAudio(e.target.value)}
          >
            {audioTracks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {textTracks.length > 0 && (
        <label className="flex items-center gap-[7px] text-[10px] font-semibold uppercase tracking-[.06em] text-tx3">
          💬 Subtítulos
          <select
            className={sel}
            value={activeText}
            onChange={(e) =>
              player.selectText(e.target.value === "__off__" ? null : e.target.value)
            }
          >
            <option value="__off__">Off</option>
            {textTracks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

export default function PlayerPanel({
  panel,
  engine,
  url,
  player,
  videoRef,
}: Props) {
  const isA = panel === "A";
  const pidCls = isA
    ? "bg-ga/[.12] text-ga border-ga/30"
    : "bg-gb/[.12] text-gb border-gb/30";
  const btnHover = isA ? "hover:border-ga hover:text-ga" : "hover:border-gb hover:text-gb";
  const tagColor = isA ? "text-ga" : "text-gb";

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden border-r border-bd last:border-r-0">
      {/* Header */}
      <div className="flex flex-shrink-0 items-center justify-between gap-[10px] border-b border-bd bg-sf1 px-3 py-[7px]">
        <div
          className={`flex-shrink-0 rounded-[4px] border px-2 py-[2px] font-mono text-[10px] font-semibold tracking-[.1em] ${pidCls}`}
        >
          {panel}
        </div>
        <div className="flex flex-1 items-center gap-[6px]">
          <div className={`h-[7px] w-[7px] flex-shrink-0 rounded-full ${DOT_CLASS[player.state]}`} />
          <span className="font-mono text-[10px] text-tx2">
            {player.state.toUpperCase()}
          </span>
          <span className={`font-mono text-[10px] font-semibold ${tagColor}`}>
            {ENGINES[engine].tag}
          </span>
        </div>
        <div className="flex gap-[5px]">
          <button
            onClick={player.reset}
            className={`flex items-center gap-1 rounded-[4px] border border-bd px-2 py-[3px] text-[10px] text-tx2 transition ${btnHover}`}
          >
            ↺ Reset
          </button>
          <button
            onClick={() => player.exportJSON(engine, url)}
            className={`flex items-center gap-1 rounded-[4px] border border-bd px-2 py-[3px] text-[10px] text-tx2 transition ${btnHover}`}
          >
            ⬇ JSON
          </button>
        </div>
      </div>

      {/* Video */}
      <div className="relative flex-shrink-0 bg-black">
        <video
          ref={videoRef}
          controls
          playsInline
          className="block max-h-[38vh] w-full bg-black"
        />
        {!player.overlayHidden && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/[.88] font-mono text-xs text-tx2">
            <div className="text-center">
              <div className="mb-[6px] text-[32px] text-tx3">▶</div>
              <div>Configure a stream and click Load</div>
            </div>
          </div>
        )}
      </div>

      {/* Audio / subtitle tracks */}
      <TrackBar player={player} focusCls={isA ? "focus:border-ga" : "focus:border-gb"} />

      {/* Metrics */}
      <MetricsBar m={player.metrics} />

      {/* Logs */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <LogView
          evLog={player.evLog}
          abrLog={player.abrLog}
          scteLog={player.scteLog}
          netLog={player.netLog}
          manifests={player.manifests}
          manifestError={player.manifestError}
          manifestLoading={player.manifestLoading}
          buffered={player.buffered}
          onClear={player.clear}
        />
      </div>
    </div>
  );
}
