import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copyBuildAssets } from '../../../scripts/copy-build-assets.js';
import { REPOSITORY_ROOT, readRepositoryFile } from '../../support/deployment.js';

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

describe('build assets', () => {
  const folders: string[] = [];

  function outputFolder(): string {
    const folder = mkdtempSync(join(tmpdir(), 'scf-build-assets-'));
    folders.push(folder);
    return folder;
  }

  afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  it('DEP-AC29 the build ships the RDS CA bundle, byte for byte, with a valid Amazon RDS certificate', () => {
    const out = outputFolder();
    copyBuildAssets({ root: REPOSITORY_ROOT, outDir: out });

    const committed = readFileSync(join(REPOSITORY_ROOT, 'certs', 'rds-global-bundle.pem'));
    const shipped = readFileSync(join(out, 'certs', 'rds-global-bundle.pem'));
    expect(shipped.equals(committed)).toBe(true);

    const blocks = committed.toString('utf8').match(PEM_BLOCK) ?? [];
    expect(blocks.length).toBeGreaterThan(0);
    const certificates = blocks.map((block) => new X509Certificate(block));
    const now = Date.now();
    const validRds = certificates.filter(
      (certificate) =>
        /\bOU=Amazon RDS\b/.test(certificate.subject) &&
        /\bO=Amazon Web Services/.test(certificate.issuer) &&
        Date.parse(certificate.validFrom) <= now &&
        now < Date.parse(certificate.validTo),
    );
    expect(validRds.length).toBeGreaterThan(0);
  });

  it('DEP-R41 the build still copies every migration, and only those, into dist/migrations', () => {
    const out = outputFolder();
    copyBuildAssets({ root: REPOSITORY_ROOT, outDir: out });

    const sources = readdirSync(join(REPOSITORY_ROOT, 'migrations'))
      .filter((name) => name.endsWith('.sql'))
      .sort();
    expect(readdirSync(join(out, 'migrations')).sort()).toEqual(sources);
    for (const name of sources) {
      expect(readFileSync(join(out, 'migrations', name), 'utf8')).toBe(
        readRepositoryFile(`migrations/${name}`),
      );
    }
  });
});
