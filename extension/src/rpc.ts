const BASE = "http://127.0.0.1:24765";

export type HealthResponse = { ok: boolean; version?: string };

export type VoicesEnvelope = {
  voices: VoiceDto[];
  source: "network" | "cache";
  fetched_at: string;
  stale: boolean;
};

export type VoiceDto = {
  id: string;
  locale: string;
  lang: string;
  gender: string;
  friendlyName: string;
  status: string;
};

export type RpcErrorBody = {
  status: "error";
  error: string;
  message?: string;
  attempts?: number;
  voices?: [];
};

export class RpcError extends Error {
  readonly httpStatus: number;
  readonly code: string;
  readonly body: RpcErrorBody | null;

  constructor(
    httpStatus: number,
    code: string,
    message: string,
    body: RpcErrorBody | null = null,
  ) {
    super(message);
    this.name = "RpcError";
    this.httpStatus = httpStatus;
    this.code = code;
    this.body = body;
  }
}

function authHeaders(secret: string, json = false): HeadersInit {
  const h: Record<string, string> = {
    "X-Auth-Token": secret,
  };
  if (json) h["Content-Type"] = "application/json";
  return h;
}

async function parseJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function throwIfError(res: Response, data: unknown): void {
  if (res.ok) return;
  const body =
    data && typeof data === "object" && (data as RpcErrorBody).status === "error"
      ? (data as RpcErrorBody)
      : null;
  const code = body?.error ?? (res.status === 401 ? "unauthorized" : "http_error");
  const message =
    body?.message ?? `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
  throw new RpcError(res.status, code, message, body);
}

export async function health(signal?: AbortSignal): Promise<HealthResponse> {
  const res = await fetch(`${BASE}/health`, { method: "GET", signal });
  const data = await parseJson(res);
  if (!res.ok) {
    throw new RpcError(res.status, "http_error", `health HTTP ${res.status}`);
  }
  return data as HealthResponse;
}

export async function getVoices(
  secret: string,
  signal?: AbortSignal,
): Promise<VoicesEnvelope> {
  const res = await fetch(`${BASE}/voices`, {
    method: "GET",
    headers: authHeaders(secret),
    signal,
  });
  const data = await parseJson(res);
  throwIfError(res, data);
  return data as VoicesEnvelope;
}

export type SynthBody = {
  text: string;
  voice?: string;
  rate?: string;
  pitch?: string;
  priority?: "play" | "prefetch";
};

export type SynthReady = {
  status: "ready";
  id: string;
  voice: string;
  cached: boolean;
};

export async function synth(
  secret: string,
  body: SynthBody,
  signal?: AbortSignal,
): Promise<SynthReady> {
  const res = await fetch(`${BASE}/v1/synth`, {
    method: "POST",
    headers: authHeaders(secret, true),
    body: JSON.stringify(body),
    signal,
  });
  const data = await parseJson(res);
  throwIfError(res, data);
  return data as SynthReady;
}

export async function fetchAudioBlob(
  secret: string,
  voice: string,
  id: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const res = await fetch(
    `${BASE}/audio/${encodeURIComponent(voice)}/${encodeURIComponent(id)}.mp3`,
    {
      method: "GET",
      headers: authHeaders(secret),
      signal,
    },
  );
  if (!res.ok) {
    const data = await parseJson(res);
    throwIfError(res, data);
  }
  return res.blob();
}

export async function clearCache(
  secret: string,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${BASE}/v1/cache/clear`, {
    method: "POST",
    headers: authHeaders(secret),
    signal,
  });
  const data = await parseJson(res);
  throwIfError(res, data);
}

export async function cacheStats(
  secret: string,
  signal?: AbortSignal,
): Promise<{ bytes: number; files: number }> {
  const res = await fetch(`${BASE}/v1/cache/stats`, {
    method: "GET",
    headers: authHeaders(secret),
    signal,
  });
  const data = await parseJson(res);
  throwIfError(res, data);
  return data as { bytes: number; files: number };
}

/** Connectivity probe for options/popup: health + optional auth check via voices. */
export type ConnectionStatus = {
  online: boolean;
  version: string | null;
  secretOk: boolean | null;
  secretConfigured: boolean;
  error: string | null;
  errorCode: string | null;
};

export async function probeConnection(
  secret: string,
  signal?: AbortSignal,
): Promise<ConnectionStatus> {
  const secretConfigured = secret.trim().length > 0;
  try {
    const h = await health(signal);
    if (!h.ok) {
      return {
        online: false,
        version: h.version ?? null,
        secretOk: null,
        secretConfigured,
        error: "daemon reported not ok",
        errorCode: "not_ok",
      };
    }
    if (!secretConfigured) {
      return {
        online: true,
        version: h.version ?? null,
        secretOk: null,
        secretConfigured: false,
        error: null,
        errorCode: null,
      };
    }
    try {
      await getVoices(secret, signal);
      return {
        online: true,
        version: h.version ?? null,
        secretOk: true,
        secretConfigured: true,
        error: null,
        errorCode: null,
      };
    } catch (e) {
      if (e instanceof RpcError && e.httpStatus === 401) {
        return {
          online: true,
          version: h.version ?? null,
          secretOk: false,
          secretConfigured: true,
          error: e.message,
          errorCode: "unauthorized",
        };
      }
      if (e instanceof RpcError && e.code === "voices_unavailable") {
        return {
          online: true,
          version: h.version ?? null,
          secretOk: true,
          secretConfigured: true,
          error: e.message,
          errorCode: "voices_unavailable",
        };
      }
      return {
        online: true,
        version: h.version ?? null,
        secretOk: null,
        secretConfigured: true,
        error: e instanceof Error ? e.message : String(e),
        errorCode: e instanceof RpcError ? e.code : "unknown",
      };
    }
  } catch (e) {
    return {
      online: false,
      version: null,
      secretOk: null,
      secretConfigured,
      error: e instanceof Error ? e.message : String(e),
      errorCode: "offline",
    };
  }
}
