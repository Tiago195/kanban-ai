import { Inject, Injectable } from '@nestjs/common';
import type { Project as ProjectRow } from '@prisma/client';
import type { ProjectAuthKind } from '@kanban-ai/shared';
import { APP_CONFIG, type AppConfig } from '../../shared/config/config';

/**
 * Subconjunto de um `Project` necessário para resolver credenciais. Aceita a
 * linha completa do Prisma OU um objeto mínimo (facilita testes e evita acoplar
 * o resolvedor ao schema inteiro).
 */
export interface ProjectAuthInput {
  authKind: ProjectAuthKind;
  credentialRef: string | null;
}

/**
 * Material de autenticação para o `onAuth` do isomorphic-git (transporte https).
 * `password` é o TOKEN resolvido de uma env var do servidor — NUNCA persistido,
 * NUNCA logado.
 */
export interface GitHttpAuth {
  username: string;
  password: string;
}

/**
 * Prefixo OPCIONAL tolerado em `credentialRef` (`env:GH_TOKEN_X`). A convenção
 * canônica é o nome cru da env var (`GH_TOKEN_X`); o prefixo é aceito por
 * conveniência/retrocompat, mas o segredo continua sendo lido de `process.env`.
 */
const ENV_PREFIX = 'env:';

/**
 * Usuário default no fluxo https+token. Para GitHub/GitLab/Bitbucket com PAT o
 * usuário é irrelevante desde que o token vá no `password`; `x-access-token` é a
 * convenção documentada do GitHub para tokens.
 */
const DEFAULT_HTTPS_USERNAME = 'x-access-token';

/**
 * EP-PROJECT / US-PROJ3 — Resolução de credenciais git por `Project`.
 *
 * `credentialRef` é uma REFERÊNCIA OPACA ao **nome de uma env var do servidor**
 * (ex.: `credentialRef='GH_TOKEN_ACME'` → o segredo é `process.env.GH_TOKEN_ACME`).
 * ZERO segredo no banco/DTO. O valor resolvido NUNCA é logado (só o *nome* da
 * env var, que não é sensível, aparece em erros/diagnóstico).
 *
 * - `authKind='none'` → sem auth (https público): retorna `null`.
 * - `authKind='https'` → resolve o token da env var referenciada e devolve
 *   `{ username, password: token }` para o `onAuth` do isomorphic-git.
 * - `authKind='ssh'` → isomorphic-git NÃO fala ssh; o clone é delegado ao `git`
 *   do sistema (`ProjectWorkspaceService`) e SÓ é permitido com a flag
 *   `PROJECTS_ALLOW_SSH=true`. Este serviço apenas valida a flag (`assertSshAllowed`).
 */
@Injectable()
export class ProjectCredentialsService {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /**
   * Resolve o material de auth https de um Project. Retorna `null` quando não há
   * auth a aplicar (`authKind='none'`) — o clone segue anônimo. Para `https`,
   * lê o token da env var referenciada por `credentialRef`.
   *
   * NUNCA loga o token. Falha com mensagem LEGÍVEL (só o nome da env var) se a
   * referência estiver ausente/vazia — sem vazar se outras env vars existem.
   */
  resolveHttpAuth(project: ProjectAuthInput): GitHttpAuth | null {
    if (project.authKind !== 'https') return null;

    const envName = this.normalizeRef(project.credentialRef, 'https');
    const token = process.env[envName];
    if (token === undefined || token.length === 0) {
      // Mensagem legível: cita o NOME da env var (não sensível), nunca o valor,
      // e não revela se outras env vars existem.
      throw new Error(
        `Credencial git ausente: a env var "${envName}" (referenciada por ` +
          'credentialRef) não está definida no servidor. Defina-a com o token ' +
          'de acesso https do repositório.',
      );
    }
    return { username: DEFAULT_HTTPS_USERNAME, password: token };
  }

  /**
   * Constrói o callback `onAuth` do isomorphic-git para este Project, ou `null`
   * quando não há auth (`authKind='none'`). O callback resolve o token no momento
   * do handshake git — nunca antes, nunca persistido.
   */
  buildHttpAuthHook(project: ProjectAuthInput): (() => GitHttpAuth) | null {
    if (project.authKind !== 'https') return null;
    // Resolve ansiosamente uma vez para falhar cedo com erro legível (a ausência
    // de env var é um erro de configuração, não de rede).
    const auth = this.resolveHttpAuth(project);
    if (!auth) return null;
    return () => auth;
  }

  /**
   * Garante que o clone via ssh está habilitado. isomorphic-git não fala ssh; o
   * `ProjectWorkspaceService` delega ao `git` do sistema, e isso SÓ é permitido
   * com `PROJECTS_ALLOW_SSH=true`. Lança mensagem legível quando desabilitado.
   */
  assertSshAllowed(project: ProjectAuthInput): void {
    if (project.authKind !== 'ssh') return;
    if (!this.config.projects.allowSsh) {
      throw new Error(
        'Clone via ssh está desabilitado (defina PROJECTS_ALLOW_SSH=true para ' +
          'habilitar o clone delegado ao git do sistema).',
      );
    }
  }

  /**
   * Normaliza `credentialRef` para o NOME da env var: exige presença, remove o
   * prefixo opcional `env:` e recusa vazio. Nunca toca no valor da env var.
   */
  private normalizeRef(ref: string | null, kind: ProjectAuthKind): string {
    const raw = (ref ?? '').trim();
    if (raw.length === 0) {
      throw new Error(
        `Configuração inválida: authKind='${kind}' exige credentialRef ` +
          '(nome da env var do servidor com o token, ex.: GH_TOKEN_ACME).',
      );
    }
    const name = raw.startsWith(ENV_PREFIX) ? raw.slice(ENV_PREFIX.length).trim() : raw;
    if (name.length === 0) {
      throw new Error(
        `Configuração inválida: credentialRef='${raw}' não referencia um nome ` +
          'de env var válido.',
      );
    }
    return name;
  }
}

/** Type guard utilitário: aceita a linha completa do Prisma como input. */
export function asAuthInput(project: ProjectRow): ProjectAuthInput {
  return { authKind: project.authKind, credentialRef: project.credentialRef };
}
