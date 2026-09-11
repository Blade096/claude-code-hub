import { normalizeEndpointPath, V1_ENDPOINT_PATHS } from "./endpoint-paths";

export type EndpointGuardPreset = "chat" | "raw_passthrough";

export type EndpointPoolStrictness = "inherit" | "strict";

export interface EndpointPolicy {
  readonly kind: "default" | "raw_passthrough";
  readonly guardPreset: EndpointGuardPreset;
  readonly allowRetry: boolean;
  readonly allowProviderSwitch: boolean;
  /**
   * 是否允许同一次请求内的传输层回退：WS→HTTP、HTTP/2→HTTP/1.1、代理→直连。
   * 这些回退会重新发送同一份请求体，因此内部单次尝试子请求必须关掉。
   */
  readonly allowTransportFallback: boolean;
  readonly allowRawCrossProviderFallback: boolean;
  readonly allowCircuitBreakerAccounting: boolean;
  readonly trackConcurrentRequests: boolean;
  readonly bypassRequestFilters: boolean;
  readonly bypassForwarderPreprocessing: boolean;
  readonly bypassSpecialSettings: boolean;
  readonly bypassResponseRectifier: boolean;
  readonly endpointPoolStrictness: EndpointPoolStrictness;
}

const DEFAULT_ENDPOINT_POLICY: EndpointPolicy = Object.freeze({
  kind: "default",
  guardPreset: "chat",
  allowRetry: true,
  allowProviderSwitch: true,
  allowTransportFallback: true,
  allowRawCrossProviderFallback: false,
  allowCircuitBreakerAccounting: true,
  trackConcurrentRequests: true,
  bypassRequestFilters: false,
  bypassForwarderPreprocessing: false,
  bypassSpecialSettings: false,
  bypassResponseRectifier: false,
  endpointPoolStrictness: "inherit",
});

const RAW_PASSTHROUGH_ENDPOINT_POLICY: EndpointPolicy = Object.freeze({
  kind: "raw_passthrough",
  guardPreset: "raw_passthrough",
  allowRetry: false,
  allowProviderSwitch: false,
  allowTransportFallback: true,
  allowRawCrossProviderFallback: true,
  allowCircuitBreakerAccounting: false,
  trackConcurrentRequests: false,
  bypassRequestFilters: true,
  bypassForwarderPreprocessing: true,
  bypassSpecialSettings: true,
  bypassResponseRectifier: true,
  endpointPoolStrictness: "strict",
});

/**
 * 内部子请求（例如 CCH 代替上游生成压缩摘要）使用的策略：
 * 保留普通对话端点的预处理，但禁止重试与供应商切换。
 * 完整会话历史不能被转发到另一个供应商，也不能因为一次失败被重复放大。
 */
export const SINGLE_ATTEMPT_ENDPOINT_POLICY: EndpointPolicy = Object.freeze({
  ...DEFAULT_ENDPOINT_POLICY,
  allowRetry: false,
  allowProviderSwitch: false,
  allowTransportFallback: false,
});

const rawPassthroughEndpointPathSet = new Set<string>([
  V1_ENDPOINT_PATHS.MESSAGES_COUNT_TOKENS,
  V1_ENDPOINT_PATHS.RESPONSES_COMPACT,
]);

export function isRawPassthroughEndpointPath(pathname: string): boolean {
  return rawPassthroughEndpointPathSet.has(normalizeEndpointPath(pathname));
}

export function isRawPassthroughEndpointPolicy(policy: EndpointPolicy): boolean {
  return policy.kind === "raw_passthrough";
}

export function isStrictEndpointPoolPolicy(policy: Pick<EndpointPolicy, "endpointPoolStrictness">) {
  return policy.endpointPoolStrictness === "strict";
}

export function shouldEnforceStrictEndpointPoolPolicy(
  policy: Pick<EndpointPolicy, "endpointPoolStrictness">
) {
  return policy.endpointPoolStrictness === "strict" || policy.endpointPoolStrictness === "inherit";
}

export function resolveEndpointPolicy(pathname: string): EndpointPolicy {
  const normalizedPath = normalizeEndpointPath(pathname);

  if (rawPassthroughEndpointPathSet.has(normalizedPath)) {
    return RAW_PASSTHROUGH_ENDPOINT_POLICY;
  }

  return DEFAULT_ENDPOINT_POLICY;
}
