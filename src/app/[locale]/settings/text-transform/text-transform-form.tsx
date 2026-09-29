"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { apiClient } from "@/lib/api-client/v1/client";
import { ApiError } from "@/lib/api-client/v1/errors";
import { type TextTransformSettings, textTransformConfigSchema } from "@/lib/text-transform/schema";
import { ProviderMultiSelect } from "../request-filters/_components/provider-multi-select";

const queryKey = ["settings", "text-transform"];

export function TextTransformForm() {
  const t = useTranslations("settings.textTransform");
  const client = useQueryClient();
  const query = useQuery({
    queryKey,
    queryFn: () => apiClient.get<TextTransformSettings>("/api/v1/text-transform"),
    refetchOnWindowFocus: false,
    retry: false,
  });
  if (query.isPending) return <p role="status">{t("loading")}</p>;
  if (query.isError)
    return (
      <div role="alert" className="space-y-3">
        <p>{t("loadError")}</p>
        <Button variant="outline" onClick={() => query.refetch()}>
          {t("retry")}
        </Button>
      </div>
    );
  return (
    <Editor
      key={`${query.data.source}-${query.data.revision}`}
      settings={query.data}
      onSaved={(settings) => client.setQueryData(queryKey, settings)}
      onReload={() => query.refetch()}
    />
  );
}

function Editor({
  settings,
  onSaved,
  onReload,
}: {
  settings: TextTransformSettings;
  onSaved: (settings: TextTransformSettings) => void;
  onReload: () => void;
}) {
  const t = useTranslations("settings.textTransform");
  const [enabled, setEnabled] = useState(settings.config.enabled);
  const [caseSensitive, setCaseSensitive] = useState(settings.config.caseSensitive);
  const [scope, setScope] = useState(settings.config.providerIds ? "selected" : "all");
  const [providerIds, setProviderIds] = useState(settings.config.providerIds ?? []);
  const [rules, setRules] = useState(() =>
    settings.config.rules.map((r, i) => ({ ...r, id: `initial-${i}` }))
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<"invalid" | "saveError" | "conflict" | null>(null);
  const [dirty, setDirty] = useState(false);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const parsed = textTransformConfigSchema.safeParse({
      enabled,
      caseSensitive,
      rules: rules.map(({ source, target }) => ({ source, target })),
      ...(scope === "selected" ? { providerIds } : {}),
    });
    if (!parsed.success) {
      setError("invalid");
      return;
    }
    setSaving(true);
    try {
      const result = await apiClient.put<TextTransformSettings>("/api/v1/text-transform", {
        config: parsed.data,
        revision: settings.revision,
      });
      onSaved(result);
      toast.success(t("saved"));
    } catch (e) {
      setError(e instanceof ApiError && e.status === 409 ? "conflict" : "saveError");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-5" onChange={() => setDirty(true)}>
      <Card>
        <CardContent className="space-y-5">
          <p className="text-sm text-muted-foreground">{t(`sources.${settings.source}`)}</p>
          <fieldset disabled={saving} className="space-y-5">
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="text-transform-enabled">{t("enabled")}</Label>
              <Switch
                id="text-transform-enabled"
                checked={enabled}
                onCheckedChange={(v) => {
                  setEnabled(v);
                  setDirty(true);
                }}
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="text-transform-case">{t("caseSensitive")}</Label>
                <p className="mt-1 text-sm text-muted-foreground">{t("caseHint")}</p>
              </div>
              <Switch
                id="text-transform-case"
                checked={caseSensitive}
                onCheckedChange={(v) => {
                  setCaseSensitive(v);
                  setDirty(true);
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="text-transform-scope">{t("scope")}</Label>
              <select
                id="text-transform-scope"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              >
                <option value="all">{t("allProviders")}</option>
                <option value="selected">{t("selectedProviders")}</option>
              </select>
              {scope === "selected" && (
                <div role="group" aria-label={t("selectedProviders")}>
                  <ProviderMultiSelect
                    disabled={saving}
                    selectedProviderIds={providerIds}
                    onChange={(ids) => {
                      setProviderIds(ids);
                      setDirty(true);
                    }}
                  />
                </div>
              )}
              <p className="text-sm text-muted-foreground">{t("scopeHint")}</p>
            </div>
          </fieldset>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="space-y-4">
          <div>
            <h2 className="font-semibold">{t("rules")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("rulesHint")}</p>
          </div>
          <fieldset disabled={saving} className="space-y-3">
            {!rules.length && <p className="text-sm text-muted-foreground">{t("empty")}</p>}
            {rules.map((rule, index) => (
              <div
                key={rule.id}
                className="grid grid-cols-[1fr_auto] items-end gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_1fr_auto]"
              >
                <div className="col-span-2 space-y-1 sm:col-span-1">
                  <Label htmlFor={`source-${rule.id}`}>{t("source", { index: index + 1 })}</Label>
                  <Input
                    id={`source-${rule.id}`}
                    value={rule.source}
                    required
                    maxLength={256}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) =>
                      setRules(
                        rules.map((r) => (r.id === rule.id ? { ...r, source: e.target.value } : r))
                      )
                    }
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`target-${rule.id}`}>{t("target", { index: index + 1 })}</Label>
                  <Input
                    id={`target-${rule.id}`}
                    value={rule.target}
                    required
                    maxLength={256}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) =>
                      setRules(
                        rules.map((r) => (r.id === rule.id ? { ...r, target: e.target.value } : r))
                      )
                    }
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t("remove", { index: index + 1 })}
                  onClick={() => {
                    setRules(rules.filter((r) => r.id !== rule.id));
                    setDirty(true);
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={rules.length >= 100}
                onClick={() => {
                  setRules([...rules, { id: crypto.randomUUID(), source: "", target: "" }]);
                  setDirty(true);
                }}
              >
                <Plus className="mr-2 h-4 w-4" />
                {t("add")}
              </Button>
              {!rules.length && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setRules(
                      [
                        { source: "wingjoy.net", target: "site-k7m2.a.invalid" },
                        { source: "wingjoy.cn", target: "site-k7m2.b.invalid" },
                        { source: "wingjoy", target: "site-k7m2" },
                      ].map((r) => ({ ...r, id: crypto.randomUUID() }))
                    );
                    setDirty(true);
                  }}
                >
                  {t("example")}
                </Button>
              )}
            </div>
          </fieldset>
        </CardContent>
      </Card>
      <p className="text-sm text-muted-foreground">{t("coverage")}</p>
      {error && (
        <div role="alert" className="space-y-2 text-sm text-destructive">
          <p>{t(error)}</p>
          {error === "conflict" && (
            <Button type="button" variant="outline" onClick={onReload}>
              {t("reload")}
            </Button>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={saving || !dirty}>
          {t(saving ? "saving" : "save")}
        </Button>
        <span className="text-sm text-muted-foreground">{t("applyHint")}</span>
      </div>
    </form>
  );
}
