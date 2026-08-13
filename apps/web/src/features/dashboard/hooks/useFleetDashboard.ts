import { useQuery } from "@tanstack/react-query";

import { queryKeys } from "@/features/board/services/queryKeys";
import { apiClient } from "@/shared/services/apiClient";
import type { FleetDashboard } from "@kanban-ai/shared";

/**
 * US-OBS1 — read-model agregado da frota (GET /dashboard).
 *
 * Polling curto (~15s) para refletir counts/stale/cost sem F5. Mesmo pipeline
 * request→hook→painel do `useLoopMetrics`.
 */
export function useFleetDashboard(enabled = true) {
  return useQuery<FleetDashboard>({
    queryKey: queryKeys.dashboard(),
    queryFn: () => apiClient.getFleetDashboard(),
    enabled,
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
}
