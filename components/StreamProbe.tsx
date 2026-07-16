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
      lockMaxQuality: false,
    },
    // App-faithful CDN headers: Akamai now denies (403) manifest/segment
    // requests without a proper Origin. Send the same Origin+Referer the real
    // Mediaset app sends, with scheme, so requests aren't WAF-blocked.
    net: {
      origin: "https://www.mediasetinfinity.es",
      referer: "https://www.mediasetinfinity.es/",
      userAgent: "",
    },
    deviceUserAgent: "",
  };
}

export default function StreamProbe() {
  const [mode, setMode] = useState<"single" | "compare">("single");
  const [view, setView] = useState<"player" | "deploy">("player");
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
  };

  const patchConfig = (panel: "A" | "B") => (patch: Partial<PanelConfig>) =>
    setConfigs[panel]((prev) => ({ ...prev, ...patch }));

  const handleLoad = (panel: "A" | "B") =>
    players[panel].load(configs[panel].engine, toLoadConfig(configs[panel]));

  const loadBoth = () => {
    handleLoad("A");
    handleLoad("B");
  };
  const stopBoth = () => {
    playerA.stop();
    playerB.stop();
  };
  const anyRunning = playerA.running || playerB.running;

  return (
    <div className="flex h-screen flex-col">
      <Header mode={mode} onMode={onMode} view={view} onView={setView} />

      <div className="flex flex-1 overflow-hidden">
        {/* Player view — kept mounted (hidden) so playback survives switching to Deploy */}
        <div className={view === "deploy" ? "hidden" : "flex flex-1 overflow-hidden"}>
        {/* Sidebar */}
        <div className="flex w-[290px] flex-shrink-0 flex-col overflow-hidden border-r border-bd bg-sf1">
          {mode === "compare" && (
            <div className="flex flex-shrink-0 items-center gap-2 border-b border-bd px-2 py-2">
              <button
                onClick={loadBoth}
                className="flex-1 rounded-md bg-gradient-to-r from-ga to-gb py-2 text-[12px] font-semibold text-white transition hover:brightness-110"
                title="Cargar A y B a la vez"
              >
                ▶ Load A + B
              </button>
              <button
                onClick={stopBoth}
                disabled={!anyRunning}
                className="rounded-md border border-bd bg-sf2 px-3 py-2 text-[12px] font-semibold text-tx2 transition hover:border-bd2 hover:text-tx1 disabled:opacity-40"
                title="Parar ambos"
              >
                ■ Both
              </button>
            </div>
          )}
          <div className="flex-1 overflow-y-auto">
            {mode === "compare" && (
              <div className="sticky top-0 z-10 border-b border-bd bg-sf2/95 px-3 py-[6px] text-[11px] font-semibold uppercase tracking-[.06em] text-ga backdrop-blur">
                ● Player A
              </div>
            )}
            <ConfigPanel
              panel="A"
              config={configA}
              running={playerA.running}
              onChange={patchConfig("A")}
              onLoad={() => handleLoad("A")}
              onStop={playerA.stop}
            />
            {mode === "compare" && (
              <>
                <div className="sticky top-0 z-10 border-y border-bd bg-sf2/95 px-3 py-[6px] text-[11px] font-semibold uppercase tracking-[.06em] text-gb backdrop-blur">
                  ● Player B
                </div>
                <ConfigPanel
                  panel="B"
                  config={configB}
                  running={playerB.running}
                  onChange={patchConfig("B")}
                  onLoad={() => handleLoad("B")}
                  onStop={playerB.stop}
                />
              </>
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
