import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BOOTSTRAP_GRANT,
  BOOTSTRAP_ROLES,
  scramSha256Verifier,
} from '../../../src/platform/db/bootstrap-roles.js';
import { readRepositoryFile } from '../../support/deployment.js';

/** The attributes only the local init script gives, and why: section 1.7 of spec 008. */
const LOCAL_ONLY_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  // The tests create scratch databases; nothing in AWS does.
  scf_owner: ['CREATEDB'],
};

interface InitRole {
  name: string;
  attributes: string[];
}

/** The init script without its comments, one statement per element. */
function statementsOf(sql: string): string[] {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, '').trim())
    .join(' ')
    .split(';')
    .map((statement) => statement.replace(/\s+/g, ' ').trim())
    .filter((statement) => statement !== '');
}

function initRoles(statements: readonly string[]): InitRole[] {
  return statements
    .map((statement) =>
      /^CREATE ROLE (\w+)(?: WITH)? (.*?)(?: PASSWORD '[^']*')?$/i.exec(statement),
    )
    .filter((match) => match !== null)
    .map((match) => ({
      name: match[1] ?? '',
      attributes: (match[2] ?? '').split(' ').filter((word) => word !== ''),
    }));
}

function initGrants(statements: readonly string[]): string[] {
  return statements.filter((statement) => /^GRANT \w+ TO \w+/i.test(statement));
}

describe('the bootstrap roles', () => {
  it('DEP-AC30 the roles, attributes and grant the bootstrap applies match docker/postgres/init/01-databases.sql, except the local-only CREATEDB', () => {
    const statements = statementsOf(readRepositoryFile('docker/postgres/init/01-databases.sql'));
    const local = initRoles(statements);
    const declared = [BOOTSTRAP_ROLES.owner, BOOTSTRAP_ROLES.runtime];

    expect(local.map((role) => role.name).sort()).toEqual(['scf_app', 'scf_owner']);
    expect(declared.map((role) => role.name).sort()).toEqual(['scf_app', 'scf_owner']);
    for (const role of declared) {
      const localRole = local.find((candidate) => candidate.name === role.name);
      const localOnly = LOCAL_ONLY_ATTRIBUTES[role.name] ?? [];
      expect(localRole, role.name).toBeDefined();
      for (const attribute of localOnly) expect(localRole?.attributes).toContain(attribute);
      expect(
        localRole?.attributes.filter((attribute) => !localOnly.includes(attribute)).sort(),
        role.name,
      ).toEqual([...role.attributes].sort());
    }

    expect(initGrants(statements)).toEqual([
      `GRANT ${BOOTSTRAP_GRANT.role} TO ${BOOTSTRAP_GRANT.member} WITH ADMIN ${String(BOOTSTRAP_GRANT.admin).toUpperCase()}, INHERIT ${String(BOOTSTRAP_GRANT.inherit).toUpperCase()}, SET ${String(BOOTSTRAP_GRANT.set).toUpperCase()}`,
    ]);
    expect(BOOTSTRAP_GRANT).toEqual({
      role: 'scf_app',
      member: 'scf_owner',
      admin: true,
      inherit: false,
      set: false,
    });
  });

  it('DEP-R38 the verifier matches the known answer of the RFC 7677 example, and its keys produce that exchange', () => {
    // RFC 7677 section 3: user "user", password "pencil", salt W22ZaJ0SNY7soEsUEjb6gQ==, 4096
    // iterations. The expected verifier was computed outside this code, with Python's hashlib, and
    // checked against the example's client proof and server signature below.
    const salt = Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64');
    const verifier = scramSha256Verifier('pencil', salt);
    expect(verifier).toBe(
      'SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=:wfPLwcE6nTWhTAmQ7tl2KeoiWGPlZqQxSrmfPwDl2dU=',
    );

    // The exchange of the RFC: the server key signs the auth message into the server signature,
    // and the client proof, unmasked with the stored key's signature, hashes to the stored key.
    const [storedKey = '', serverKey = ''] = verifier.split('$')[2]?.split(':') ?? [];
    const authMessage =
      'n=user,r=rOprNGfwEbeRWgbNEkqO,' +
      'r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,' +
      'c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0';
    const serverSignature = createHmac('sha256', Buffer.from(serverKey, 'base64'))
      .update(authMessage)
      .digest('base64');
    expect(serverSignature).toBe('6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=');
    const clientSignature = createHmac('sha256', Buffer.from(storedKey, 'base64'))
      .update(authMessage)
      .digest();
    const proof = Buffer.from('dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=', 'base64');
    const clientKey = Buffer.from(proof.map((byte, index) => byte ^ (clientSignature[index] ?? 0)));
    expect(createHash('sha256').update(clientKey).digest('base64')).toBe(storedKey);

    expect(verifier).not.toContain('pencil');
    expect(scramSha256Verifier('pencil')).not.toBe(scramSha256Verifier('pencil'));
  });
});
