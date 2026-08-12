import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import git from 'isomorphic-git';
import type { AppConfig } from '../../shared/config/config';
import { MEMORY_DEFAULT_BRANCH, MemoryGitService } from './memory-git.service';

// --- MemoryGitService: provisionamento idempotente do bare repo (ADR-0027, Camada 1) ---

/** Cria um gitDir isolado num tmpdir novo (nunca dentro do repo-alvo). */
function makeTmpGitDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-mem-'));
  return path.join(root, 'git');
}

/** Instancia o serviço com um config fake — só `memory.gitDir` é consumido. */
function makeService(gitDir: string): MemoryGitService {
  const config = { memory: { gitDir } } as unknown as AppConfig;
  return new MemoryGitService(config);
}

/** Remove o tmpdir raiz do gitDir (limpeza pós-teste). */
function cleanup(gitDir: string): void {
  fs.rmSync(path.dirname(gitDir), { recursive: true, force: true });
}

test('provision: init em tmpdir vazio cria bare repo com branch main e 1 commit de bootstrap', async () => {
  const gitDir = makeTmpGitDir();
  try {
    const svc = makeService(gitDir);
    await svc.provision();

    // É um repo bare: HEAD existe e aponta para refs/heads/main.
    assert.ok(fs.existsSync(path.join(gitDir, 'HEAD')));
    assert.equal(
      fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim(),
      `ref: refs/heads/${MEMORY_DEFAULT_BRANCH}`,
    );

    const branch = await git.currentBranch({ fs, dir: gitDir, gitdir: gitDir });
    assert.equal(branch, MEMORY_DEFAULT_BRANCH);

    // Commit de bootstrap materializa main: HEAD resolve e há exatamente 1 commit.
    const log = await git.log({ fs, dir: gitDir, gitdir: gitDir });
    assert.equal(log.length, 1);
    assert.equal(log[0].commit.message.trim(), 'chore: bootstrap memory repo');
  } finally {
    cleanup(gitDir);
  }
});

test('provision: reabertura é idempotente (N execuções = mesmo HEAD e 1 commit)', async () => {
  const gitDir = makeTmpGitDir();
  try {
    const svc = makeService(gitDir);
    await svc.provision();
    const first = await git.resolveRef({
      fs,
      dir: gitDir,
      gitdir: gitDir,
      ref: 'HEAD',
    });

    // Reexecuta várias vezes: não deve recommitar nem mover o HEAD.
    await svc.provision();
    await svc.provision();

    const again = await git.resolveRef({
      fs,
      dir: gitDir,
      gitdir: gitDir,
      ref: 'HEAD',
    });
    assert.equal(again, first);

    const log = await git.log({ fs, dir: gitDir, gitdir: gitDir });
    assert.equal(log.length, 1);
  } finally {
    cleanup(gitDir);
  }
});

test('provision: valida HEAD apontando para a branch main', async () => {
  const gitDir = makeTmpGitDir();
  try {
    const svc = makeService(gitDir);
    await svc.provision();

    const branch = await git.currentBranch({ fs, dir: gitDir, gitdir: gitDir });
    assert.equal(branch, MEMORY_DEFAULT_BRANCH);
  } finally {
    cleanup(gitDir);
  }
});

test('provision: commit de bootstrap é determinístico (SHA reproduzível entre inits independentes)', async () => {
  // Autoria/timestamp fixos + árvore vazia + mensagem fixa => mesmo SHA sempre.
  const gitDirA = makeTmpGitDir();
  const gitDirB = makeTmpGitDir();
  try {
    await makeService(gitDirA).provision();
    await makeService(gitDirB).provision();

    const shaA = await git.resolveRef({
      fs,
      dir: gitDirA,
      gitdir: gitDirA,
      ref: 'HEAD',
    });
    const shaB = await git.resolveRef({
      fs,
      dir: gitDirB,
      gitdir: gitDirB,
      ref: 'HEAD',
    });
    assert.equal(shaA, shaB);
  } finally {
    cleanup(gitDirA);
    cleanup(gitDirB);
  }
});

test('provision: HEAD divergente da branch main falha cedo com mensagem acionável (cita MEMORY_GIT_DIR)', async () => {
  const gitDir = makeTmpGitDir();
  try {
    // Pré-inicializa um bare repo com uma branch default diferente para forçar
    // divergência; `git.init` em provision() é idempotente e não reescreve o HEAD.
    await git.init({
      fs,
      dir: gitDir,
      gitdir: gitDir,
      bare: true,
      defaultBranch: 'trunk',
    });

    await assert.rejects(
      () => makeService(gitDir).provision(),
      (err: Error) => {
        assert.match(err.message, /HEAD inesperado/);
        assert.match(err.message, new RegExp(MEMORY_DEFAULT_BRANCH));
        assert.match(err.message, /MEMORY_GIT_DIR/);
        return true;
      },
    );
  } finally {
    cleanup(gitDir);
  }
});

test('onModuleInit: delega para provision() e deixa o bare repo pronto', async () => {
  const gitDir = makeTmpGitDir();
  try {
    const svc = makeService(gitDir);
    await svc.onModuleInit();

    const branch = await git.currentBranch({ fs, dir: gitDir, gitdir: gitDir });
    assert.equal(branch, MEMORY_DEFAULT_BRANCH);
    const log = await git.log({ fs, dir: gitDir, gitdir: gitDir });
    assert.equal(log.length, 1);
  } finally {
    cleanup(gitDir);
  }
});
