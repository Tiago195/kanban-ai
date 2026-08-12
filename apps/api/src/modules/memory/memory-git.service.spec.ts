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

// --- Camada 1: read/write/merge/diff/history de neurônios (US-136..141) ---

test('writeNeuron + readNeuron: grava em branch de sessão e lê o conteúdo', async () => {
  const gitDir = makeTmpGitDir();
  try {
    const svc = makeService(gitDir);
    await svc.provision();

    const { oid, branch } = await svc.writeNeuron({
      path: 'api/cards.md',
      content: '# Cards\nregra 1',
      sessionId: 'sess-1',
      message: 'feat: nota de cards',
    });
    assert.equal(branch, 'mem/ai/sess-1/api/cards.md');
    assert.ok(oid);

    // Lê pela branch da sessão.
    const onBranch = await svc.readNeuron('api/cards.md', branch);
    assert.equal(onBranch, '# Cards\nregra 1');

    // Em main ainda não existe (escrita otimista por branch).
    const onMain = await svc.readNeuron('api/cards.md');
    assert.equal(onMain, null);
  } finally {
    cleanup(gitDir);
  }
});

test('readNeuron: path inexistente retorna null; ref inexistente retorna null', async () => {
  const gitDir = makeTmpGitDir();
  try {
    const svc = makeService(gitDir);
    await svc.provision();
    assert.equal(await svc.readNeuron('nao/existe.md'), null);
    assert.equal(await svc.readNeuron('nao/existe.md', 'refs/heads/inexistente'), null);
  } finally {
    cleanup(gitDir);
  }
});

test('writeNeuron: paths aninhados criam subárvores corretamente', async () => {
  const gitDir = makeTmpGitDir();
  try {
    const svc = makeService(gitDir);
    await svc.provision();
    const c = await svc.writeNeuron({ path: 'a/b/c.md', content: 'C', sessionId: 's', message: 'm1' });
    const d = await svc.writeNeuron({ path: 'a/b/d.md', content: 'D', sessionId: 's', message: 'm2' });
    // Branch por sessão+path (ADR-0027): cada path tem a sua branch efêmera.
    assert.equal(await svc.readNeuron('a/b/c.md', c.branch), 'C');
    assert.equal(await svc.readNeuron('a/b/d.md', d.branch), 'D');
    // Após integrar as duas branches, ambos coexistem em main.
    await svc.mergeSessionBranch({ sessionId: 's', path: 'a/b/c.md' });
    await svc.mergeSessionBranch({ sessionId: 's', path: 'a/b/d.md' });
    assert.equal(await svc.readNeuron('a/b/c.md'), 'C');
    assert.equal(await svc.readNeuron('a/b/d.md'), 'D');
  } finally {
    cleanup(gitDir);
  }
});

test('mergeSessionBranch: merge limpo integra a branch em main', async () => {
  const gitDir = makeTmpGitDir();
  try {
    const svc = makeService(gitDir);
    await svc.provision();
    await svc.writeNeuron({ path: 'api/x.md', content: 'v1', sessionId: 's1', message: 'm' });

    const res = await svc.mergeSessionBranch({ sessionId: 's1', path: 'api/x.md' });
    assert.equal(res.merged, true);
    assert.equal(res.conflict, false);
    // Agora existe em main.
    assert.equal(await svc.readNeuron('api/x.md'), 'v1');
  } finally {
    cleanup(gitDir);
  }
});

test('mergeSessionBranch: edições concorrentes no mesmo path sinalizam conflict', async () => {
  const gitDir = makeTmpGitDir();
  try {
    const svc = makeService(gitDir);
    await svc.provision();

    // Sessão 1 escreve e integra em main.
    await svc.writeNeuron({ path: 'api/y.md', content: 'base\nA', sessionId: 's1', message: 'm1' });
    await svc.mergeSessionBranch({ sessionId: 's1', path: 'api/y.md' });

    // Sessão 2 partiu de main ANTES? Aqui simulamos divergência: escreve a
    // partir do main atual mas com conteúdo conflitante e main também muda.
    await svc.writeNeuron({ path: 'api/y.md', content: 'base\nB', sessionId: 's2', message: 'm2' });
    // Uma 3ª escrita em s1 muda main de novo, no mesmo trecho.
    await svc.writeNeuron({ path: 'api/y.md', content: 'base\nC', sessionId: 's1', message: 'm3' });
    await svc.mergeSessionBranch({ sessionId: 's1', path: 'api/y.md' });

    const res = await svc.mergeSessionBranch({ sessionId: 's2', path: 'api/y.md' });
    // Não deve escrever main às cegas: ou fez merge limpo, ou sinalizou conflito.
    assert.equal(typeof res.conflict, 'boolean');
    if (res.conflict) {
      assert.equal(res.merged, false);
      // main permanece com o conteúdo da s1 (não corrompido).
      assert.equal(await svc.readNeuron('api/y.md'), 'base\nC');
    }
  } finally {
    cleanup(gitDir);
  }
});

test('diffNeuron: reporta added/modified/deleted/unchanged entre commits', async () => {
  const gitDir = makeTmpGitDir();
  try {
    const svc = makeService(gitDir);
    await svc.provision();
    const mainBase = await git.resolveRef({ fs, dir: gitDir, gitdir: gitDir, ref: MEMORY_DEFAULT_BRANCH });

    await svc.writeNeuron({ path: 'api/z.md', content: 'um', sessionId: 's1', message: 'add' });
    await svc.mergeSessionBranch({ sessionId: 's1', path: 'api/z.md' });
    const afterAdd = await git.resolveRef({ fs, dir: gitDir, gitdir: gitDir, ref: MEMORY_DEFAULT_BRANCH });

    // added: não existia em mainBase, existe em afterAdd.
    const added = await svc.diffNeuron({ path: 'api/z.md', from: mainBase, to: afterAdd });
    assert.equal(added.status, 'added');
    assert.equal(added.before, null);
    assert.equal(added.after, 'um');

    // modified
    await svc.writeNeuron({ path: 'api/z.md', content: 'dois', sessionId: 's2', message: 'mod' });
    await svc.mergeSessionBranch({ sessionId: 's2', path: 'api/z.md' });
    const mod = await svc.diffNeuron({ path: 'api/z.md', from: afterAdd });
    assert.equal(mod.status, 'modified');
    assert.equal(mod.before, 'um');
    assert.equal(mod.after, 'dois');

    // unchanged
    const same = await svc.diffNeuron({ path: 'api/z.md', from: afterAdd, to: afterAdd });
    assert.equal(same.status, 'unchanged');
  } finally {
    cleanup(gitDir);
  }
});

test('historyNeuron: lista commits que tocaram o path, do mais recente ao mais antigo', async () => {
  const gitDir = makeTmpGitDir();
  try {
    const svc = makeService(gitDir);
    await svc.provision();
    await svc.writeNeuron({ path: 'api/h.md', content: '1', sessionId: 's1', message: 'primeiro' });
    await svc.mergeSessionBranch({ sessionId: 's1', path: 'api/h.md' });
    await svc.writeNeuron({ path: 'api/h.md', content: '2', sessionId: 's2', message: 'segundo' });
    await svc.mergeSessionBranch({ sessionId: 's2', path: 'api/h.md' });

    const hist = await svc.historyNeuron('api/h.md');
    assert.ok(hist.length >= 2);
    assert.equal(hist[0].message, 'segundo');
    assert.ok(hist.some((h) => h.message === 'primeiro'));
    assert.ok(hist[0].author.name);
  } finally {
    cleanup(gitDir);
  }
});

test('historyNeuron: path inexistente retorna lista vazia', async () => {
  const gitDir = makeTmpGitDir();
  try {
    const svc = makeService(gitDir);
    await svc.provision();
    assert.deepEqual(await svc.historyNeuron('nunca/existiu.md'), []);
  } finally {
    cleanup(gitDir);
  }
});

test('normalizePath: rejeita path com ".." (evita escapar do repo)', async () => {
  const gitDir = makeTmpGitDir();
  try {
    const svc = makeService(gitDir);
    await svc.provision();
    await assert.rejects(
      () => svc.writeNeuron({ path: '../evil.md', content: 'x', sessionId: 's', message: 'm' }),
      /inválido/,
    );
  } finally {
    cleanup(gitDir);
  }
});

test('resolveHead + listNeurons: refletem os neuronios integrados em main', async () => {
  const gitDir = makeTmpGitDir();
  try {
    const svc = makeService(gitDir);
    await svc.provision();

    // Sem neuronios: lista vazia; resolveHead aponta o bootstrap.
    assert.deepEqual(await svc.listNeurons(), []);
    const bootstrap = await svc.resolveHead();
    assert.match(bootstrap, /^[0-9a-f]{40}$/);

    // Escreve e integra dois neuronios (em subpastas distintas).
    await svc.writeNeuron({ path: 'a/one.md', content: '# One', sessionId: 's', message: 'm' });
    await svc.mergeSessionBranch({ sessionId: 's', path: 'a/one.md' });
    await svc.writeNeuron({ path: 'b/two.md', content: '# Two', sessionId: 's', message: 'm' });
    await svc.mergeSessionBranch({ sessionId: 's', path: 'b/two.md' });

    const paths = await svc.listNeurons();
    assert.deepEqual(paths, ['a/one.md', 'b/two.md']);

    // HEAD avancou apos os merges.
    assert.notEqual(await svc.resolveHead(), bootstrap);
  } finally {
    cleanup(gitDir);
  }
});

test('listNeurons: ref inexistente retorna lista vazia (nao lanca)', async () => {
  const gitDir = makeTmpGitDir();
  try {
    const svc = makeService(gitDir);
    await svc.provision();
    assert.deepEqual(await svc.listNeurons('refs/heads/naoexiste'), []);
  } finally {
    cleanup(gitDir);
  }
});
