import { Controller, Get } from '@nestjs/common';
import type { FleetDashboard } from '@kanban-ai/shared';

import { DashboardService } from './dashboard.service';

/**
 * US-OBS1 — `GET /dashboard`: read-model agregado da frota (counts por coluna,
 * stories stale e burn/cost). Read-only e sem segredos (ver `DashboardService`).
 */
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  getFleetDashboard(): Promise<FleetDashboard> {
    return this.dashboard.getFleetDashboard();
  }
}
