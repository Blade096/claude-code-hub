"use client";

import { ArrowRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { ThinkingEffortBadge } from "@/components/customs/thinking-effort-badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  extractThinkingEffortInfo,
  getThinkingEffortMessageNamespace,
} from "@/lib/utils/thinking-effort";
import type { SpecialSetting } from "@/types/special-settings";

interface ThinkingEffortDisplayProps {
  specialSettings: SpecialSetting[] | null | undefined;
}

export function ThinkingEffortDisplay({ specialSettings }: ThinkingEffortDisplayProps) {
  const t = useTranslations("dashboard.logs.details");
  const effortInfo = extractThinkingEffortInfo(specialSettings);

  if (!effortInfo) return <span className="text-muted-foreground">-</span>;

  const namespace = getThinkingEffortMessageNamespace(effortInfo.source);
  const showEffective = effortInfo.isOverridden && effortInfo.effectiveEffort != null;

  return (
    <TooltipProvider>
      <Tooltip delayDuration={250}>
        <TooltipTrigger asChild>
          <span
            className="relative z-20 inline-flex items-center gap-1 whitespace-nowrap"
            data-slot="thinking-effort"
          >
            {effortInfo.requestedEffort && (
              <ThinkingEffortBadge
                effort={effortInfo.requestedEffort}
                label={effortInfo.requestedEffort}
              />
            )}
            {showEffective && effortInfo.requestedEffort && (
              <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
            {showEffective && (
              <ThinkingEffortBadge
                effort={effortInfo.effectiveEffort as string}
                label={effortInfo.effectiveEffort as string}
              />
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs space-y-1">
          <p className="text-xs">{t(`${namespace}.tooltip`)}</p>
          {effortInfo.isOverridden && (
            <p className="text-xs text-muted-foreground">{t(`${namespace}.overridden`)}</p>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
