/**
 * fetch over Android's own HTTP stack. Strava's API sends no CORS headers, so the app's
 * WebView may not call it directly; Capacitor's native HTTP has no such rule. Off the phone
 * (the ?device-storage preview) this is plain fetch.
 */
import { Capacitor, CapacitorHttp } from "@capacitor/core";
import type { FetchLike } from "../src/strava/client.ts";

export const nativeFetch: FetchLike = async (input, init = {}) => {
  if (!Capacitor.isNativePlatform()) return fetch(input, init);
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => (headers[k] = v));
  const body = init.body;
  if (body !== undefined && body !== null && typeof body !== "string" && !(body instanceof URLSearchParams)) {
    throw new Error("nativeFetch sends text or form bodies only");
  }
  if (body instanceof URLSearchParams) headers["content-type"] ??= "application/x-www-form-urlencoded";
  const res = await CapacitorHttp.request({
    url: String(input),
    method: init.method ?? "GET",
    headers,
    data: body == null ? undefined : String(body),
    responseType: "text",
  });
  // JSON responses arrive already parsed; hand them back as text like fetch would.
  const text = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
  return new Response(res.status === 204 ? null : text, { status: res.status, headers: res.headers });
};
