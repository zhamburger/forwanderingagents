import { randomBytes } from "node:crypto";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { recordVisit } from "./lib/visit-log";

export function proxy(request: NextRequest, event?: NextFetchEvent) {
  event?.waitUntil(recordVisit(request));
  // API routes and files such as llms.txt keep their own headers.
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/api/") || /\.[A-Za-z0-9]+$/.test(pathname)) return NextResponse.next();

  const nonce = randomBytes(24).toString("base64");
  const isDev = process.env.NODE_ENV === "development";
  const policy = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  const headers = new Headers(request.headers);
  // Overwrite caller-supplied policy/nonce headers before Next renders scripts.
  headers.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", policy);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = {
  // Runs for API reads and agent files too, so the visit log sees them.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
