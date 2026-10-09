import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { defaultLocale, localeCookieName, locales } from "@/i18n/config";

const mocks = vi.hoisted(() => ({
  getCookie: vi.fn(),
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: mocks.getCookie }),
}));

vi.mock("@/i18n/routing", () => ({ redirect: mocks.redirect }));

describe("root locale redirect", () => {
  beforeEach(() => {
    mocks.getCookie.mockReset();
    mocks.redirect.mockClear();
  });

  test.each(locales)("redirects the root URL to the %s dashboard", async (locale) => {
    mocks.getCookie.mockReturnValue({ value: locale });
    const { default: RootPage } = await import("@/app/(redirect)/page");

    await expect(RootPage()).rejects.toThrow("NEXT_REDIRECT");

    expect(mocks.getCookie).toHaveBeenCalledWith(localeCookieName);
    expect(mocks.redirect).toHaveBeenCalledWith({ href: "/dashboard", locale });
  });

  test.each([undefined, { value: "invalid" }])(
    "uses the default locale for a missing or invalid locale cookie",
    async (cookie) => {
      mocks.getCookie.mockReturnValue(cookie);
      const { default: RootPage } = await import("@/app/(redirect)/page");

      await expect(RootPage()).rejects.toThrow("NEXT_REDIRECT");
      expect(mocks.redirect).toHaveBeenCalledWith({ href: "/dashboard", locale: defaultLocale });
    }
  );

  test("provides a root document for the redirect route", async () => {
    const { default: RootLayout } = await import("@/app/(redirect)/layout");

    const markup = renderToStaticMarkup(RootLayout({ children: <span>redirect</span> }));

    expect(markup).toBe(
      `<html lang="${defaultLocale}"><head></head><body><span>redirect</span></body></html>`
    );
  });
});
