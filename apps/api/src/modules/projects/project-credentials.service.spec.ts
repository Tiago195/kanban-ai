import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectCredentialsService } from './project-credentials.service';
import type { AppConfig } from '../../shared/config/config';

/**
 * US-PROJ3 — resolução de credenciais git por Project.
 *   (a) https: token vem de uma ENV VAR referenciada por credentialRef (nunca
 *       o literal do banco); onAuth devolve { username, password: <token da env> }.
 *   (b) env var ausente → erro LEGÍVEL (cita só o NOME da env var, nunca o valor,
 *       e não revela se outras env vars existem).
 *   (c) authKind='none' → sem auth (null).
 *   (d) ssh desabilitado por default → erro claro; habilitado → ok.
 *   (e) redaction: nenhuma mensagem de erro contém o valor do segredo.
 */

function makeConfig(allowSsh: boolean): AppConfig {
  return {
    projects: { dir: '/tmp/x', gitTimeoutMs: 300_000, allowSsh },
  } as unknown as AppConfig;
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('https: resolve token da ENV var referenciada (não o literal do banco)', () => {
  const svc = new ProjectCredentialsService(makeConfig(false));
  const secret = 'ghp_super_secret_value_123';
  withEnv({ GH_TOKEN_ACME: secret }, () => {
    const auth = svc.resolveHttpAuth({ authKind: 'https', credentialRef: 'GH_TOKEN_ACME' });
    assert.ok(auth, 'deve resolver auth para https');
    assert.equal(auth!.password, secret, 'password deve vir da env var');
    // O credentialRef NÃO é o segredo — é só o nome da env var.
    assert.notEqual(auth!.password, 'GH_TOKEN_ACME');
    assert.ok(auth!.username.length > 0, 'username default deve estar presente');
  });
});

test('https: tolera prefixo opcional "env:" no credentialRef', () => {
  const svc = new ProjectCredentialsService(makeConfig(false));
  withEnv({ GH_TOKEN_X: 'tok_x' }, () => {
    const auth = svc.resolveHttpAuth({ authKind: 'https', credentialRef: 'env:GH_TOKEN_X' });
    assert.equal(auth!.password, 'tok_x');
  });
});

test('https: env var ausente → erro legível citando só o NOME (sem vazar valor/outras vars)', () => {
  const svc = new ProjectCredentialsService(makeConfig(false));
  withEnv({ GH_TOKEN_MISSING: undefined, GH_TOKEN_OTHER: 'should_not_leak' }, () => {
    try {
      svc.resolveHttpAuth({ authKind: 'https', credentialRef: 'GH_TOKEN_MISSING' });
      assert.fail('deveria ter lançado');
    } catch (err) {
      const msg = (err as Error).message;
      assert.match(msg, /GH_TOKEN_MISSING/, 'menciona o nome da env var ausente');
      assert.doesNotMatch(msg, /should_not_leak/, 'NÃO vaza valor de outra env var');
      assert.doesNotMatch(msg, /GH_TOKEN_OTHER/, 'NÃO revela existência de outras env vars');
    }
  });
});

test('https: credentialRef ausente/vazio → erro de configuração legível', () => {
  const svc = new ProjectCredentialsService(makeConfig(false));
  assert.throws(
    () => svc.resolveHttpAuth({ authKind: 'https', credentialRef: null }),
    /credentialRef/,
  );
  assert.throws(
    () => svc.resolveHttpAuth({ authKind: 'https', credentialRef: '   ' }),
    /credentialRef/,
  );
});

test('none: sem auth (retorna null)', () => {
  const svc = new ProjectCredentialsService(makeConfig(false));
  assert.equal(svc.resolveHttpAuth({ authKind: 'none', credentialRef: null }), null);
  assert.equal(svc.buildHttpAuthHook({ authKind: 'none', credentialRef: null }), null);
});

test('buildHttpAuthHook: devolve callback que resolve o token no handshake', () => {
  const svc = new ProjectCredentialsService(makeConfig(false));
  withEnv({ GH_TOKEN_HOOK: 'tok_hook' }, () => {
    const hook = svc.buildHttpAuthHook({ authKind: 'https', credentialRef: 'GH_TOKEN_HOOK' });
    assert.ok(hook, 'deve construir um hook para https');
    const out = hook!();
    assert.equal(out.password, 'tok_hook');
  });
});

test('ssh: desabilitado por default → erro claro mencionando PROJECTS_ALLOW_SSH', () => {
  const svc = new ProjectCredentialsService(makeConfig(false));
  assert.throws(
    () => svc.assertSshAllowed({ authKind: 'ssh', credentialRef: null }),
    /PROJECTS_ALLOW_SSH=true/,
  );
});

test('ssh: habilitado (PROJECTS_ALLOW_SSH=true) → não lança', () => {
  const svc = new ProjectCredentialsService(makeConfig(true));
  assert.doesNotThrow(() => svc.assertSshAllowed({ authKind: 'ssh', credentialRef: null }));
  // assertSshAllowed é no-op para não-ssh.
  assert.doesNotThrow(() => svc.assertSshAllowed({ authKind: 'none', credentialRef: null }));
});

test('redaction: NENHUMA mensagem de erro deste serviço contém o valor do segredo', () => {
  const svc = new ProjectCredentialsService(makeConfig(false));
  const secret = 'SECRET_TOKEN_VALUE_DO_NOT_LEAK';
  withEnv({ GH_TOKEN_REDACT: secret }, () => {
    // Caminho de sucesso não deve lançar; forçamos um caminho de erro adjacente
    // (ref vazia) e garantimos que o segredo não aparece.
    try {
      svc.resolveHttpAuth({ authKind: 'https', credentialRef: '' });
      assert.fail('deveria lançar');
    } catch (err) {
      assert.doesNotMatch((err as Error).message, new RegExp(secret));
    }
  });
});
