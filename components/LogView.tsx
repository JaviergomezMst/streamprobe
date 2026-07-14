"use client";

import { useEffect, useRef, useState } from "react";
import { fmtBytes, fmtTime } from "@/lib/fmt";
import ManifestView from "./ManifestView";
import BufferView from "./BufferView";
import type { LogEntry, BufferedState } from "@/hooks/usePlayer";
import type { CapturedManifest } from "@/lib/manifest";
import type { LogType, NetworkEntry, NetworkKind } from "@/lib/engines/types";

const TYPE_COLOR: Record<LogType, string> = {
  info: "text-tx2",
  abr: "text-ga",
  buffer: "text-warn",
  error: "text-err",
  drm: "text-[#a855f7]",
  warn: "text-warn",
  scte: "text-[#22d3ee]",
};

const KIND_COLOR: Record<NetworkKind, string> = {
  manifest: "text-gb",
  segment: "text-ga",
  init: "text-tx2",
  license: "text-[#a855f7]",
  other: "text-tx3",
};

type Tab = "events" | "abr" | "scte" | "net" | "manifest" | "buffer";

function shortUrl(u: string): string {
  try {
    const parts = u.split("?")[0].split("/");
    return parts[parts.length - 1] || u;
  } catch {
    return u;
  }
}

export default function LogView({
  evLog,
  abrLog,
  scteLog,
  netLog,
  manifests,
  manifestError,
  manifestLoading,
  buffered,
  onClear,
}: {
  evLog: LogEntry[];
  abrLog: LogEntry[];
  scteLog: LogEntry[];
  netLog: NetworkEntry[];
  manifests: CapturedManifest[];
  manifestError: string | null;
  manifestLoading: boolean;
  buffered: BufferedState;
  onClear: (kind: "events" | "abr" | "scte" | "net" | "manifest") => void;
}) {
  const [tab, setTab] = useState<Tab>("events");
  const bottomRef = useRef<HTMLDivElement>(null);

  const logArr = tab === "abr" ? abrLog : tab === "scte" ? scteLog : evLog;
  const count = tab === "net" ? netLog.length : logArr.length;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [count, tab]);

  const TABS: { id: Tab; label: string }[] = [
    { id: "events", label: "Events" },
    { id: "abr", label: "ABR switches" },
    { id: "scte", label: scteLog.length ? `SCTE-35 (${scteLog.length})` : "SCTE-35" },
    { id: "buffer", label: "Buffer" },
    { id: "net", label: "Network" },
    {
      id: "manifest",
      label: manifests.length ? `Manifest (${manifests.length})` : "Manifest",
    },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex flex-shrink-0 items-center border-b border-bd bg-sf1">
        {TABS.map((t) => (
          <div
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`cursor-pointer border-b-2 px-3 py-[5px] text-[10px] font-semibold uppercase tracking-[.05em] transition ${
              tab === t.id
                ? "border-ga text-tx1"
                : "border-transparent text-tx3 hover:text-tx2"
            }`}
          >
            {t.label}
          </div>
        ))}
        {tab !== "buffer" && (
          <button
            onClick={() => onClear(tab)}
            title={`Clear ${tab}`}
            className="ml-auto mr-2 rounded border border-bd px-2 py-[2px] text-[10px] text-tx2 transition hover:border-err hover:text-err"
          >
            ✕ Clear
          </button>
        )}
      </div>

      {tab === "manifest" ? (
        <div className="min-h-0 flex-1">
          <ManifestView
            manifests={manifests}
            error={manifestError}
            loading={manifestLoading}
          />
        </div>
      ) : tab === "buffer" ? (
        <div className="min-h-0 flex-1">
          <BufferView buffered={buffered} />
        </div>
      ) : (
      <div className="flex-1 overflow-y-auto px-2 py-[6px] font-mono text-[10px] leading-[1.8]">
        {tab === "net" ? (
          netLog.length === 0 ? (
            <div className="p-5 text-center text-tx3">No network activity yet</div>
          ) : (
            <>
              {netLog.slice(-400).map((e, i) => (
                <div
                  key={i}
                  className="flex gap-2 py-px hover:bg-sf2"
                  title={e.url}
                >
                  <span className="w-[55px] flex-shrink-0 text-tx3">
                    {fmtTime(e.time)}
                  </span>
                  <span
                    className={`w-[58px] flex-shrink-0 ${KIND_COLOR[e.kind]}`}
                  >
                    {e.kind.toUpperCase()}
                  </span>
                  <span className="w-[38px] flex-shrink-0 text-tx2">
                    {e.mediaType ? e.mediaType.slice(0, 3) : "—"}
                  </span>
                  <span className="w-[52px] flex-shrink-0 text-right text-tx1">
                    {fmtBytes(e.bytes)}
                  </span>
                  <span className="w-[46px] flex-shrink-0 text-right text-tx2">
                    {e.durationMs != null ? `${e.durationMs}ms` : "—"}
                  </span>
                  {e.sent ? (
                    <span
                      className="w-[34px] flex-shrink-0 text-center text-[#22d3ee]"
                      title={
                        "Injected headers:\n" +
                        [
                          e.sent.origin && `Origin: ${e.sent.origin}`,
                          e.sent.referer && `Referer: ${e.sent.referer}`,
                          e.sent.userAgent && `User-Agent: ${e.sent.userAgent}`,
                        ]
                          .filter(Boolean)
                          .join("\n")
                      }
                    >
                      hdr✓
                    </span>
                  ) : (
                    <span className="w-[34px] flex-shrink-0 text-center text-tx3">
                      —
                    </span>
                  )}
                  <span className="flex-1 truncate text-tx2">
                    {shortUrl(e.url)}
                  </span>
                </div>
              ))}
              <div ref={bottomRef} />
            </>
          )
        ) : logArr.length === 0 ? (
          <div className="p-5 text-center text-tx3">
            {tab === "abr"
              ? "No ABR switches yet"
              : tab === "scte"
                ? "No SCTE-35 / DASH events yet"
                : "Waiting for stream…"}
          </div>
        ) : (
          <>
            {logArr.slice(-300).map((e, i) => (
              <div key={i} className="flex gap-2 py-px hover:bg-sf2">
                <span className="w-[55px] flex-shrink-0 text-tx3">
                  {fmtTime(e.time)}
                </span>
                <span className={`w-[62px] flex-shrink-0 ${TYPE_COLOR[e.type]}`}>
                  {e.type.toUpperCase()}
                </span>
                <span className="flex-1 break-all text-tx1">{e.msg}</span>
              </div>
            ))}
            <div ref={bottomRef} />
          </>
        )}
      </div>
      )}
    </div>
  );
}
