import axios, { AxiosInstance, AxiosError } from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { FREELANCER_API_BASE } from "../constants.js";
import { ApiResponse } from "../types.js";

/**
 * One connected Freelancer account: its OAuth token and, optionally, the proxy
 * every call of THIS account must leave through (http://, https://, socks5://,
 * socks5h://, credentials allowed). Two accounts must never share an egress,
 * so each account gets its own agent and the process environment's proxy
 * settings are ignored on purpose.
 */
export interface AccountConfig {
  token: string;
  proxy?: string;
}

interface AccountClient {
  client: AxiosInstance;
  proxy: string;
  agent?: HttpsProxyAgent<string> | SocksProxyAgent;
}

const clients: Map<string, AccountClient> = new Map();
let defaultAccount: string | null = null;

function makeAgent(proxy: string): HttpsProxyAgent<string> | SocksProxyAgent | undefined {
  if (!proxy) return undefined;
  const scheme = proxy.split("://")[0].toLowerCase();
  if (scheme === "http" || scheme === "https") return new HttpsProxyAgent(proxy);
  if (scheme === "socks5" || scheme === "socks5h" || scheme === "socks4") return new SocksProxyAgent(proxy);
  throw new Error(`Unsupported proxy scheme "${scheme}" (use http, https, socks5 or socks5h)`);
}

/** Proxy URL with the credentials removed, for display. */
export function maskProxy(proxy: string): string {
  if (!proxy) return "direct";
  try {
    const u = new URL(proxy);
    return `${u.protocol}//${u.hostname}${u.port ? ":" + u.port : ""}`;
  } catch {
    return proxy.replace(/\/\/[^@]+@/, "//***@");
  }
}

/**
 * Initialize one Freelancer API client per configured account. Tokens live
 * only in memory and in the caller's own MCP client config.
 */
export function initApiClients(accounts: Record<string, AccountConfig>): void {
  clients.clear();
  defaultAccount = null;
  for (const [label, cfg] of Object.entries(accounts)) {
    if (!cfg?.token) continue;
    const agent = makeAgent(cfg.proxy || "");
    const client = axios.create({
      baseURL: FREELANCER_API_BASE,
      headers: {
        "freelancer-oauth-v1": cfg.token,
        "Content-Type": "application/json",
      },
      timeout: 25000,
      proxy: false,                 // never pick up HTTP(S)_PROXY from the environment
      httpAgent: agent,
      httpsAgent: agent,
    });
    clients.set(label, { client, proxy: cfg.proxy || "", agent });
    if (!defaultAccount) defaultAccount = label;
  }
}

export function listAccounts(): string[] {
  return Array.from(clients.keys());
}

/** Label -> masked egress, for the accounts listing (never the credentials). */
export function accountEgress(label: string): string {
  return maskProxy(clients.get(label)?.proxy || "");
}

export function resolveAccountLabel(account?: string): string {
  const label = account || defaultAccount;
  if (!label) {
    throw new Error(
      "No Freelancer accounts configured. Set FREELANCER_OAUTH_TOKEN (single account) or " +
        "FREELANCER_ACCOUNTS (multiple, e.g. '{\"main\":\"token1\",\"client2\":{\"token\":\"token2\",\"proxy\":\"http://user:pass@host:port\"}}') in your MCP config."
    );
  }
  if (!clients.has(label)) {
    throw new Error(
      `Unknown account "${label}". Configured accounts: ${listAccounts().join(", ") || "none"}. ` +
        `Use freelancer_list_accounts to see what's available.`
    );
  }
  return label;
}

function getApiClient(account?: string): AxiosInstance {
  return clients.get(resolveAccountLabel(account))!.client;
}

/**
 * The public IP a request of this account leaves from (through its proxy when
 * it has one). Uses a plain client bound to the same agent, no Freelancer
 * header, so the token is never sent to the IP service.
 */
export async function egressIp(account?: string): Promise<string> {
  const entry = clients.get(resolveAccountLabel(account))!;
  const probe = axios.create({ timeout: 15000, proxy: false, httpAgent: entry.agent, httpsAgent: entry.agent });
  const r = await probe.get<{ ip: string }>("https://api.ipify.org", { params: { format: "json" } });
  return r.data.ip;
}

function unwrap<T>(data: ApiResponse<T>): T {
  if (data.status !== "success") {
    throw new Error(data.message || data.error_code || "API returned non-success status");
  }
  return data.result;
}

/** Freelancer's machine-readable error code, when the error came from the API. */
export function apiErrorCode(error: unknown): string | undefined {
  if (axios.isAxiosError(error)) {
    return (error as AxiosError<ApiResponse<unknown>>).response?.data?.error_code;
  }
  return undefined;
}

function toApiError(error: unknown): Error {
  if (axios.isAxiosError(error)) {
    const axiosErr = error as AxiosError<ApiResponse<unknown>>;
    const msg =
      axiosErr.response?.data?.message ||
      axiosErr.response?.data?.error_code ||
      axiosErr.message;
    const e = new Error(`Freelancer API error (${axiosErr.response?.status}): ${msg}`);
    (e as Error & { code?: string }).code = axiosErr.response?.data?.error_code;
    return e;
  }
  return error as Error;
}

export async function apiGet<T>(
  path: string,
  params?: Record<string, unknown>,
  account?: string
): Promise<T> {
  const client = getApiClient(account);
  try {
    const response = await client.get<ApiResponse<T>>(path, { params });
    return unwrap(response.data);
  } catch (error) {
    throw toApiError(error);
  }
}

export async function apiPost<T>(
  path: string,
  data?: Record<string, unknown>,
  opts?: { form?: boolean; account?: string }
): Promise<T> {
  const client = getApiClient(opts?.account);
  try {
    // The Freelancer API expects application/x-www-form-urlencoded for most
    // write endpoints; JSON bodies are silently ignored or rejected.
    let body: unknown = data;
    let config;
    if (opts?.form && data) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(data)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
          for (const v of value) params.append(`${key}[]`, String(v));
        } else {
          params.append(key, String(value));
        }
      }
      body = params.toString();
      config = { headers: { "Content-Type": "application/x-www-form-urlencoded" } };
    }
    const response = await client.post<ApiResponse<T>>(path, body, config);
    return unwrap(response.data);
  } catch (error) {
    throw toApiError(error);
  }
}

export async function apiPut<T>(
  path: string,
  data?: Record<string, unknown>,
  account?: string,
  params?: Record<string, unknown>
): Promise<T> {
  const client = getApiClient(account);
  try {
    const response = await client.put<ApiResponse<T>>(path, data, { params });
    return unwrap(response.data);
  } catch (error) {
    throw toApiError(error);
  }
}

/**
 * Some Freelancer write endpoints (notably /users/0.1/self/jobs) reject JSON and
 * require application/x-www-form-urlencoded with repeated array keys (jobs[]=1&jobs[]=2).
 * `arrayParams` maps a field name to a list of values serialized that way.
 */
export async function apiForm<T>(
  method: "post" | "put" | "delete",
  path: string,
  arrayParams: Record<string, Array<string | number>> = {},
  scalarParams: Record<string, string | number> = {},
  account?: string
): Promise<T> {
  const client = getApiClient(account);
  const body = new URLSearchParams();
  for (const [key, values] of Object.entries(arrayParams)) {
    for (const v of values) body.append(`${key}[]`, String(v));
  }
  for (const [key, value] of Object.entries(scalarParams)) {
    body.append(key, String(value));
  }
  try {
    const response = await client.request<ApiResponse<T>>({
      method,
      url: path,
      data: body.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    return unwrap(response.data);
  } catch (error) {
    throw toApiError(error);
  }
}

export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + `\n\n[Truncated — ${text.length - limit} characters omitted]`;
}

export function formatDate(unix?: number): string {
  if (!unix) return "unknown";
  return new Date(unix * 1000).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function mcpError(message: string): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}

/**
 * Accept either a raw numeric thread ID or a Freelancer chat URL
 * (e.g. https://www.freelancer.com/messages/thread/123456 or a
 * project-message deep link containing the thread id) and return the ID.
 */
export function resolveThreadId(input: string | number): number {
  if (typeof input === "number") return input;
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const match = trimmed.match(/(\d+)(?:\D*)?$/) || trimmed.match(/thread[s]?[/=](\d+)/i);
  if (match) return Number(match[1]);
  throw new Error(`Could not extract a thread ID from "${input}". Pass a numeric thread ID or a Freelancer chat link.`);
}

/** Shared account selector schema description, reused across tool inputs. */
export const ACCOUNT_DESC =
  "Which configured Freelancer account to use (see freelancer_list_accounts for labels). Omit to use your default/only account.";
