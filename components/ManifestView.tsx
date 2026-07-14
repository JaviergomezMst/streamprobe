"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { fmtBytes, fmtTime } from "@/lib/fmt";
import type { CapturedManifest, DashInfo } from "@/lib/manifest";

interface Props {
  manifests: CapturedManifest[];
  error: string | null;
  loading: boolean;
}

function highlight(line: string, q: string): React.ReactNode {
  if (!q) return line;
  const idx = line.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return line;
  return (
    <>
      {line.slice(0, idx)}
      <mark className="bg-ga/30 text-tx1">{line.slice(idx, idx + q.length)}</mark>
      {line.slice(idx + q.length)}
    </>
  );
}

function secs(n?: number): string {
  if (n == null) return "—";
  return n.toFixed(2) + "s";
}

function PeriodsTable({ dash }: { dash: DashInfo }) {
  return (
    <div className="border-t border-bd bg-sf1 px-2 py-2">
      <div className="mb-1 flex items-center gap-2">
        <span className="font-mono text-[10px] font-semibold text-tx1">
          {dash.periods.length} period{dash.periods.length === 1 ? "" : "s"}
        </span>
        {dash.hasScte35 && (
          <span className="rounded bg-[#22d3ee]/20 px-[6px] py-[1px] font-mono text-[9px] font-semibold text-[#22d3ee]">
            SCTE-35 · {dash.scte35Events} event{dash.scte35Events === 1 ? "" : "s"}
          </span>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse font-mono text-[9px]">
          <thead>
            <tr className="text-tx3">
              <th className="px-1 py-[2px] text-left font-semibold">#</th>
              <th className="px-1 py-[2px] text-left font-semibold">id</th>
              <th className="px-1 py-[2px] text-right font-semibold">start</th>
              <th className="px-1 py-[2px] text-right font-semibold">dur</th>
              <th className="px-1 py-[2px] text-left font-semibold">video</th>
              <th className="px-1 py-[2px] text-left font-semibold">audio</th>
              <th className="px-1 py-[2px] text-left font-semibold">scte35</th>
            </tr>
          </thead>
          <tbody>
            {dash.periods.map((p, i) => {
              const prev = i > 0 ? dash.periods[i - 1] : undefined;
              const vChanged =
                !!prev &&
                prev.videoCodecs.join() !== p.videoCodecs.join() &&
                p.videoCodecs.length > 0;
              const aChanged =
                !!prev &&
                prev.audioCodecs.join() !== p.audioCodecs.join() &&
                p.audioCodecs.length > 0;
              return (
                <tr key={i} className="border-t border-bd/50 text-tx2">
                  <td className="px-1 py-[2px]">{p.index}</td>
                  <td className="px-1 py-[2px] text-tx1">{p.id ?? "—"}</td>
                  <td className="px-1 py-[2px] text-right">
                    {secs(p.start)}
                    {p.gapBefore != null && (
                      <span
                        className="ml-1 text-warn"
                        title={`Gap of ${p.gapBefore.toFixed(2)}s before this period`}
                      >
                        ⚠gap {p.gapBefore.toFixed(2)}s
                      </span>
                    )}
                  </td>
                  <td className="px-1 py-[2px] text-right">
                    {p.duration != null ? (
                      <span title="Period@duration (explicit)">{secs(p.duration)}</span>
                    ) : p.derivedDuration != null ? (
                      <span
                        className="text-tx2"
                        title={
                          "Period duration = next Period@start − start (DASH spec)" +
                          (p.mediaDuration != null
                            ? ` · ${p.mediaDuration.toFixed(2)}s available in timeline`
                            : "")
                        }
                      >
                        {secs(p.derivedDuration)}
                        {p.mediaDuration != null &&
                          p.mediaDuration < p.derivedDuration - 0.5 && (
                            <span className="ml-1 text-tx3">
                              (~{p.mediaDuration.toFixed(0)}s avail)
                            </span>
                          )}
                      </span>
                    ) : p.mediaDuration != null ? (
                      <span
                        className="text-tx3"
                        title="Media available in SegmentTimeline (current live period)"
                      >
                        {p.durationEstimated ? "≈" : "~"}
                        {secs(p.mediaDuration)}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className={`px-1 py-[2px] ${vChanged ? "text-warn" : "text-tx2"}`}>
                    {p.videoCodecs.join(", ") || "—"}
                    {vChanged && " ⤳"}
                  </td>
                  <td className={`px-1 py-[2px] ${aChanged ? "text-warn" : "text-tx2"}`}>
                    {p.audioCodecs.join(", ") || "—"}
                    {aChanged && " ⤳"}
                  </td>
                  <td className="px-1 py-[2px]">
                    {p.hasScte35 ? (
                      <span className="text-[#22d3ee]">{p.scte35Events}</span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-1 text-[9px] leading-[1.5] text-tx3">
        ⚠ = real gap (explicit @duration leaves a hole) · ⤳ = codec change across a
        boundary. Periods without @duration run until the next @start (contiguous by
        spec). &quot;avail&quot; = media currently in the live timeline (DVR window).
      </div>
    </div>
  );
}

function ManifestBody({ text, q }: { text: string; q: string }) {
  const rows = useMemo(() => {
    const lines = text.split("\n").map((t, i) => ({ n: i + 1, text: t }));
    if (!q.trim()) return lines;
    const needle = q.toLowerCase();
    return lines.filter((r) => r.text.toLowerCase().includes(needle));
  }, [text, q]);

  if (rows.length === 0) {
    return <div className="p-3 text-center text-tx3">No matches</div>;
  }
  return (
    <div className="max-h-[40vh] overflow-auto border-t border-bd bg-bg px-2 py-1 font-mono text-[10px] leading-[1.7]">
      {rows.map((r) => (
        <div key={r.n} className="flex gap-2 hover:bg-sf2">
          <span className="w-[38px] flex-shrink-0 select-none text-right text-tx3">
            {r.n}
          </span>
          <span className="whitespace-pre-wrap break-all text-tx1">
            {highlight(r.text, q.trim())}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function ManifestView({ manifests, error, loading }: Props) {
  const [q, setQ] = useState("");
  const [openIds, setOpenIds] = useState<Set<number>>(new Set());
  const initRef = useRef(false);

  // Open the first captured manifest once, then leave the user in control.
  useEffect(() => {
    if (!initRef.current && manifests.length) {
      initRef.current = true;
      setOpenIds(new Set([manifests[0].id]));
    }
    if (manifests.length === 0) initRef.current = false;
  }, [manifests]);

  const toggle = (id: number) =>
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (loading && manifests.length === 0) {
    return <div className="p-5 text-center text-tx3">Fetching manifest…</div>;
  }
  if (manifests.length === 0) {
    return (
      <div className="p-4 text-center">
        {error ? (
          <span className="text-err">{error}</span>
        ) : (
          <span className="text-tx3">No manifests captured yet</span>
        )}
      </div>
    );
  }

  const query = q.trim();

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Search */}
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-bd bg-sf1 px-2 py-2">
        <span className="font-mono text-[10px] text-tx3">
          {manifests.length} manifest{manifests.length === 1 ? "" : "s"}
        </span>
        <input
          type="text"
          placeholder="Search inside manifests…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="flex-1 rounded-[5px] border border-bd bg-sf2 px-[9px] py-[5px] font-mono text-[11px] text-tx1 outline-none placeholder:text-tx3 focus:border-ga"
        />
      </div>

      {/* List (newest first) */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {manifests.map((m) => {
          const open = openIds.has(m.id);
          const matches = query
            ? m.text
                .split("\n")
                .filter((l) => l.toLowerCase().includes(query.toLowerCase()))
                .length
            : 0;
          const badge =
            m.periodCount != null
              ? m.isMultiperiod
                ? { txt: `MULTIPERIOD · ${m.periodCount}`, cls: "bg-warn/20 text-warn" }
                : { txt: "SINGLE PERIOD", cls: "bg-ga/[.12] text-ga" }
              : { txt: m.format.toUpperCase(), cls: "bg-sf2 text-tx2" };

          return (
            <div key={m.id} className="border-b border-bd">
              <div
                onClick={() => toggle(m.id)}
                className="flex cursor-pointer items-center gap-2 px-2 py-[6px] hover:bg-sf2"
              >
                <span className="w-[10px] flex-shrink-0 text-tx3">
                  {open ? "▾" : "▸"}
                </span>
                <span className="w-[80px] flex-shrink-0 font-mono text-[10px] text-tx3">
                  {fmtTime(m.time)}
                </span>
                <span
                  className={`flex-shrink-0 rounded px-2 py-[1px] font-mono text-[9px] font-semibold ${badge.cls}`}
                >
                  {badge.txt}
                </span>
                {m.dash?.hasScte35 && (
                  <span className="flex-shrink-0 rounded bg-[#22d3ee]/20 px-[5px] py-[1px] font-mono text-[9px] font-semibold text-[#22d3ee]">
                    SCTE-35
                  </span>
                )}
                <span className="flex-shrink-0 font-mono text-[9px] uppercase text-tx3">
                  {m.source}
                </span>
                {m.bytes != null && (
                  <span className="flex-shrink-0 font-mono text-[9px] text-tx3">
                    {fmtBytes(m.bytes, "")}
                  </span>
                )}
                {query && (
                  <span className="ml-auto flex-shrink-0 font-mono text-[9px] text-ga">
                    {matches} match{matches === 1 ? "" : "es"}
                  </span>
                )}
              </div>
              {m.note && open && (
                <div className="px-2 pb-1 font-mono text-[9px] text-tx3">
                  ⚠ {m.note}
                </div>
              )}
              {open && m.dash && m.dash.periods.length > 0 && (
                <PeriodsTable dash={m.dash} />
              )}
              {open && <ManifestBody text={m.text} q={q} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
