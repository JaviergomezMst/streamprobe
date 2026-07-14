"use client";

import { useEffect, useRef, useState } from "react";

type Platform = "webos" | "tizen" | "androidtv";
type Action = "deploy" | "package" | "browser";

interface SavedDevice {
  id: string;
  name: string;
  platform: Platform;
  tvIp: string;
}

interface Tools {
  ares: boolean;
  tizen: boolean;
  sdb: boolean;
}

const STORAGE_KEY = "sp-tv-devices";

const PLATFORMS: {
  id: Platform;
  os: string;
  glyph: string;
  brands: string;
  pkg: string;
  tool: keyof Tools | null;
  disabled?: boolean;
}[] = [
  { id: "webos", os: "LG webOS", glyph: "wOS", brands: "LG", pkg: ".ipk · ares-cli", tool: "ares" },
  { id: "tizen", os: "Samsung Tizen", glyph: "Tz", brands: "Samsung", pkg: ".wgt · tizen/sdb", tool: "tizen" },
  {
    id: "androidtv",
    os: "Android TV / Google TV",
    glyph: "A",
    brands: "Sony · Philips · Hisense — pendiente",
    pkg: "requiere Android SDK",
    tool: null,
    disabled: true,
  },
];

function loadDevices(): SavedDevice[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

export default function DeployPanel() {
  const [platform, setPlatform] = useState<Platform>("webos");
  const [tvIp, setTvIp] = useState("");
  const [macHost, setMacHost] = useState("");
  const [deviceName, setDeviceName] = useState("lgtv");
  const [securityProfile, setSecurityProfile] = useState("");
  const [tools, setTools] = useState<Tools | null>(null);
  const [devices, setDevices] = useState<SavedDevice[]>([]);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState("");
  const [browserUrl, setBrowserUrl] = useState("");

  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    setDevices(loadDevices());
    fetch("/api/deploy")
      .then((r) => r.json())
      .then((j) => {
        setTools(j.tools);
        if (j.macHost) setMacHost(j.macHost);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const meta = PLATFORMS.find((p) => p.id === platform)!;
  const toolMissing =
    tools && meta.tool && !tools[meta.tool] ? meta.tool : null;

  const persist = (next: SavedDevice[]) => {
    setDevices(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  };

  const saveDevice = () => {
    if (!tvIp.trim()) return;
    const name = prompt("Nombre para este dispositivo:", `${meta.os} · ${tvIp}`);
    if (!name) return;
    persist([
      ...devices.filter((d) => !(d.tvIp === tvIp && d.platform === platform)),
      { id: crypto.randomUUID(), name, platform, tvIp: tvIp.trim() },
    ]);
  };

  const loadDevice = (d: SavedDevice) => {
    setPlatform(d.platform === "androidtv" ? "webos" : d.platform);
    setTvIp(d.tvIp);
  };

  const deleteDevice = (id: string) =>
    persist(devices.filter((d) => d.id !== id));

  const run = async (action: Action) => {
    if (action === "browser") {
      setBrowserUrl(macHost ? `http://${macHost}` : "");
      return;
    }
    if (running) return;
    setLog("");
    setRunning(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch("/api/deploy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ platform, action, tvIp, macHost, deviceName, securityProfile }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        setLog(`✗ ${res.status}: ${await res.text()}\n`);
        return;
      }
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        setLog((prev) => prev + dec.decode(value, { stream: true }));
      }
    } catch (e: any) {
      if (e?.name !== "AbortError") setLog((p) => p + `\n✗ ${e?.message || e}\n`);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const stop = () => abortRef.current?.abort();

  const label = "mb-[10px] text-[10px] font-semibold uppercase tracking-[.08em] text-tx3";
  const input =
    "w-full rounded-[5px] border border-bd bg-sf2 px-[9px] py-[7px] font-mono text-[12px] text-tx1 outline-none placeholder:text-tx3 focus:border-gb";

  return (
    <div className="flex-1 overflow-y-auto bg-bg">
      <div className="mx-auto max-w-[760px] px-6 py-7">
        <div className="mb-6">
          <div className="mb-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[.16em] text-ga">
            Deploy TV
          </div>
          <h1 className="text-[19px] font-semibold tracking-[-0.01em] text-tx1">
            Instalar StreamProbe en una Smart TV
          </h1>
          <p className="mt-1 max-w-[60ch] text-[13px] leading-[1.5] text-tx2">
            La app es una URL: el launcher es un envoltorio que la abre en el runtime real
            de la tele. Elige plataforma, mete la IP y el botón empaqueta, instala y lanza.
          </p>
        </div>

        {/* 1 · Platform */}
        <div className="mb-6">
          <div className={label}>1 · Plataforma de la TV</div>
          <div className="grid grid-cols-2 gap-[10px]">
            {PLATFORMS.map((p, i) => {
              const sel = platform === p.id;
              const missing = tools && p.tool && !tools[p.tool];
              return (
                <button
                  key={p.id}
                  disabled={p.disabled}
                  onClick={() => !p.disabled && setPlatform(p.id)}
                  className={`relative rounded-[9px] border p-3 text-left transition ${
                    i === 2 ? "col-span-2" : ""
                  } ${
                    p.disabled
                      ? "cursor-not-allowed border-bd2 bg-sf2 opacity-40"
                      : sel
                        ? "border-ga bg-ga/[.08] shadow-[0_0_0_1px_rgba(29,185,83,.4)]"
                        : "border-bd2 bg-sf2 hover:border-bd"
                  }`}
                >
                  <span
                    className={`absolute right-3 top-3 h-[15px] w-[15px] rounded-full border-[1.5px] ${
                      sel ? "border-ga bg-ga shadow-[inset_0_0_0_3px_#0B0E16]" : "border-bd2 bg-bg"
                    }`}
                  />
                  {p.disabled && (
                    <span className="absolute right-9 top-[11px] rounded border border-bd2 bg-sf3 px-[5px] py-[1px] font-mono text-[9px] uppercase tracking-[.08em] text-tx2">
                      fase 2
                    </span>
                  )}
                  {missing && !p.disabled && (
                    <span className="absolute right-9 top-[11px] rounded border border-warn/40 bg-warn/10 px-[5px] py-[1px] font-mono text-[9px] uppercase tracking-[.08em] text-warn">
                      sin CLI
                    </span>
                  )}
                  <span className="flex items-center gap-2 text-[13.5px] font-semibold text-tx1">
                    <span
                      className={`grid h-[22px] w-[22px] place-items-center rounded-[6px] font-mono text-[11px] font-bold ${
                        sel ? "bg-ga text-bg" : "bg-sf3 text-tx1"
                      }`}
                    >
                      {p.glyph}
                    </span>
                    {p.os}
                  </span>
                  <span className="mt-1 block text-[11.5px] text-tx2">{p.brands}</span>
                  <span className="mt-[2px] block font-mono text-[10.5px] text-tx3">{p.pkg}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 2 · Network */}
        <div className="mb-6">
          <div className={label}>2 · Dirección de red</div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-[5px] block text-[11px] text-tx2">IP de la TV</label>
              <input
                className={input}
                placeholder="192.168.1.149"
                value={tvIp}
                onChange={(e) => setTvIp(e.target.value)}
              />
            </div>
            <div>
              <label className="mb-[5px] block text-[11px] text-tx2">Este Mac (dev server)</label>
              <input
                className={input}
                placeholder="192.168.1.176:3001"
                value={macHost}
                onChange={(e) => setMacHost(e.target.value)}
              />
            </div>
          </div>

          {/* Per-platform advanced */}
          <div className="mt-3 grid grid-cols-2 gap-3">
            {platform === "webos" && (
              <div>
                <label className="mb-[5px] block text-[11px] text-tx2">
                  Perfil ares (registrado)
                </label>
                <input
                  className={input}
                  placeholder="lgtv"
                  value={deviceName}
                  onChange={(e) => setDeviceName(e.target.value)}
                />
              </div>
            )}
            {platform === "tizen" && (
              <div>
                <label className="mb-[5px] block text-[11px] text-tx2">
                  Perfil de certificado (opcional)
                </label>
                <input
                  className={input}
                  placeholder="streamprobe"
                  value={securityProfile}
                  onChange={(e) => setSecurityProfile(e.target.value)}
                />
              </div>
            )}
          </div>

          {/* Saved devices */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-tx2">Guardados:</span>
            {devices.length === 0 && (
              <span className="text-[11px] text-tx3">ninguno todavía</span>
            )}
            {devices.map((d) => (
              <span
                key={d.id}
                className="group inline-flex items-center gap-[6px] rounded-[20px] border border-bd2 bg-sf2 py-[4px] pl-[10px] pr-[7px] font-mono text-[11px] text-tx1"
              >
                <button onClick={() => loadDevice(d)} className="inline-flex items-center gap-[6px]">
                  <span className="h-[6px] w-[6px] rounded-full bg-ga" />
                  {d.name}
                </button>
                <button
                  onClick={() => deleteDevice(d.id)}
                  className="text-tx3 transition hover:text-err"
                  title="Borrar"
                >
                  ×
                </button>
              </span>
            ))}
            {tvIp.trim() && (
              <button
                onClick={saveDevice}
                className="rounded-[20px] border border-dashed border-bd2 px-[10px] py-[4px] text-[11px] text-tx2 transition hover:border-ga hover:text-ga"
              >
                + guardar
              </button>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="mb-5 flex flex-wrap items-center gap-[10px]">
          {!running ? (
            <button
              onClick={() => run("deploy")}
              className="rounded-md bg-ga px-[18px] py-[10px] text-[13px] font-semibold text-white shadow-[0_8px_20px_-10px_rgba(29,185,83,.8)] transition hover:brightness-110"
            >
              ▶ Deploy
            </button>
          ) : (
            <button
              onClick={stop}
              className="rounded-md border border-bd bg-sf2 px-[18px] py-[10px] text-[13px] font-semibold text-tx2 transition hover:border-bd2 hover:text-tx1"
            >
              ■ Parar
            </button>
          )}
          <button
            onClick={() => run("package")}
            disabled={running}
            className="rounded-md border border-bd2 bg-transparent px-[16px] py-[10px] text-[13px] font-medium text-tx2 transition hover:border-bd hover:text-tx1 disabled:opacity-40"
          >
            Solo empaquetar
          </button>
          <button
            onClick={() => run("browser")}
            className="rounded-md border border-bd2 bg-transparent px-[16px] py-[10px] text-[13px] font-medium text-tx2 transition hover:border-bd hover:text-tx1"
          >
            Abrir en navegador
          </button>
        </div>

        {toolMissing && (
          <div className="mb-4 rounded-[6px] border border-warn/30 bg-warn/[.07] px-[11px] py-[8px] text-[11.5px] leading-[1.5] text-warn">
            No encuentro <span className="font-mono">{toolMissing}</span> en el PATH de este
            Mac. Instálalo (webOS: <span className="font-mono">@webos-tools/cli</span> · Tizen:
            Tizen Studio CLI) y arranca el dev server desde una terminal que lo tenga.
          </div>
        )}

        {browserUrl && (
          <div className="mb-4 rounded-[6px] border border-bd bg-sf1 px-[11px] py-[9px] text-[12px] leading-[1.6] text-tx2">
            Abre esta URL en el navegador de la tele (cero empaquetado, pero corre en el
            navegador, no en el runtime de app):
            <div className="mt-1 select-all font-mono text-[13px] text-ga">{browserUrl}</div>
          </div>
        )}

        {/* Console */}
        <div className="overflow-hidden rounded-[9px] border border-bd bg-[#070A10]">
          <div className="flex items-center gap-2 border-b border-bd px-3 py-[7px] font-mono text-[10px] uppercase tracking-[.1em] text-tx2">
            <span
              className={`h-[6px] w-[6px] rounded-full ${
                running ? "animate-blink-med bg-ga" : "bg-tx3"
              }`}
            />
            Salida {running ? "· en curso" : ""}
          </div>
          <pre
            ref={logRef}
            className="max-h-[280px] overflow-auto px-[14px] py-3 font-mono text-[11.5px] leading-[1.7] text-tx1"
          >
            {log || <span className="text-tx3">La salida del deploy aparecerá aquí…</span>}
          </pre>
        </div>
      </div>
    </div>
  );
}
