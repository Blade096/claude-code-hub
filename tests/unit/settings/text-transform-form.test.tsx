import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextTransformForm } from "@/app/[locale]/settings/text-transform/text-transform-form";
import { ApiError } from "@/lib/api-client/v1/errors";
const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock("@/lib/api-client/v1/client", () => ({ apiClient: api }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
vi.mock("@/app/[locale]/settings/request-filters/_components/provider-multi-select", () => ({
  ProviderMultiSelect: ({ onChange }: { onChange: (ids: number[]) => void }) => (
    <button type="button" onClick={() => onChange([7])}>
      provider-seven
    </button>
  ),
}));
const initial = {
  config: { enabled: false, caseSensitive: true, rules: [] },
  revision: 0,
  source: "default",
};
let root: Root;
let client: QueryClient;
const delay = () => new Promise((done) => setTimeout(done, 15));
const button = (text: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent === text) as HTMLButtonElement;
async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
    await delay();
  });
}
async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const textTransform = JSON.parse(readFileSync("messages/en/settings/textTransform.json", "utf8"));
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <NextIntlClientProvider
          locale="en"
          messages={{ settings: { textTransform } }}
          timeZone="UTC"
        >
          <TextTransformForm />
        </NextIntlClientProvider>
      </QueryClientProvider>
    );
  });
  await act(async () => {
    await delay();
  });
}
async function submit() {
  await act(async () => {
    document
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await delay();
  });
}
beforeEach(() => {
  document.body.innerHTML = "";
  api.get.mockResolvedValue(structuredClone(initial));
  api.put.mockImplementation(async (_path, body) => ({ ...body, revision: 1, source: "database" }));
});
afterEach(() => {
  if (root) act(() => root.unmount());
  client?.clear();
});

describe("后台文本保护表单", () => {
  it("展示关闭状态，可填入三条示例并保存启用", async () => {
    await mount();
    expect(button("Save settings").disabled).toBe(true);
    await click(button("Use Wingjoy example"));
    expect(document.querySelectorAll("input[id^=source-], input[id^=target-]")).toHaveLength(6);
    await click(document.getElementById("text-transform-enabled") as HTMLElement);
    await submit();
    expect(api.put).toHaveBeenCalledWith(
      "/api/v1/text-transform",
      expect.objectContaining({
        revision: 0,
        config: expect.objectContaining({
          enabled: true,
          rules: expect.arrayContaining([{ source: "wingjoy.cn", target: "site-k7m2.b.invalid" }]),
        }),
      })
    );
    await vi.waitFor(async () => {
      await act(async () => {
        await delay();
      });
      expect(document.body.textContent).toContain("Using settings saved in the dashboard");
    });
  });
  it("启用空规则不能保存，新增/编辑/删除规则并切换供应商范围", async () => {
    await mount();
    await click(document.getElementById("text-transform-enabled") as HTMLElement);
    await submit();
    expect(document.body.textContent).toContain("Invalid rules");
    expect(api.put).not.toHaveBeenCalled();
    await click(button("Add rule"));
    await click(button("Add rule"));
    const inputs = [...document.querySelectorAll("input[id^=source-], input[id^=target-]")];
    for (const [i, value] of ["brand", "alias", "other", "another"].entries()) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
          inputs[i],
          value
        );
        inputs[i].dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    await click(document.querySelector('[aria-label="Remove rule 2"]') as HTMLElement);
    await click(document.getElementById("text-transform-case") as HTMLElement);
    await act(async () => {
      const select = document.querySelector("select") as HTMLSelectElement;
      select.value = "selected";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click(button("provider-seven"));
    await submit();
    expect(api.put).toHaveBeenCalledWith(
      "/api/v1/text-transform",
      expect.objectContaining({
        config: {
          enabled: true,
          caseSensitive: false,
          providerIds: [7],
          rules: [{ source: "brand", target: "alias" }],
        },
      })
    );
  });
  it("保存冲突保留编辑并允许明确重新加载", async () => {
    api.put.mockRejectedValue(
      new ApiError({ status: 409, errorCode: "text_transform.conflict", detail: "conflict" })
    );
    await mount();
    await click(button("Use Wingjoy example"));
    await submit();
    expect(document.querySelectorAll("input[id^=source-], input[id^=target-]")).toHaveLength(6);
    expect(document.body.textContent).toContain("Another administrator");
    api.get.mockResolvedValue({ ...initial, source: "database", revision: 4 });
    await click(button("Reload settings"));
    expect(document.querySelectorAll("input[id^=source-], input[id^=target-]")).toHaveLength(0);
  });
  it("保存失败保留输入，读取失败提供重试", async () => {
    api.get.mockRejectedValueOnce(new Error("network"));
    await mount();
    expect(document.body.textContent).toContain("Could not load");
    await click(button("Retry"));
    await click(button("Use Wingjoy example"));
    api.put.mockRejectedValue(new Error("network"));
    await submit();
    expect(document.body.textContent).toContain("Your edits are still");
  });
  it("五种语言有完整同构文案与导航入口", () => {
    const base = JSON.parse(readFileSync("messages/en/settings/textTransform.json", "utf8"));
    for (const locale of ["zh-CN", "zh-TW", "en", "ja", "ru"]) {
      const strings = JSON.parse(
        readFileSync(`messages/${locale}/settings/textTransform.json`, "utf8")
      );
      expect(Object.keys(strings).sort()).toEqual(Object.keys(base).sort());
      expect(
        JSON.parse(readFileSync(`messages/${locale}/settings/nav.json`, "utf8")).textTransform
      ).toBe(strings.title);
    }
  });
});
