import { Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { ProjectWorkspaceService } from './project-workspace.service';
import { ProjectCredentialsService } from './project-credentials.service';
import { ProjectExplorerService } from './project-explorer.service';
import { ProjectGraphService } from './project-graph.service';
import { ProjectGraphQueryService } from './project-graph-query.service';
import { ProjectHiveService } from './project-hive.service';

@Module({
  controllers: [ProjectsController],
  providers: [
    ProjectsService,
    ProjectWorkspaceService,
    ProjectCredentialsService,
    ProjectExplorerService,
    ProjectGraphService,
    ProjectGraphQueryService,
    // US-F2.3 — a colmeia do Project (`<clone>/.hive/**.md`), leitura+escrita.
    ProjectHiveService,
  ],
  exports: [
    ProjectsService,
    ProjectWorkspaceService,
    ProjectCredentialsService,
    ProjectGraphService,
    // US-F1.4 — exportado para os consumidores de contexto de grafo (EP-F2).
    ProjectGraphQueryService,
    // US-F2.3 — o orchestrator escreve learnings direto na colmeia do clone.
    ProjectHiveService,
  ],
})
export class ProjectsModule {}
