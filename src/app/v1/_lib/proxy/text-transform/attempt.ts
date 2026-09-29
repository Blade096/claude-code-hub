import { transformedHeaders, transformRequestBody } from "./codec";
import { LiteralMatcher, readTextTransformConfig, TextTransformError } from "./config";

export async function prepareTextTransformAttempt(options: {
  providerId: number;
  url: string;
  headers: Headers;
  body: BodyInit | undefined;
  language?: string | null;
}) {
  const { providerId, url, headers, body, language } = options;
  const config = await readTextTransformConfig(providerId, language);
  if (!config) return { config, headers, body };
  const matcher = new LiteralMatcher(config);
  let decodedUrl = url;
  try {
    decodedUrl = decodeURIComponent(url);
  } catch {
    /* 原始 URL 仍须检查。 */
  }
  if (
    matcher.contains(decodedUrl) ||
    [...headers].some(([k, v]) => matcher.contains(k) || matcher.contains(v))
  ) {
    throw new TextTransformError("residual", language);
  }
  const nextHeaders = transformedHeaders(headers);
  // 请求压缩体不能在移除编码声明后误当作普通 JSON。
  if (headers.has("content-encoding")) throw new TextTransformError("unsupported", language);
  const nextBody = await transformRequestBody(body, nextHeaders, config, language);
  return { config, headers: nextHeaders, body: nextBody };
}
