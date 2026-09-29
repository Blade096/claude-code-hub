import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { requireAuth } from "@/lib/api/v1/_shared/auth-middleware";
import { createProblemJson, fromZodError } from "@/lib/api/v1/_shared/error-envelope";
import { ProblemJsonSchema } from "@/lib/api/v1/schemas/_common";
import { textTransformConfigSchema } from "@/lib/text-transform/schema";
import {
  getEffectiveTextTransformSettings,
  invalidateTextTransformSettings,
} from "@/lib/text-transform/settings";
import { saveTextTransformSettings } from "@/repository/text-transform";

// OpenAPI DTO 与共享的业务校验分开，后者还校验映射间的关系。
const configDto = z
  .object({
    enabled: z.boolean(),
    caseSensitive: z.boolean(),
    providerIds: z.array(z.number().int().positive()).min(1).optional(),
    rules: z
      .array(
        z
          .object({ source: z.string().min(1).max(256), target: z.string().min(1).max(256) })
          .strict()
      )
      .max(100),
  })
  .strict();
const settingsDto = z.object({
  config: configDto,
  revision: z.number().int().nonnegative(),
  source: z.enum(["database", "environment", "default"]),
});
const saveDto = z.object({ config: configDto, revision: z.number().int().nonnegative() }).strict();
const security: Array<Record<string, string[]>> = [
  { cookieAuth: [] },
  { bearerAuth: [] },
  { apiKeyAuth: [] },
];
const problemSpec = {
  description: "配置请求失败。",
  content: { "application/problem+json": { schema: ProblemJsonSchema } },
};
const errors = {
  400: problemSpec,
  401: problemSpec,
  403: problemSpec,
  409: problemSpec,
  503: problemSpec,
};
const problemHeaders = { "Content-Type": "application/problem+json", "Cache-Control": "no-store" };

export const textTransformRouter = new OpenAPIHono({
  defaultHook: (result, c) => {
    if (!result.success) return fromZodError(result.error, new URL(c.req.url).pathname);
  },
});

textTransformRouter.openapi(
  createRoute({
    method: "get",
    path: "/text-transform",
    middleware: requireAuth("admin") as never,
    tags: ["Text Transform"],
    summary: "读取文本保护配置",
    description: "管理员读取当前生效配置、来源及并发编辑版本。",
    "x-required-access": "admin",
    security,
    responses: {
      200: {
        description: "当前生效配置及版本。",
        content: { "application/json": { schema: settingsDto } },
      },
      ...errors,
    },
  }),
  async (c) => {
    try {
      const result = await getEffectiveTextTransformSettings(true);
      return c.json(result, 200, { "Cache-Control": "no-store" });
    } catch {
      return c.json(
        createProblemJson({
          status: 503,
          errorCode: "text_transform.unavailable",
          instance: new URL(c.req.url).pathname,
        }),
        503,
        problemHeaders
      );
    }
  }
);

textTransformRouter.openapi(
  createRoute({
    method: "put",
    path: "/text-transform",
    middleware: requireAuth("admin") as never,
    tags: ["Text Transform"],
    summary: "保存文本保护配置",
    description: "校验映射并使用版本号原子保存，成功后清除本实例的配置缓存。",
    "x-required-access": "admin",
    security,
    request: { body: { required: true, content: { "application/json": { schema: saveDto } } } },
    responses: {
      200: {
        description: "保存后的配置及版本。",
        content: { "application/json": { schema: settingsDto } },
      },
      ...errors,
    },
  }),
  async (c) => {
    const body = c.req.valid("json");
    const parsed = textTransformConfigSchema.safeParse(body.config);
    if (!parsed.success)
      return c.json(
        createProblemJson({
          status: 400,
          errorCode: "request.validation_failed",
          instance: new URL(c.req.url).pathname,
        }),
        400,
        problemHeaders
      );
    try {
      const saved = await saveTextTransformSettings(parsed.data, body.revision);
      if (!saved)
        return c.json(
          createProblemJson({
            status: 409,
            errorCode: "text_transform.conflict",
            instance: new URL(c.req.url).pathname,
          }),
          409,
          problemHeaders
        );
      invalidateTextTransformSettings();
      return c.json({ ...saved, source: "database" as const }, 200, {
        "Cache-Control": "no-store",
      });
    } catch {
      return c.json(
        createProblemJson({
          status: 503,
          errorCode: "text_transform.unavailable",
          instance: new URL(c.req.url).pathname,
        }),
        503,
        problemHeaders
      );
    }
  }
);
