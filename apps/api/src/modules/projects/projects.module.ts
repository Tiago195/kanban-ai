import { Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { ProjectWorkspaceService } from './project-workspace.service';
import { ProjectCredentialsService } from './project-credentials.service';
import { ProjectExplorerService } from './project-explorer.service';

@Module({
  controllers: [ProjectsController],
  providers: [
    ProjectsService,
    ProjectWorkspaceService,
    ProjectCredentialsService,
    ProjectExplorerService,
  ],
  exports: [ProjectsService, ProjectWorkspaceService, ProjectCredentialsService],
})
export class ProjectsModule {}
