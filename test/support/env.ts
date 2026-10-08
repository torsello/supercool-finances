/** Reads a variable the integration tests need, naming the fix when it is missing. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set. Run "npm run env:sync" and "npm run infra:up", or export ${name}.`,
    );
  }
  return value;
}
