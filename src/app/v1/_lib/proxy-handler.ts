import type { Context } from "hono";
import { getCachedSystemSettings } from "@/lib/config";
import { logger } from "@/lib/logger";
import { ProxyStatusTracker } from "@/lib/proxy-status-tracker";
import { SessionTracker } from "@/lib/session-tracker";
import { ProxyErrorHandler } from "./proxy/error-handler";
import { buildProxyErrorLogDetails } from "./proxy/error-sanitizer";
import { attachSessionIdToErrorResponse } from "./proxy/error-session-id";
import { ProxyError } from "./proxy/errors";
import { tryFakeStreamingPath } from "./proxy/fake-streaming/proxy-integration";
import { detectClientFormat, detectFormatByEndpoint } from "./proxy/format-mapper";
import { ProxyForwarder } from "./proxy/forwarder";
import { GuardPipelineBuilder } from "./proxy/guard-pipeline";
import { expandCompactionReplayItems, RemoteCompactionTokenError } from "./proxy/remote-compaction";
import { tryRemoteCompactionSynthesis } from "./proxy/remote-compaction-synthesizer";
import { ProxyResponseHandler } from "./proxy/response-handler";
import { normalizeResponseInput } from "./proxy/response-input-rectifier";
import { ProxyResponses } from "./proxy/responses";
import { ProxySession } from "./proxy/session";

export async function handleProxyRequest(c: Context): Promise<Response> {
  let session: ProxySession | null = null;
  let cachedSystemSettings: Awaited<ReturnType<typeof getCachedSystemSettings>> | null = null;
  try {
    session = await ProxySession.fromContext(c);
    try {
      cachedSystemSettings = await getCachedSystemSettings();
      session.setHighConcurrencyModeEnabled(
        cachedSystemSettings.enableHighConcurrencyMode ?? false
      );
      session.setRawCrossProviderFallbackEnabled(
        cachedSystemSettings.allowNonConversationEndpointProviderFallback ?? true
      );
    } catch (settingsError) {
      logger.warn(
        "[ProxyHandler] Failed to load proxy system settings, fallback highConcurrency=false and rawCrossProviderFallback=false",
        {
          error: settingsError,
        }
      );
      session.setHighConcurrencyModeEnabled(false);
      session.setRawCrossProviderFallbackEnabled(false);
    }

    // 自动检测请求格式（端点优先，请求体补充）
    if (session.originalFormat === "claude") {
      // 第一步：尝试端点检测（优先级最高，最准确）
      const endpointFormat = detectFormatByEndpoint(session.requestUrl.pathname);

      if (endpointFormat) {
        session.setOriginalFormat(endpointFormat);
        logger.debug("[ProxyHandler] Detected format by endpoint", {
          endpoint: session.requestUrl.pathname,
          format: endpointFormat,
        });
      } else {
        // 第二步：降级到请求体检测（作为 fallback）
        const detectedFormat = detectClientFormat(
          session.request.message as Record<string, unknown>
        );
        session.setOriginalFormat(detectedFormat);

        if (detectedFormat !== "claude") {
          logger.debug("[ProxyHandler] Detected format by request body (endpoint unknown)", {
            format: detectedFormat,
            endpoint: session.requestUrl.pathname,
            hasContents: Array.isArray(
              (session.request.message as Record<string, unknown>).contents
            ),
            hasRequest:
              typeof (session.request.message as Record<string, unknown>).request === "object",
          });
        }
      }
    }

    // Response API input rectifier: normalize non-array input before guard pipeline
    if (session.originalFormat === "response") {
      await normalizeResponseInput(session);
      // 展开 CCH 自己生成的压缩标记，让后续整流器、敏感词与上游都能看到明文历史。
      // 只处理本服务签名过的 token，原生 OpenAI 的 token 原样透传。
      const replayError = expandCompactionReplay(session);
      if (replayError) {
        return await attachSessionIdToErrorResponse(session.sessionId, replayError);
      }
    }

    // Build guard pipeline from session endpoint policy
    const pipeline = GuardPipelineBuilder.fromSession(session);

    // Run guard chain; may return early Response
    const early = await pipeline.run(session);
    if (early) {
      return await attachSessionIdToErrorResponse(session.sessionId, early);
    }

    // 远程压缩替代方案：只有显式开启该能力的供应商才会命中。
    // 命中时由 CCH 自己生成摘要并直接返回压缩 SSE，不再走上游转发。
    const compactionResponse = await tryRemoteCompactionSynthesis(session);
    if (compactionResponse) {
      return await attachSessionIdToErrorResponse(session.sessionId, compactionResponse);
    }

    // 9. 增加并发计数（在所有检查通过后，请求开始前）- 跳过 count_tokens
    if (session.sessionId && session.getEndpointPolicy().trackConcurrentRequests) {
      await SessionTracker.incrementConcurrentCount(session.sessionId);
    }

    // 10. 记录请求开始
    if (session.messageContext && session.provider) {
      const tracker = ProxyStatusTracker.getInstance();
      tracker.startRequest({
        userId: session.messageContext.user.id,
        userName: session.messageContext.user.name,
        requestId: session.messageContext.id,
        keyName: session.messageContext.key.name,
        providerId: session.provider.id,
        providerName: session.provider.name,
        model: session.request.model || "unknown",
      });
    }

    session.recordForwardStart();

    // Fake streaming: if the client-requested model is whitelisted for the
    // current provider group, hand off to the fake-streaming runner which
    // keeps the SSE connection alive with heartbeats while it serially calls
    // upstream and validates the buffered response before emitting it.
    //
    // We do NOT swallow exceptions: `tryFakeStreamingPath` mutates the session
    // (request body, URL) before the forwarder runs. Falling back to the
    // normal flow with a mutated session would either double-hit the upstream
    // (duplicating cost / message context) or leave the request in an
    // inconsistent state. Let the outer error handler turn the failure into a
    // protocol error response instead.
    //
    // Reuse the system settings already loaded above (with its fallback path)
    // instead of re-reading the cache. A transient cache miss must not turn an
    // otherwise-routable request into an error response.
    if (cachedSystemSettings) {
      const fakeStreamingResponse = await tryFakeStreamingPath(session, cachedSystemSettings);
      if (fakeStreamingResponse) {
        return await attachSessionIdToErrorResponse(session.sessionId, fakeStreamingResponse);
      }
    }

    const response = await ProxyForwarder.send(session);
    const handled = await ProxyResponseHandler.dispatch(session, response);
    const finalResponse = await attachSessionIdToErrorResponse(session.sessionId, handled);

    return finalResponse;
  } catch (error) {
    logger.error("Proxy handler error", buildProxyErrorLogDetails(session, error));
    if (session) {
      return await ProxyErrorHandler.handle(session, error);
    }

    if (error instanceof ProxyError) {
      return ProxyResponses.buildError(error.statusCode, error.getClientSafeMessage());
    }

    return ProxyResponses.buildError(500, "代理请求发生未知错误");
  } finally {
    // 11. 减少并发计数（确保无论成功失败都执行）- 跳过 count_tokens
    if (session?.sessionId && session.getEndpointPolicy().trackConcurrentRequests) {
      await SessionTracker.decrementConcurrentCount(session.sessionId);
    }
  }
}

/**
 * 展开历史中的 CCH 压缩标记。
 *
 * 返回非 null 表示展开失败（token 损坏或不是本服务生成的），
 * 此时必须显式报错，不能静默丢弃历史让模型失忆。
 */
function expandCompactionReplay(session: ProxySession): Response | null {
  const message = session.request.message as Record<string, unknown>;
  if (!Array.isArray(message.input)) {
    return null;
  }

  let expanded: number;
  try {
    const result = expandCompactionReplayItems(message.input);
    expanded = result.expanded;
    if (expanded > 0) {
      message.input = result.items;
      // 内存对象已改，必须同步 wire buffer，避免 raw 路径转发旧字节。
      session.request.buffer = new TextEncoder().encode(JSON.stringify(message)).buffer;
    }
  } catch (error) {
    if (error instanceof RemoteCompactionTokenError) {
      logger.warn("[RemoteCompaction] Replay token rejected", {
        code: error.code,
        sessionId: session.sessionId,
      });
      return ProxyResponses.buildError(error.status, error.message, error.code);
    }
    throw error;
  }

  if (expanded > 0) {
    logger.info("[RemoteCompaction] Replay tokens expanded", {
      expanded,
      sessionId: session.sessionId,
    });
  }

  return null;
}
