import { type NextRequest, NextResponse } from "next/server";

const SESSION_COOKIE = "sadhak_session";

/**
 * Optimistic protection of /app/* — UX only, per Plan 4: the API is the
 * security boundary. With mock auth the cookie is the whole story, and the
 * matcher/redirect contract stays identical when real sessions land.
 */
export function middleware(request: NextRequest) {
  if (!request.cookies.has(SESSION_COOKIE)) {
    const url = request.nextUrl.clone();
    url.pathname = "/signin";
    url.search = `?next=${encodeURIComponent(request.nextUrl.pathname)}`;
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: "/app/:path*",
};
