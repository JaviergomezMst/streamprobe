import { detectFormat, type StreamFormat } from "./format";

/** Refine the stream format using the manifest body when the URL was ambiguous. */
export function detectFormatFromText(
  text: string,
  url: string,
  hint?: StreamFormat
): StreamFormat {
  let format = hint ?? detectFormat(url);
  if (format === "unknown" || format === "smooth") {
    if (/<MPD[\s>]/.test(text)) format = "dash";
    else if (/#EXTM3U/.test(text)) format = "hls";
    else if (/<SmoothStreamingMedia/.test(text)) format = "smooth";
  }
  return format;
}

/** Per-period breakdown of a DASH MPD. */
export interface DashPeriod {
  index: number;
  id?: string;
  start?: number; // seconds
  duration?: number; // seconds, from Period@duration
  derivedDuration?: number; // seconds = next Period@start − this @start (DASH spec)
  mediaDuration?: number; // seconds of media currently in the SegmentTimeline (live: DVR window)
  durationEstimated?: boolean; // true if a SegmentTimeline used r<0 (repeat-to-end)
  videoCodecs: string[];
  audioCodecs: string[];
  eventStreams: number;
  scte35Events: number;
  hasScte35: boolean;
  gapBefore?: number; // seconds gap from previous period's end
}

export interface DashInfo {
  periods: DashPeriod[];
  scte35EventStreams: number;
  scte35Events: number;
  hasScte35: boolean;
}

/** A single manifest captured during a session (initial fetch or live refresh). */
export interface CapturedManifest {
  id: number;
  time: Date;
  format: StreamFormat;
  periodCount?: number;
  isMultiperiod: boolean;
  text: string;
  bytes?: number;
  note?: string;
  source: "fetch" | "engine";
  dash?: DashInfo;
}

/** Parse an ISO-8601 duration (e.g. "PT1M30.5S", "PT0H0M12.000S") to seconds. */
export function parseIsoDuration(v?: string | null): number | undefined {
  if (!v) return undefined;
  const m = v.match(
    /^-?P(?:([\d.]+)Y)?(?:([\d.]+)M)?(?:([\d.]+)D)?(?:T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?)?$/
  );
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s] = m;
  return (
    (parseFloat(y || "0") * 365 * 86400) +
    (parseFloat(mo || "0") * 30 * 86400) +
    (parseFloat(d || "0") * 86400) +
    (parseFloat(h || "0") * 3600) +
    (parseFloat(mi || "0") * 60) +
    parseFloat(s || "0")
  );
}

const SCTE_RE = /scte(?:[-_:]?35)/i;

/**
 * Derive a period's media duration by summing its SegmentTimeline (used when
 * Period@duration is absent, as in live/dynamic MPDs). Returns seconds plus a
 * flag when an `r<0` (repeat-to-end) entry made the sum an estimate.
 */
function timelineDuration(periodEl: Element): {
  dur?: number;
  estimated: boolean;
} {
  const templates = Array.from(periodEl.getElementsByTagName("*")).filter(
    (el) =>
      el.localName === "SegmentTemplate" &&
      Array.from(el.children).some((c) => c.localName === "SegmentTimeline")
  );
  if (!templates.length) return { estimated: false };

  const isVideo = (el: Element): boolean => {
    let n: Element | null = el;
    while (n) {
      if (n.localName === "AdaptationSet") {
        const m = n.getAttribute("mimeType") || n.getAttribute("contentType") || "";
        return /video/i.test(m);
      }
      n = n.parentElement;
    }
    return false;
  };

  const tmpl = templates.find(isVideo) || templates[0];
  const timescale = parseInt(tmpl.getAttribute("timescale") || "1", 10) || 1;
  const timeline = Array.from(tmpl.children).find(
    (c) => c.localName === "SegmentTimeline"
  );
  if (!timeline) return { estimated: false };

  let ticks = 0;
  let estimated = false;
  for (const s of Array.from(timeline.children)) {
    if (s.localName !== "S") continue;
    const d = parseFloat(s.getAttribute("d") || "0");
    const rAttr = s.getAttribute("r");
    let count = 1;
    if (rAttr != null) {
      const r = parseInt(rAttr, 10);
      if (r >= 0) count = r + 1;
      else estimated = true; // repeat-to-end: exact count unknown here
    }
    ticks += d * count;
  }
  return { dur: ticks / timescale, estimated };
}

/** Extract period structure and SCTE-35 markers from a DASH MPD. */
export function parseDashInfo(xml: string): DashInfo | null {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, "application/xml");
    if (doc.querySelector("parsererror")) return null;
  } catch {
    return null;
  }
  const all = Array.from(doc.getElementsByTagName("*"));
  const periodEls = all.filter((el) => el.localName === "Period");
  if (!periodEls.length) return null;

  let totalStreams = 0;
  let totalEvents = 0;

  const periods: DashPeriod[] = periodEls.map((p, index) => {
    const kids = Array.from(p.getElementsByTagName("*"));
    const adapts = kids.filter((el) => el.localName === "AdaptationSet");
    const videoCodecs = new Set<string>();
    const audioCodecs = new Set<string>();
    for (const a of adapts) {
      const mime =
        a.getAttribute("mimeType") ||
        a.getAttribute("contentType") ||
        "";
      const reps = Array.from(a.getElementsByTagName("*")).filter(
        (el) => el.localName === "Representation"
      );
      const codecs = [
        a.getAttribute("codecs"),
        ...reps.map((r) => r.getAttribute("codecs")),
      ].filter(Boolean) as string[];
      const bucket = /audio/i.test(mime) ? audioCodecs : videoCodecs;
      codecs.forEach((c) => bucket.add(c));
    }

    const eventStreamEls = kids.filter((el) => el.localName === "EventStream");
    let scte35Events = 0;
    let scteStreams = 0;
    for (const es of eventStreamEls) {
      const scheme = es.getAttribute("schemeIdUri") || "";
      const evs = Array.from(es.getElementsByTagName("*")).filter(
        (el) => el.localName === "Event"
      ).length;
      if (SCTE_RE.test(scheme)) {
        scteStreams++;
        scte35Events += evs;
      }
    }
    totalStreams += scteStreams;
    totalEvents += scte35Events;

    const explicitDur = parseIsoDuration(p.getAttribute("duration"));
    let mediaDuration: number | undefined;
    let durationEstimated: boolean | undefined;
    if (explicitDur == null) {
      const td = timelineDuration(p);
      mediaDuration = td.dur;
      durationEstimated = td.dur != null ? td.estimated : undefined;
    }

    return {
      index,
      id: p.getAttribute("id") || undefined,
      start: parseIsoDuration(p.getAttribute("start")),
      duration: explicitDur,
      mediaDuration,
      durationEstimated,
      videoCodecs: [...videoCodecs],
      audioCodecs: [...audioCodecs],
      eventStreams: eventStreamEls.length,
      scte35Events,
      hasScte35: scteStreams > 0,
    };
  });

  // Per the DASH spec, a period without @duration lasts until the next
  // period's @start, so those boundaries are contiguous by definition.
  // Record that spec duration for display...
  for (let i = 0; i < periods.length - 1; i++) {
    const cur = periods[i];
    const next = periods[i + 1];
    if (cur.start != null && next.start != null) {
      cur.derivedDuration = next.start - cur.start;
    }
  }
  // ...and only flag a REAL gap when an explicit @duration leaves a hole
  // (or overlap) versus the next period's start.
  for (let i = 1; i < periods.length; i++) {
    const prev = periods[i - 1];
    const cur = periods[i];
    if (prev.start != null && prev.duration != null && cur.start != null) {
      const gap = cur.start - (prev.start + prev.duration);
      if (Math.abs(gap) > 0.05) cur.gapBefore = gap;
    }
  }

  return {
    periods,
    scte35EventStreams: totalStreams,
    scte35Events: totalEvents,
    hasScte35: totalStreams > 0,
  };
}

/** Count DASH <Period> elements (namespace-prefix aware). */
export function countPeriods(xml: string): number {
  try {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    if (!doc.querySelector("parsererror")) {
      const periods = Array.from(doc.getElementsByTagName("*")).filter(
        (el) => el.localName === "Period"
      );
      if (periods.length) return periods.length;
    }
  } catch {
    /* fall through to regex */
  }
  return (xml.match(/<([\w-]+:)?Period[\s>/]/g) || []).length;
}
