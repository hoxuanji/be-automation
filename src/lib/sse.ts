/** Minimal SSE event reader for fetch() bodies. */
export type SSEEvent = {
  event: string;
  data: unknown;
};

export async function* readSSE(
  response: Response,
  signal?: AbortSignal
): AsyncGenerator<SSEEvent, void, void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const event = parseSSE(raw);
        if (event) yield event;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSSE(raw: string): SSEEvent | null {
  let event = "message";
  let dataRaw = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataRaw += line.slice(5).trim();
  }
  if (!dataRaw) return null;
  try {
    return { event, data: JSON.parse(dataRaw) };
  } catch {
    return { event, data: dataRaw };
  }
}
