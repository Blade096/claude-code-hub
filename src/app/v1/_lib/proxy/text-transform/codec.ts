import { foldCase, LiteralMatcher, type TextTransformConfig, TextTransformError } from "./config";

type JsonObject = Record<string, unknown>;
export type TextCell = { object: JsonObject; key: string; path: string };
const TEXT_KEYS = new Set([
  "text",
  "message",
  "content",
  "system",
  "instructions",
  "prompt",
  "description",
  "title",
  "arguments",
  "partial_json",
  "input",
  "output",
  "thinking",
  "reasoning_content",
  "refusal",
  "url",
]);
const OPAQUE_KEYS = new Set([
  "signature",
  "thoughtSignature",
  "encrypted_content",
  "data",
  "file_data",
  "b64_json",
]);
const ATTACHMENT_TYPES = new Set([
  "image",
  "image_url",
  "input_image",
  "document",
  "file",
  "input_file",
  "input_audio",
  "audio",
]);
const ATTACHMENT_KEYS = new Set([
  "inlineData",
  "inline_data",
  "fileData",
  "file_data",
  "image_url",
  "input_audio",
]);

/** 附件整体透传；协议标识和签名只检查，不改写。工具 JSON 的键和值属于业务内容。 */
export function transformJson(
  value: unknown,
  config: TextTransformConfig,
  reverse: boolean,
  language?: string | null,
  onText?: (cell: TextCell) => void
): unknown {
  const matcher = new LiteralMatcher(config, reverse);
  const aliases = new LiteralMatcher(config, true);
  const signedThinkingPassthrough = new WeakSet<object>();
  const replace = (text: string): string => {
    const output = matcher.replace(text);
    if (!reverse) {
      const restored = aliases.replace(output);
      if (config.caseSensitive ? restored !== text : foldCase(restored) !== foldCase(text)) {
        throw new TextTransformError("collision", language);
      }
    }
    return output;
  };
  const visit = (node: unknown, path: string, semantic = false): unknown => {
    if (typeof node === "string") {
      if (!reverse && semantic && aliases.contains(node))
        throw new TextTransformError("collision", language);
      if (!semantic) {
        if (!reverse && matcher.contains(node)) throw new TextTransformError("residual", language);
        return node;
      }
      return replace(node);
    }
    if (Array.isArray(node)) return node.map((v, i) => visit(v, `${path}.${i}`, semantic));
    if (!node || typeof node !== "object") return node;
    const obj = node as JsonObject;
    if (!semantic && typeof obj.type === "string" && ATTACHMENT_TYPES.has(obj.type))
      return structuredClone(obj);
    if (
      !semantic &&
      (typeof obj.thoughtSignature === "string" ||
        obj.type === "thinking" ||
        obj.type === "redacted_thinking" ||
        obj.type === "thinking_delta" ||
        obj.type === "signature_delta")
    ) {
      // 图片里的原词可能进入历史思考；带签名块按约定整体透传，不能改写签名正文。
      const signedThinking =
        (obj.type === "thinking" &&
          typeof obj.signature === "string" &&
          obj.signature.length > 0) ||
        (typeof obj.thoughtSignature === "string" && obj.thoughtSignature.length > 0);
      if (!reverse && !signedThinking && matcher.contains(JSON.stringify(obj)))
        throw new TextTransformError("residual", language);
      const preserved = structuredClone(obj);
      if (signedThinking) signedThinkingPassthrough.add(preserved);
      return preserved;
    }
    const result: JsonObject = {};
    for (const [key, child] of Object.entries(obj)) {
      if (!semantic && ATTACHMENT_KEYS.has(key)) {
        Object.defineProperty(result, key, {
          value: structuredClone(child),
          enumerable: true,
          writable: true,
        });
        continue;
      }
      const nextKey = semantic ? replace(key) : key;
      if (!reverse && semantic && aliases.contains(key))
        throw new TextTransformError("collision", language);
      if (!reverse && !semantic && matcher.contains(key))
        throw new TextTransformError("residual", language);
      const opaque = !semantic && OPAQUE_KEYS.has(key);
      const text =
        semantic ||
        TEXT_KEYS.has(key) ||
        (key === "name" &&
          (obj.type === "function" ||
            obj.type === "tool_use" ||
            obj.type === "function_call" ||
            path.includes(".tools") ||
            path.endsWith(".function") ||
            path.endsWith(".function_call") ||
            path.endsWith(".functionCall") ||
            path.endsWith(".functionResponse")));
      // 任意工具参数/结果对象允许改写业务键；普通消息对象始终保留协议键。
      const businessTree =
        semantic ||
        (key === "input" && obj.type === "tool_use") ||
        key === "args" ||
        (key === "response" && path.endsWith(".functionResponse"));
      let next: unknown;
      if (opaque) {
        if (!reverse && matcher.contains(JSON.stringify(child)))
          throw new TextTransformError("residual", language);
        next = structuredClone(child);
      } else if (typeof child === "string") {
        if (onText && text) {
          next = child;
        } else next = visit(child, `${path}.${key}`, text);
      } else next = visit(child, `${path}.${key}`, businessTree);
      if (Object.hasOwn(result, nextKey))
        throw new TextTransformError(reverse ? "response" : "collision", language);
      Object.defineProperty(result, nextKey, { value: next, enumerable: true, writable: true });
      if (onText && text && typeof child === "string" && !opaque)
        onText({ object: result, key: nextKey, path: `${path}.${key}` });
    }
    return result;
  };
  const result = visit(value, "$");
  if (!reverse) {
    // 再遍历转换结果可发现跨替换边界形成的原词，附件和签名思考按约定排除。
    const scan = (node: unknown): void => {
      if (typeof node === "string") {
        if (matcher.contains(node)) throw new TextTransformError("residual", language);
        return;
      }
      if (Array.isArray(node)) {
        node.forEach(scan);
        return;
      }
      if (!node || typeof node !== "object") return;
      const obj = node as JsonObject;
      if (signedThinkingPassthrough.has(obj)) return;
      if (typeof obj.type === "string" && ATTACHMENT_TYPES.has(obj.type)) return;
      for (const [k, v] of Object.entries(obj)) {
        if (ATTACHMENT_KEYS.has(k)) continue;
        if (matcher.contains(k)) throw new TextTransformError("residual", language);
        scan(v);
      }
    };
    scan(result);
  }
  return result;
}

export function transformedHeaders(headers: Headers): Headers {
  const result = new Headers(headers);
  for (const key of [
    "content-length",
    "transfer-encoding",
    "content-encoding",
    "etag",
    "digest",
    "content-digest",
    "repr-digest",
    "content-md5",
  ])
    result.delete(key);
  return result;
}

export async function transformRequestBody(
  body: BodyInit | undefined,
  headers: Headers,
  config: TextTransformConfig,
  language?: string | null
): Promise<BodyInit | undefined> {
  if (body === undefined) return undefined;
  const contentType = headers.get("content-type") ?? "application/json";
  if (contentType.includes("multipart/form-data")) {
    let form: FormData;
    try {
      form = await new Response(body, { headers }).formData();
    } catch {
      throw new TextTransformError("unsupported", language);
    }
    const output = new FormData();
    for (const [key, value] of form.entries()) {
      if (typeof value !== "string") {
        output.append(key, value);
        continue;
      }
      const field = transformJson({ [key]: value }, config, false, language) as JsonObject;
      output.append(key, field[key] as string);
    }
    const encoded = new Response(output);
    headers.set("content-type", encoded.headers.get("content-type") as string);
    return await encoded.arrayBuffer();
  }
  if (!contentType.includes("json")) throw new TextTransformError("unsupported", language);
  let value: unknown;
  try {
    value = JSON.parse(await new Response(body).text());
  } catch {
    throw new TextTransformError("unsupported", language);
  }
  return JSON.stringify(transformJson(value, config, false, language));
}
