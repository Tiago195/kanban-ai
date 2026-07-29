import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  check(): { status: string; service: string; version: string; ts: number } {
    return {
      status: 'ok',
      service: 'kanban-ai-api',
      version: process.env.npm_package_version ?? '0.0.0',
      ts: Date.now(),
    };
  }
}
