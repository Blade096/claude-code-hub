// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { transformJson, transformRequestBody } from "@/app/v1/_lib/proxy/text-transform/codec";
import {
  LiteralMatcher,
  parseTextTransformConfig,
  type TextTransformConfig,
  TextTransformError,
} from "@/app/v1/_lib/proxy/text-transform/config";
import { prepareTextTransformAttempt } from "@/app/v1/_lib/proxy/text-transform/attempt";
import { restoreTextResponse } from "@/app/v1/_lib/proxy/text-transform/response";

const config: TextTransformConfig = {
  enabled: true,
  caseSensitive: true,
  rules: [
    { source: "wingjoy", target: "site-k7m2" },
    { source: "wingjoy.net", target: "site-k7m2.a.invalid" },
    { source: "wingjoy.cn", target: "site-k7m2.b.invalid" },
  ],
};
const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
const chat = (content: string, index = 0) => ({ choices: [{ index, delta: { content } }] });
async function stream(events: unknown[], chunkSize = 7) {
  const raw = `${events.map(frame).join("")}data: [DONE]\n\n`;
  return restoreRaw(raw, chunkSize);
}
async function restoreRaw(raw: string, chunkSize = 7) {
  const bytes = new TextEncoder().encode(raw);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize)
        controller.enqueue(bytes.slice(i, i + chunkSize));
      controller.close();
    },
  });
  const result = await restoreTextResponse(
    new Response(body, { headers: { "content-type": "text/event-stream", etag: "old" } }),
    config
  );
  expect(result.headers.has("etag")).toBe(false);
  return await result.text();
}
const payloads = (s: string) =>
  s
    .split("\n")
    .filter((l) => l.startsWith("data: {"))
    .map((l) => JSON.parse(l.slice(6)));
afterEach(() => vi.unstubAllEnvs());

describe("配置和字面量匹配", () => {
  it("默认关闭，并按供应商选择", () => {
    expect(parseTextTransformConfig(JSON.stringify({ rules: config.rules }), 1)).toBeNull();
    expect(parseTextTransformConfig(JSON.stringify({ ...config, providerIds: [2] }), 1)).toBeNull();
    expect(parseTextTransformConfig(JSON.stringify({ ...config, providerIds: [2] }), 2)).toEqual({
      ...config,
      providerIds: [2],
    });
  });
  it.each([
    "broken",
    "{}",
    JSON.stringify({ ...config, extra: 1 }),
    JSON.stringify({ ...config, rules: [...config.rules, config.rules[0]] }),
    JSON.stringify({ ...config, rules: [{ source: "a", target: "ab" }] }),
    JSON.stringify({
      ...config,
      rules: [
        { source: "x", target: "z" },
        { source: "y", target: "z" },
      ],
    }),
    JSON.stringify({ ...config, rules: [{ source: "x\n", target: "z" }] }),
  ])("拒绝无效映射且不泄露配置 %s", (raw) => {
    expect(() => parseTextTransformConfig(raw, 1, "en")).toThrow(TextTransformError);
  });
  it("最长匹配、子串匹配、单次替换、保留其他字符", () => {
    const text = "https://api.wingjoy.cn/v1 wingjoy.net wingjoy_sdk 中文";
    const converted = new LiteralMatcher(config).replace(text);
    expect(converted).toBe(
      "https://api.site-k7m2.b.invalid/v1 site-k7m2.a.invalid site-k7m2_sdk 中文"
    );
    expect(new LiteralMatcher(config, true).replace(converted)).toBe(text);
  });
  it("大小写可配置，忽略大小写时恢复为规则中的写法", () => {
    expect(new LiteralMatcher(config).replace("WingJoy")).toBe("WingJoy");
    expect(new LiteralMatcher({ ...config, caseSensitive: false }).replace("WINGJOY.CN")).toBe(
      "site-k7m2.b.invalid"
    );
  });
  it("共享前缀必须等到完整域名或通道结束", () => {
    const matcher = new LiteralMatcher(config, true);
    expect(matcher.consume("site-k7m2")).toEqual({ output: "", tail: "site-k7m2" });
    expect(matcher.consume("site-k7m2.a.invalid!")).toEqual({ output: "wingjoy.net!", tail: "" });
    expect(matcher.consume("site-k7m2", true).output).toBe("wingjoy");
  });
});

describe("请求覆盖与隔离", () => {
  it("拒绝由相邻原文拼出更长代称的歧义", () => {
    expect(() => transformJson({ input: "wingjoy.a.invalid" }, config, false)).toThrow(
      TextTransformError
    );
  });
  it("忽略大小写不会使 Unicode 前缀之后的位置错位", () => {
    expect(
      transformJson({ input: "İ WINGJOY.CN" }, { ...config, caseSensitive: false }, false)
    ).toEqual({ input: "İ site-k7m2.b.invalid" });
  });
  it("带签名的历史思考块含原词时原样透传，普通文本继续转换", async () => {
    const thinking = {
      type: "thinking",
      thinking: "截图里是 wingjoy.cn",
      signature: "sig-wingjoy",
    };
    const body = {
      messages: [
        { role: "assistant", content: [thinking] },
        { role: "user", content: [{ type: "text", text: "wingjoy.cn" }] },
      ],
    };
    const result = JSON.parse(
      (await transformRequestBody(JSON.stringify(body), new Headers(), config)) as string
    );
    expect(result.messages[0].content[0]).toEqual(thinking);
    expect(result.messages[1].content[0].text).toBe("site-k7m2.b.invalid");
    expect(transformJson(result, config, true)).toEqual(body);
    expect(body.messages[1].content[0]).toEqual({ type: "text", text: "wingjoy.cn" });
  });
  it("签名思考的豁免不影响其他协议字段的残留检查", () => {
    const body = {
      id: "wingjoy",
      content: [{ type: "thinking", thinking: "wingjoy", signature: "sig" }],
    };
    expect(() => transformJson(body, config, false)).toThrow(TextTransformError);
  });
  it("工具业务参数中的同名签名结构仍按普通业务文本转换", () => {
    const body = {
      type: "tool_use",
      input: { type: "thinking", thinking: "wingjoy", signature: "wingjoy" },
    };
    expect(transformJson(body, config, false)).toEqual({
      type: "tool_use",
      input: { type: "thinking", thinking: "site-k7m2", signature: "site-k7m2" },
    });
  });
  it("Gemini 带签名的思考内容和签名原样透传", () => {
    const body = {
      contents: [{ parts: [{ thought: true, text: "wingjoy", thoughtSignature: "sig-wingjoy" }] }],
    };
    expect(transformJson(body, config, false)).toEqual(body);
    expect(transformJson(body, config, true)).toEqual(body);
  });
  it.each([
    { type: "thinking", thinking: "wingjoy" },
    { type: "thinking", thinking: "wingjoy", signature: "" },
    { thought: true, text: "wingjoy", thoughtSignature: "" },
  ])("没有有效签名的思考块仍拒绝原词残留 %j", (body) => {
    expect(() => transformJson(body, config, false)).toThrow(TextTransformError);
  });
  it("覆盖四种协议文本且不修改原对象", () => {
    const body = {
      model: "safe",
      system: "wingjoy",
      instructions: "wingjoy.cn",
      input: "wingjoy.net",
      messages: [{ role: "user", content: [{ type: "text", text: "wingjoy" }] }],
      contents: [{ parts: [{ text: "wingjoy.cn" }] }],
      tools: [{ type: "function", name: "wingjoy_sdk", description: "wingjoy" }],
    };
    const result = transformJson(body, config, false);
    expect(JSON.stringify(result)).not.toContain("wingjoy");
    expect(transformJson(result, config, true)).toEqual(body);
    expect(body.system).toBe("wingjoy");
  });
  it("工具参数业务键值和结果可往返，__proto__ 不改变对象原型", () => {
    const body = JSON.parse(
      '{"content":[{"type":"tool_use","id":"tool_1","input":{"wingjoy":"wingjoy.cn","__proto__":"wingjoy"}}],"parts":[{"functionCall":{"name":"safe","args":{"site":"wingjoy.net"}}}]}'
    );
    expect(transformJson(transformJson(body, config, false), config, true)).toEqual(body);
  });
  it("图片、附件和二进制内容按约定透传", () => {
    const body = {
      content: [
        { type: "image", source: { data: "wingjoy" } },
        { type: "input_file", file_data: "wingjoy" },
      ],
      inlineData: { data: "wingjoy" },
    };
    expect(transformJson(body, config, false)).toEqual(body);
  });
  it.each([
    { model: "wingjoy" },
    { id: "wingjoy" },
    { signature: "wingjoy" },
    { unknown: "wingjoy" },
    { wingjoy: "safe" },
  ])("不可修改字段残留阻止发送 %j", (body) => {
    expect(() => transformJson(body, config, false)).toThrow(TextTransformError);
  });
  it.each([{ content: "site-k7m2" }, { type: "tool_use", input: { "site-k7m2": "x" } }])(
    "检测输入代称碰撞 %j",
    (body) => {
      expect(() => transformJson(body, config, false)).toThrow(TextTransformError);
    }
  );
  it("JSON 转义先解码再替换", async () => {
    const result = await transformRequestBody(
      '{"input":"\\u0077ingjoy.cn"}',
      new Headers(),
      config
    );
    expect(result).toBe('{"input":"site-k7m2.b.invalid"}');
  });
  it("不参与转换的协议 ID 中出现代称不误报碰撞", () => {
    expect(transformJson({ id: "site-k7m2", content: "wingjoy" }, config, false)).toEqual({
      id: "site-k7m2",
      content: "site-k7m2",
    });
  });
  it("multipart 文本转换，文件字节原样通过", async () => {
    const form = new FormData();
    form.append("prompt", "wingjoy.cn");
    form.append("image", new Blob(["wingjoy"]), "wingjoy.png");
    const source = new Response(form);
    const headers = new Headers(source.headers);
    const result = await transformRequestBody(await source.arrayBuffer(), headers, config);
    const parsed = await new Response(result, { headers }).formData();
    expect(parsed.get("prompt")).toBe("site-k7m2.b.invalid");
    expect(await (parsed.get("image") as File).text()).toBe("wingjoy");
  });
  it("未配置时零改动，启用后移除过期长度与摘要", async () => {
    vi.stubEnv("CCH_TEXT_TRANSFORM", "");
    const request = {
      providerId: 1,
      url: "https://upstream.invalid",
      headers: new Headers({ "content-length": "12", etag: "old" }),
      body: '{"input":"wingjoy"}',
    };
    expect((await prepareTextTransformAttempt(request)).body).toBe(request.body);
    vi.stubEnv("CCH_TEXT_TRANSFORM", JSON.stringify(config));
    const result = await prepareTextTransformAttempt(request);
    expect(result.body).toContain("site-k7m2");
    expect(result.headers.has("content-length")).toBe(false);
    expect(result.headers.has("etag")).toBe(false);
    expect(request.headers.has("etag")).toBe(true);
  });
  it.each([
    { url: "https://upstream.invalid/%77ingjoy" },
    { headers: new Headers({ authorization: "wingjoy" }) },
    { headers: new Headers({ "content-encoding": "gzip" }) },
    { headers: new Headers({ "content-type": "text/plain" }) },
    { body: "{" },
    { headers: new Headers({ "content-type": "multipart/form-data" }) },
  ])("拒绝无法安全发送的请求 %j", async (overrides) => {
    vi.stubEnv("CCH_TEXT_TRANSFORM", JSON.stringify(config));
    await expect(
      prepareTextTransformAttempt({
        providerId: 1,
        url: "https://safe.invalid",
        headers: new Headers(),
        body: "{}",
        ...overrides,
      })
    ).rejects.toBeInstanceOf(TextTransformError);
  });
  it("无正文以及畸形 URL 不会影响配置快照隔离", async () => {
    vi.stubEnv("CCH_TEXT_TRANSFORM", JSON.stringify(config));
    const first = await prepareTextTransformAttempt({
      providerId: 1,
      url: "https://safe.invalid/%",
      headers: new Headers(),
      body: undefined,
    });
    vi.stubEnv(
      "CCH_TEXT_TRANSFORM",
      JSON.stringify({ ...config, rules: [{ source: "other", target: "alias" }] })
    );
    const second = await prepareTextTransformAttempt({
      providerId: 2,
      url: "https://safe.invalid",
      headers: new Headers(),
      body: undefined,
    });
    expect(first.config?.rules).toEqual(config.rules);
    expect(second.config?.rules).not.toEqual(config.rules);
  });
});

describe("响应与流式还原", () => {
  it("上游错误消息也还原代称并保留状态码", async () => {
    const response = await restoreTextResponse(
      Response.json({ error: { message: "site-k7m2.b.invalid failed" } }, { status: 400 }),
      config
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { message: "wingjoy.cn failed" } });
  });
  it("Gemini CLI 包装和思考/正文通道隔离", async () => {
    const event = (text: string, thought: boolean, finishReason?: string) => ({
      response: {
        candidates: [{ index: 0, content: { parts: [{ text, thought }] }, finishReason }],
      },
    });
    const out = payloads(
      await stream([event("site-k7", true), event("正文", false), event("m2", true, "STOP")])
    );
    expect(
      out
        .filter((p) => p.response.candidates[0].content.parts[0].thought)
        .map((p) => p.response.candidates[0].content.parts[0].text)
        .join("")
    ).toBe("wingjoy");
  });
  it("上游传输错误保持原类型，缓冲超限终止流", async () => {
    const failure = new Error("transport aborted");
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.error(failure);
      },
    });
    const response = await restoreTextResponse(
      new Response(body, { headers: { "content-type": "text/event-stream" } }),
      config
    );
    await expect(response.text()).rejects.toBe(failure);
    await expect(
      restoreRaw(`data: ${"x".repeat(2 * 1024 * 1024)}\n\n`, 3 * 1024 * 1024)
    ).rejects.toBeInstanceOf(TextTransformError);
  });
  it("JSON 还原文本并保持 ID、签名、二进制不变", async () => {
    const result = await restoreTextResponse(
      Response.json(
        {
          id: "site-k7m2",
          signature: "site-k7m2",
          b64_json: "site-k7m2",
          output: [
            { type: "message", content: [{ type: "output_text", text: "site-k7m2.b.invalid" }] },
          ],
        },
        { headers: { digest: "old" } }
      ),
      config
    );
    expect(result.headers.has("digest")).toBe(false);
    expect(await result.json()).toEqual({
      id: "site-k7m2",
      signature: "site-k7m2",
      b64_json: "site-k7m2",
      output: [{ type: "message", content: [{ type: "output_text", text: "wingjoy.cn" }] }],
    });
  });
  it("非 JSON 附件响应原样通过，损坏 JSON 报错", async () => {
    const response = new Response("site-k7m2", { headers: { "content-type": "image/png" } });
    expect(await restoreTextResponse(response, config)).toBe(response);
    await expect(
      restoreTextResponse(
        new Response("{", { headers: { "content-type": "application/json" } }),
        config
      )
    ).rejects.toBeInstanceOf(TextTransformError);
  });
  it("每个字符一个 delta / 每个 UTF-8 字节一个 chunk 均正确", async () => {
    const text = "中文 site-k7m2.a.invalid site-k7m2!";
    const output = await stream(
      [...text].map((c) => chat(c)),
      1
    );
    expect(
      payloads(output)
        .map((p) => p.choices[0].delta.content)
        .join("")
    ).toBe("中文 wingjoy.net wingjoy!");
  });
  it("多 choice 交错不串接，finish 释放短代称", async () => {
    const output = await stream([
      chat("site-k7", 0),
      chat("site-k7m2", 1),
      chat("m2.b.invalid", 0),
      { choices: [{ index: 1, delta: {}, finish_reason: "stop" }] },
    ]);
    const values = payloads(output);
    expect(
      values
        .filter((p) => p.choices[0].index === 0)
        .map((p) => p.choices[0].delta.content ?? "")
        .join("")
    ).toBe("wingjoy.cn");
    expect(
      values
        .filter((p) => p.choices[0].index === 1)
        .map((p) => p.choices[0].delta.content ?? "")
        .join("")
    ).toBe("wingjoy");
  });
  it("Claude 工具 JSON 碎片和最终参数一致", async () => {
    const events = ['{"url":"site-k7', 'm2.b.invalid"}'].map((partial_json) => ({
      type: "content_block_delta",
      index: 2,
      delta: { type: "input_json_delta", partial_json },
    }));
    const out = payloads(await stream([...events, { type: "content_block_stop", index: 2 }]));
    expect(
      JSON.parse(
        out
          .filter((p) => p.delta)
          .map((p) => p.delta.partial_json)
          .join("")
      )
    ).toEqual({ url: "wingjoy.cn" });
  });
  it("OpenAI 并行工具调用按 index 隔离", async () => {
    const tool = (index: number, args: string) => ({
      choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: args } }] } }],
    });
    const out = payloads(
      await stream([tool(0, "site-k7"), tool(1, "other"), tool(0, "m2.a.invalid")])
    );
    expect(
      out
        .filter((p) => p.choices[0].delta.tool_calls[0].index === 0)
        .map((p) => p.choices[0].delta.tool_calls[0].function.arguments)
        .join("")
    ).toBe("wingjoy.net");
  });
  it("Responses delta 和 done 的完整值一致", async () => {
    const out = payloads(
      await stream([
        { type: "response.function_call_arguments.delta", output_index: 0, delta: "site-k7" },
        { type: "response.function_call_arguments.delta", output_index: 0, delta: "m2" },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: { type: "function_call", arguments: "site-k7m2" },
        },
        {
          type: "response.completed",
          response: { output: [{ type: "function_call", arguments: "site-k7m2" }] },
        },
      ])
    );
    expect(
      out
        .filter((p) => p.delta !== undefined)
        .map((p) => p.delta)
        .join("")
    ).toBe("wingjoy");
    expect(out[2].item.arguments).toBe("wingjoy");
  });
  it("Gemini 文本跨事件还原", async () => {
    const gemini = (text: string, finishReason?: string) => ({
      candidates: [{ index: 0, content: { parts: [{ text }] }, finishReason }],
    });
    const out = payloads(await stream([gemini("site-k7"), gemini("m2", "STOP")]));
    expect(out.map((p) => p.candidates[0].content.parts[0].text).join("")).toBe("wingjoy");
  });
  it("保留 SSE 注释、event、id，支持 CRLF 与多行 data", async () => {
    const raw =
      ': ping\r\n\r\nevent: message\r\nid: 1\r\ndata: {"choices":\r\ndata: [{"index":0,"delta":{"content":"site-k7m2!"}}]}\r\n\r\n';
    const result = await restoreRaw(raw);
    expect(result).toContain(": ping");
    expect(result).toContain("event: message");
    expect(result).toContain("id: 1");
    expect(result).toContain("wingjoy!");
  });
  it("EOF 释放合法尾部，截断 SSE 和非法数据报错", async () => {
    expect(await restoreRaw(frame(chat("site-k7m2")))).toContain("wingjoy");
    await expect(restoreRaw("data: {}\n")).rejects.toBeInstanceOf(TextTransformError);
    await expect(restoreRaw("data: bad\n\n")).rejects.toBeInstanceOf(TextTransformError);
    await expect(restoreRaw("data: []\n\n")).rejects.toBeInstanceOf(TextTransformError);
    await expect(
      restoreTextResponse(
        new Response(null, { headers: { "content-type": "text/event-stream" } }),
        config
      )
    ).rejects.toBeInstanceOf(TextTransformError);
  });
  it("客户端取消传递到上游 reader", async () => {
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({ cancel });
    const result = await restoreTextResponse(
      new Response(source, { headers: { "content-type": "text/event-stream" } }),
      config
    );
    await result.body?.cancel("client left");
    expect(cancel).toHaveBeenCalledWith("client left");
  });
});
