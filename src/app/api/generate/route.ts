import { NextRequest } from "next/server";
import archiver from "archiver";
import { generateRequestSchema } from "@/lib/schema";
import { generate } from "@/lib/generators";
import { safeName } from "@/lib/generators/types";
import { checkRateLimit, getRateLimitKey } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!checkRateLimit(getRateLimitKey(req), 20)) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = generateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "validation_error", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { config, endpoints, entities } = parsed.data;
  const files = generate(config, endpoints, entities ?? []);

  const archive = archiver("zip", { zlib: { level: 9 } });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      archive.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
      });
      archive.on("end", () => controller.close());
      archive.on("warning", (err) => {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          controller.error(err);
        }
      });
      archive.on("error", (err) => controller.error(err));

      for (const f of files) {
        archive.append(f.content, { name: f.path, mode: f.mode ?? 0o644 });
      }
      archive.finalize();
    },
    cancel() {
      archive.abort();
    },
  });

  const name = safeName(config.name);
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${name}.zip"`,
      "Cache-Control": "no-store",
      "X-Helios-Files": String(files.length),
    },
  });
}
