import { type NextRequest } from "next/server";
import { spawn, spawnSync } from "node:child_process";
import { networkInterfaces } from "node:os";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Node runtime: we shell out to the TV toolchains (ares / tizen / sdb) that
// live on this machine, and rewrite the launcher's redirect URL on disk.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Platform = "webos" | "tizen";
// "browser" is handled entirely client-side (just opens the URL) and never
// reaches this route.
type Action = "deploy" | "package";

interface Body {
  platform: Platform;
  action: Action;
  tvIp: string;
  macHost: string; // "192.168.1.176:3001"
  deviceName?: string; // webOS ares profile (default "lgtv")
  securityProfile?: string; // Tizen signing profile
}

interface Step {
  cmd: string;
  args: string[];
  // A non-zero exit does not abort the run (e.g. re-pointing a device that
  // may not exist yet, or an sdb that is already connected).
  optional?: boolean;
}

const ROOT = process.cwd();
const LAUNCHERS: Record<Platform, string> = {
  webos: path.join(ROOT, "tv-launchers", "webos", "index.html"),
  tizen: path.join(ROOT, "tv-launchers", "tizen", "index.html"),
};
const DIST = path.join(ROOT, "tv-launchers", "dist");
const IPK = path.join(DIST, "com.streamprobe.app_1.0.0_all.ipk");

function lanIp(): string {
  const nets = networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const ni of list || []) {
      if (ni.family === "IPv4" && !ni.internal) return ni.address;
    }
  }
  return "";
}

function hasTool(name: string): boolean {
  try {
    return spawnSync("which", [name], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}

// GET: prefill the panel — this machine's LAN address (so the launcher points
// at the dev server, not localhost) and which toolchains are installed.
export function GET(req: NextRequest) {
  const host = req.headers.get("host") || "";
  const port = host.includes(":") ? host.split(":")[1] : "3001";
  const ip = lanIp();
  const isLocal = /^(localhost|127\.|\[?::1)/.test(host);
  const macHost = isLocal ? (ip ? `${ip}:${port}` : "") : host;
  return Response.json({
    macHost,
    lanIp: ip,
    port,
    tools: { ares: hasTool("ares-package"), tizen: hasTool("tizen"), sdb: hasTool("sdb") },
  });
}

// Point the launcher's redirect at the dev server the caller entered, so the
// packaged app always loads the right host. Single source of truth: the two
// index.html files stop drifting apart.
async function writeLauncherUrl(platform: Platform, macHost: string) {
  const file = LAUNCHERS[platform];
  const html = await readFile(file, "utf8");
  const next = html.replace(
    /https?:\/\/[0-9.]+(?::\d+)?/,
    `http://${macHost}`,
  );
  if (next !== html) await writeFile(file, next);
  return `http://${macHost}`;
}

function steps(body: Body): Step[] {
  const { platform, action, tvIp } = body;
  if (platform === "webos") {
    const dev = body.deviceName?.trim() || "lgtv";
    const pkg: Step[] = [
      { cmd: "ares-package", args: ["tv-launchers/webos", "-o", "tv-launchers/dist"] },
    ];
    if (action === "package") return pkg;
    return [
      // Re-point the registered profile at the IP entered (keeps the dev key).
      { cmd: "ares-setup-device", args: ["-m", dev, "-i", `host=${tvIp}`], optional: true },
      ...pkg,
      { cmd: "ares-install", args: ["-d", dev, IPK] },
      { cmd: "ares-launch", args: ["-d", dev, "com.streamprobe.app"] },
    ];
  }

  // Tizen
  const profile = body.securityProfile?.trim();
  const wgt = "tv-launchers/tizen/StreamProbe.wgt";
  const pkgArgs = ["package", "-t", "wgt", "-o", "tv-launchers/tizen", "--", "tv-launchers/tizen"];
  if (profile) pkgArgs.splice(2, 0, "-s", profile);
  const pkg: Step[] = [{ cmd: "tizen", args: pkgArgs }];
  if (action === "package") return pkg;
  return [
    { cmd: "sdb", args: ["connect", tvIp], optional: true },
    ...pkg,
    { cmd: "tizen", args: ["install", "-n", wgt, "-t", tvIp] },
  ];
}

function runStep(step: Step, write: (s: string) => void): Promise<number> {
  return new Promise((resolve) => {
    write(`\n$ ${step.cmd} ${step.args.join(" ")}\n`);
    let child;
    try {
      child = spawn(step.cmd, step.args, { cwd: ROOT, env: process.env });
    } catch (e: any) {
      write(`✗ no se pudo lanzar: ${e?.message || e}\n`);
      resolve(127);
      return;
    }
    child.stdout.on("data", (d) => write(d.toString()));
    child.stderr.on("data", (d) => write(d.toString()));
    child.on("error", (e: any) => {
      write(`✗ ${e?.code === "ENOENT" ? `'${step.cmd}' no está en el PATH` : e?.message}\n`);
      resolve(127);
    });
    child.on("close", (code) => resolve(code ?? 0));
  });
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as Body;

  if (!body?.tvIp?.trim() && body.action !== "package") {
    return new Response("Falta la IP de la TV", { status: 400 });
  }
  if (!body?.macHost?.trim()) {
    return new Response("Falta la dirección de este Mac (IP:puerto)", { status: 400 });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const write = (s: string) => {
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          /* client went away */
        }
      };

      try {
        const url = await writeLauncherUrl(body.platform, body.macHost.trim());
        write(`▸ Launcher ${body.platform} → ${url}\n`);

        const list = steps(body);
        for (const step of list) {
          const code = await runStep(step, write);
          if (code === 0) {
            write(`✓ ok\n`);
          } else if (step.optional) {
            write(`… continúo (paso opcional, salió ${code})\n`);
          } else {
            write(`\n✗ FALLÓ en '${step.cmd}' (código ${code}). Paro aquí.\n`);
            controller.close();
            return;
          }
        }
        write(`\n✔ Deploy completado.\n`);
      } catch (e: any) {
        write(`\n✗ Error: ${e?.message || e}\n`);
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-cache, no-transform",
    },
  });
}
