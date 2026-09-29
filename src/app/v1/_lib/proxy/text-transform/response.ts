import { type TextCell, transformedHeaders, transformJson } from "./codec";
import { LiteralMatcher, type TextTransformConfig, TextTransformError } from "./config";

type Json = Record<string, any>;
type Frame = { raw: string; payload?: Json; pending: number; prefix: string[] };
type Tail = { text: string; cell: TextCell; frame: Frame };
const MAX_BUFFER = 2 * 1024 * 1024;

/** 通道按协议索引隔离；不同 choice、content block、tool call 不能拼接。 */
function lane(payload: Json, path: string): string | null {
  if (payload.response?.candidates && path.startsWith("$.response.")) {
    return lane(payload.response, path.replace("$.response.", "$."));
  }
  const chat = path.match(/^\$\.choices\.(\d+)\.delta\.(.*)$/);
  if (chat) {
    const choice = payload.choices[Number(chat[1])];
    const tool = chat[2].match(/^tool_calls\.(\d+)\.(.*)$/);
    return `chat:${choice.index ?? 0}:${tool ? `tool:${choice.delta.tool_calls[Number(tool[1])].index ?? tool[1]}:${tool[2]}` : chat[2]}`;
  }
  if (payload.type === "content_block_delta" && path.startsWith("$.delta."))
    return `claude:${payload.index}:${path}`;
  if (
    typeof payload.type === "string" &&
    payload.type.startsWith("response.") &&
    payload.type.endsWith(".delta") &&
    path === "$.delta"
  ) {
    return `responses:${payload.output_index ?? payload.item_id}:${payload.content_index ?? payload.summary_index ?? 0}:${payload.type}`;
  }
  const gemini = path.match(/^\$\.candidates\.(\d+)\.content\.parts\.(\d+)\.text$/);
  if (gemini)
    return `gemini:${payload.candidates[Number(gemini[1])].index ?? gemini[1]}:${gemini[2]}:${payload.candidates[Number(gemini[1])].content.parts[Number(gemini[2])].thought === true ? "thought" : "text"}`;
  return null;
}

class EventRestorer {
  private readonly matcher: LiteralMatcher;
  private readonly tails = new Map<string, Tail>();
  private queue: Frame[] = [];
  constructor(
    private readonly config: TextTransformConfig,
    private readonly language?: string | null
  ) {
    this.matcher = new LiteralMatcher(config, true);
  }
  private flush(prefix = ""): void {
    for (const [key, tail] of this.tails) {
      if (!key.startsWith(prefix)) continue;
      tail.cell.object[tail.cell.key] += this.matcher.replace(tail.text);
      tail.frame.pending--;
      this.tails.delete(key);
    }
  }
  private release(): string {
    let result = "";
    while (this.queue.length && this.queue[0].pending === 0) {
      const frame = this.queue.shift() as Frame;
      result += frame.payload
        ? `${frame.prefix.join("\n")}${frame.prefix.length ? "\n" : ""}data: ${JSON.stringify(frame.payload)}\n\n`
        : frame.raw;
    }
    return result;
  }
  event(raw: string): string {
    if (raw.length > MAX_BUFFER) throw new TextTransformError("response", this.language);
    const lines = raw.replace(/\r\n/g, "\n").split("\n");
    const data = lines
      .filter((s) => s === "data" || s.startsWith("data:"))
      .map((s) => (s === "data" ? "" : s.slice(5).replace(/^ /, "")))
      .join("\n");
    const frame: Frame = {
      raw,
      pending: 0,
      prefix: lines.filter((s) => s && s !== "data" && !s.startsWith("data:")),
    };
    if (data === "[DONE]") this.flush();
    else if (data) {
      let payload: Json;
      try {
        payload = JSON.parse(data);
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error();
      } catch {
        throw new TextTransformError("response", this.language);
      }
      const cells: TextCell[] = [];
      frame.payload = transformJson(payload, this.config, true, this.language, (cell) =>
        cells.push(cell)
      ) as Json;
      // Responses 把文本/工具参数 delta 放在根字符串字段，与其它协议的 delta 对象不同。
      if (typeof payload.delta === "string")
        cells.push({ object: frame.payload, key: "delta", path: "$.delta" });
      for (const cell of cells) {
        const channel = lane(payload, cell.path);
        const text = cell.object[cell.key] as string;
        if (!channel) {
          cell.object[cell.key] = this.matcher.replace(text);
          continue;
        }
        const previous = this.tails.get(channel);
        const consumed = this.matcher.consume((previous?.text ?? "") + text);
        if (previous) {
          previous.cell.object[previous.cell.key] += consumed.output;
          previous.frame.pending--;
          this.tails.delete(channel);
          cell.object[cell.key] = "";
        } else cell.object[cell.key] = consumed.output;
        if (consumed.tail) {
          frame.pending++;
          this.tails.set(channel, { text: consumed.tail, cell, frame });
        }
      }
      if (payload.type === "content_block_stop") this.flush(`claude:${payload.index}:`);
      for (const choice of payload.choices ?? [])
        if (choice.finish_reason != null) this.flush(`chat:${choice.index ?? 0}:`);
      for (const candidate of payload.candidates ?? payload.response?.candidates ?? [])
        if (candidate.finishReason) this.flush(`gemini:${candidate.index ?? 0}:`);
      if (payload.type === "response.output_item.done")
        this.flush(`responses:${payload.output_index ?? payload.item?.id}:`);
      if (
        [
          "message_stop",
          "response.completed",
          "response.failed",
          "response.incomplete",
          "error",
        ].includes(payload.type)
      )
        this.flush();
    }
    this.queue.push(frame);
    if (this.queue.reduce((n, f) => n + f.raw.length, 0) > MAX_BUFFER)
      throw new TextTransformError("response", this.language);
    return this.release();
  }
  finish(): string {
    this.flush();
    return this.release();
  }
}

function restoreSse(
  response: Response,
  config: TextTransformConfig,
  language?: string | null
): Response {
  if (!response.body) throw new TextTransformError("response", language);
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();
  const restorer = new EventRestorer(config, language);
  let pending = "";
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let transportError: unknown;
      try {
        while (true) {
          const { value, done } = await reader.read().catch((error: unknown) => {
            transportError = error;
            throw error;
          });
          pending += decoder.decode(value, { stream: !done });
          let output = "";
          let match: RegExpExecArray | null;
          while ((match = /\r?\n\r?\n/.exec(pending))) {
            const end = match.index + match[0].length;
            output += restorer.event(pending.slice(0, end));
            pending = pending.slice(end);
          }
          if (pending.length > MAX_BUFFER) throw new TextTransformError("response", language);
          if (done) {
            if (pending.trim()) throw new TextTransformError("response", language);
            output += restorer.finish();
          }
          if (output) controller.enqueue(encoder.encode(output));
          if (done) {
            controller.close();
            reader.releaseLock();
            return;
          }
          if (output) return;
        }
      } catch (error) {
        await reader.cancel(error).catch(() => undefined);
        reader.releaseLock();
        controller.error(
          transportError ??
            (error instanceof TextTransformError
              ? error
              : new TextTransformError("response", language))
        );
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        reader.releaseLock();
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: transformedHeaders(response.headers),
  });
}

export async function restoreTextResponse(
  response: Response,
  config: TextTransformConfig,
  language?: string | null
): Promise<Response> {
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("text/event-stream")) return restoreSse(response, config, language);
  // 图片、音频、附件响应保持原样；JSON 外壳中的二进制字段由 codec 排除。
  if (!type.includes("json")) return response;
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new TextTransformError("response", language);
  }
  return new Response(JSON.stringify(transformJson(payload, config, true, language)), {
    status: response.status,
    statusText: response.statusText,
    headers: transformedHeaders(response.headers),
  });
}
