import {
  getSafeErrorToastMessage,
  sanitizeUserVisibleErrorMessage,
} from "@/lib/utils/user-visible-error";
import type { ProxySession } from "./session";

const CREDENTIAL_HEADERS = [
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "anthropic-api-key",
  "x-goog-api-key",
  "x-auth-token",
] as const;

const CREDENTIAL_QUERY_PARAMS = [
  "key",
  "api_key",
  "api-key",
  "apikey",
  "apiKey",
  "token",
  "access_token",
  "auth_token",
] as const;

function addCredential(candidates: Set<string>, value: string | null | undefined): void {
  const normalized = value?.trim();
  if (!normalized) return;

  candidates.add(normalized);
  const bearerMatch = normalized.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch?.[1]) candidates.add(bearerMatch[1].trim());
}

function sessionCredentials(session: ProxySession | null): string[] {
  if (!session) return [];

  const candidates = new Set<string>();
  const headers = session.headers;
  if (headers && typeof headers.get === "function") {
    for (const name of CREDENTIAL_HEADERS) addCredential(candidates, headers.get(name));
  }

  addCredential(candidates, session.authState?.apiKey);

  const requestUrl = session.requestUrl;
  if (requestUrl?.searchParams) {
    for (const name of CREDENTIAL_QUERY_PARAMS) {
      for (const value of requestUrl.searchParams.getAll(name)) addCredential(candidates, value);
    }
  }

  return [...candidates].sort((left, right) => right.length - left.length);
}

function redactSessionCredentials(session: ProxySession | null, message: string): string {
  let redacted = message;
  for (const credential of sessionCredentials(session)) {
    redacted = redacted.split(credential).join("[REDACTED]");
  }
  return redacted;
}

export function sanitizeProxyErrorMessage(session: ProxySession | null, message: string): string {
  return sanitizeUserVisibleErrorMessage(redactSessionCredentials(session, message));
}

export function getSafeProxyClientErrorMessage(
  session: ProxySession | null,
  message: string,
  fallback: string
): string {
  return getSafeErrorToastMessage(redactSessionCredentials(session, message), fallback);
}

export function buildProxyErrorLogDetails(
  session: ProxySession | null,
  error: unknown
): { errorName: string; errorMessage: string } {
  const errorName = error instanceof Error ? error.name : "UnknownError";
  const rawMessage = error instanceof Error ? error.message : String(error);
  return {
    errorName,
    errorMessage: sanitizeProxyErrorMessage(session, rawMessage),
  };
}
