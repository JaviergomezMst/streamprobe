"use client";

import { useRef, useState } from "react";
import Header from "./Header";
import ConfigPanel from "./ConfigPanel";
import PlayerPanel from "./PlayerPanel";
import DeployPanel from "./DeployPanel";
import { usePlayer } from "@/hooks/usePlayer";
import { ENGINES, DEFAULT_URL } from "@/lib/engines/registry";
import { toLoadConfig, type EngineId, type PanelConfig } from "@/lib/engines/types";

function makeConfig(engine: EngineId): PanelConfig {
  return {
    engine,
    version: ENGINES[engine].versions[0],
    url: DEFAULT_URL,
    drm: {
      enabled: false,
      system: "widevine",
      licenseUrl: "",
      certUrl: "",
      headers: [],
    },
    advanced: {
      matchTv: true,
      bufferGoal: 10,
      rebufferGoal: 2,
      audioLang: "",
      returnToLiveWindow: true,
      stalledMinDuration: 1,
    },
    net: { origin: "www.mediasetinfinity.es", referer: "", userAgent: "" },
    deviceUserAgent: "",
  };
}

export default function StreamProbe() {
  const [mode, setMode] = useState<"single" | "compare">("single");
  const [view, setView] = useState<"player" | "deploy">("player");
  const [sideTab, setSideTab] = useState<"A" | "B">("A");
  const [configA, setConfigA] = useState<PanelConfig>(() => makeConfig("shaka"));
  const [configB, setConfigB] = useState<PanelConfig>(() => makeConfig("dashjs"));

  const videoA = useRef<HTMLVideoElement>(null);
  const videoB = useRef<HTMLVideoElement>(null);
  const playerA = usePlayer(videoA, "A");
  const playerB = usePlayer(videoB, "B");

  const players = { A: playerA, B: playerB };
  const configs = { A: configA, B: configB };
  const setConfigs = { A: setConfigA, B: setConfigB };

  const onMode = (m: "single" | "compare") => {
    if (m === "single" && playerB.running) playerB.stop();
    setMode(m);
    if (m === "compare") setSideTab("A");
  };

  const patchConfig = (panel: "A" | "B") => (patch: Partial<PanelConfig>) =>
    setConfigs[panel]((prev) => ({ ...prev, ...patch }));

  const handleLoad = (panel: "A" | "B") =>
    players[panel].load(configs[panel].engine, toLoadConfig(configs[panel]));

  return (
    <div className="flex h-screen flex-col">
      <Header mode={mode} onMode={onMode} view={view} onView={setView} />

      <div className="flex flex-1 overflow-hidden">
        {/* Player view — kept mounted (hidden) so playback survives switching to Deploy */}
        <div className={view === "deploy" ? "hidden" : "flex flex-1 overflow-hidden"}>
        {/* Sidebar */}
        <div className="flex w-[290px] flex-shrink-0 flex-col overflow-hidden border-r border-bd bg-sf1">
          {mode === "compare" && (
            <div className="flex flex-shrink-0 border-b border-bd">
              {(["A", "B"] as const).map((p) => {
                const on = sideTab === p;
                const cls =
                  p === "A"
                    ? on
                      ? "text-ga border-ga"
                      : "text-tx3 border-transparent"
                    : on
                      ? "text-gb border-gb"
                      : "text-tx3 border-transparent";
                return (
                  <div
                    key={p}
                    onClick={() => setSideTab(p)}
                    className={`flex-1 cursor-pointer border-b-2 py-[9px] text-center text-[11px] font-semibold uppercase tracking-[.06em] transition ${cls}`}
                  >
                    Player {p}
                  </div>
                );
              })}
            </div>
          )}
          <div className="flex-1 overflow-y-auto">
            {(mode === "single" || sideTab === "A") && (
              <ConfigPanel
                panel="A"
                config={configA}
                running={playerA.running}
                onChange={patchConfig("A")}
                onLoad={() => handleLoad("A")}
                onStop={playerA.stop}
              />
            )}
            {mode === "compare" && sideTab === "B" && (
              <ConfigPanel
                panel="B"
                config={configB}
                running={playerB.running}
                onChange={patchConfig("B")}
                onLoad={() => handleLoad("B")}
                onStop={playerB.stop}
              />
            )}
          </div>
        </div>

        {/* Panels */}
        <div className="flex flex-1 overflow-hidden">
          <PlayerPanel
            panel="A"
            engine={configA.engine}
            url={configA.url}
            player={playerA}
            videoRef={videoA}
          />
          {mode === "compare" && (
            <PlayerPanel
              panel="B"
              engine={configB.engine}
              url={configB.url}
              player={playerB}
              videoRef={videoB}
            />
          )}
        </div>
        </div>

        {view === "deploy" && <DeployPanel />}
      </div>
    </div>
  );
}
