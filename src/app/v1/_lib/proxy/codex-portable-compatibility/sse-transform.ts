import { PortableCompatibilityError } from "./errors";

type SseLine = {
  content: string;
  raw: string;
  ending: "\n" | "\r\n";
};

export type SseJsonTransformResult = {
  payload: unknown;
  changed: boolean;
};

export type SseTransformHooks = {
  transformJson: (payload: unknown) => SseJsonTransformResult;
  onFailure: (error: unknown) => void;
  onFinalize: () => void;
};

function splitLine(raw: string): SseLine {
  if (raw.endsWith("\r\n")) {
    return { content: raw.slice(0, -2), raw, ending: "\r\n" };
  }
  if (raw.endsWith("\n")) {
    return { content: raw.slice(0, -1), raw, ending: "\n" };
  }
  throw new Error("SSE line must end with LF or CRLF.");
}

function dataValue(line: SseLine): string | null {
  if (line.content.startsWith(":")) return null;
  const colon = line.content.indexOf(":");
  const field = colon === -1 ? line.content : line.content.slice(0, colon);
  if (field !== "data") return null;
  if (colon === -1) return "";
  const value = line.content.slice(colon + 1);
  return value.startsWith(" ") ? value.slice(1) : value;
}

function restoreEvent(lines: SseLine[], hooks: SseTransformHooks): string {
  const dataIndexes: number[] = [];
  const values: string[] = [];
  lines.forEach((line, index) => {
    const value = dataValue(line);
    if (value !== null) {
      dataIndexes.push(index);
      values.push(value);
    }
  });
  if (dataIndexes.length === 0) return lines.map((line) => line.raw).join("");

  const data = values.join("\n");
  if (data === "[DONE]") return lines.map((line) => line.raw).join("");

  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    throw new PortableCompatibilityError("malformed_response", {
      fieldPath: "event.data",
    });
  }

  const transformed = hooks.transformJson(payload);
  if (!transformed.changed) return lines.map((line) => line.raw).join("");

  const encoded = JSON.stringify(transformed.payload);
  const firstDataIndex = dataIndexes[0];
  const dataIndexSet = new Set(dataIndexes);
  return lines
    .map((line, index) => {
      if (index === firstDataIndex) return `data: ${encoded}${line.ending}`;
      return dataIndexSet.has(index) ? "" : line.raw;
    })
    .join("");
}

function safeErrorFrame(error: unknown): string {
  const compatibilityError =
    error instanceof PortableCompatibilityError
      ? error
      : new PortableCompatibilityError("malformed_response");
  return [
    "event: error",
    `data: ${JSON.stringify({
      type: "error",
      error: {
        type: compatibilityError.errorType,
        message: compatibilityError.message,
      },
    })}`,
    "",
    "",
  ].join("\n");
}

export function transformPortableSseResponse(
  response: Response,
  hooks: SseTransformHooks
): Response {
  if (!response.body) {
    hooks.onFailure(
      new PortableCompatibilityError("malformed_response", {
        fieldPath: "response.body",
      })
    );
    hooks.onFinalize();
    throw new PortableCompatibilityError("malformed_response", {
      fieldPath: "response.body",
    });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pendingText = "";
  let eventLines: SseLine[] = [];
  let finalized = false;
  let cancelled = false;
  let closed = false;

  const finalize = () => {
    if (finalized) return;
    finalized = true;
    hooks.onFinalize();
  };

  const releaseReader = () => {
    try {
      reader.releaseLock();
    } catch {}
  };

  const consume = (text: string): string[] => {
    const output: string[] = [];
    pendingText += text;
    while (true) {
      const newlineIndex = pendingText.indexOf("\n");
      if (newlineIndex < 0) return output;
      const rawLine = pendingText.slice(0, newlineIndex + 1);
      pendingText = pendingText.slice(newlineIndex + 1);
      const line = splitLine(rawLine);
      eventLines.push(line);
      if (line.content.length === 0) {
        output.push(restoreEvent(eventLines, hooks));
        eventLines = [];
      }
    }
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed || cancelled) return;
      try {
        while (!cancelled && !closed) {
          const { done, value } = await reader.read();
          if (done) {
            const output = consume(decoder.decode());
            if (pendingText.length > 0 || eventLines.length > 0) {
              throw new PortableCompatibilityError("malformed_response", {
                fieldPath: "event.framing",
              });
            }
            for (const text of output) {
              if (text.length > 0) controller.enqueue(encoder.encode(text));
            }
            closed = true;
            controller.close();
            finalize();
            releaseReader();
            return;
          }
          const output = value ? consume(decoder.decode(value, { stream: true })) : [];
          for (const text of output) {
            if (text.length > 0) controller.enqueue(encoder.encode(text));
          }
          if (output.length > 0) return;
        }
      } catch (error) {
        if (!cancelled) {
          hooks.onFailure(error);
          try {
            controller.enqueue(encoder.encode(safeErrorFrame(error)));
            closed = true;
            controller.close();
          } catch {
            controller.error(error);
          }
          await reader.cancel("portable_response_restore_failed").catch(() => undefined);
        }
        finalize();
        releaseReader();
      }
    },
    async cancel(reason) {
      cancelled = true;
      closed = true;
      try {
        await reader.cancel(reason);
      } finally {
        finalize();
        releaseReader();
      }
    },
  });

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
