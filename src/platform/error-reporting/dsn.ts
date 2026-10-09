/**
 * A Sentry DSN, `https://<public key>@<host>[:<port>]/<project id>`, as section 1.2 of spec 007
 * accepts it: a non-empty public key, no password, a project id of decimal digits, no query or
 * fragment, and `http://` only for a loopback host, such as the tests' fake endpoint.
 */
export interface SentryDsn {
  /** Where envelopes are posted: `<scheme>://<host>/api/<project id>/envelope/`. */
  envelopeUrl: string;
  publicKey: string;
}

/** The hosts an `http://` DSN may name: the loopback addresses only. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '[::1]', 'localhost']);

const PROJECT_PATH = /^\/([0-9]+)$/;

/** The rule a configuration error names for `SENTRY_DSN`, without its value (SEC-R40). */
export const SENTRY_DSN_RULE =
  'unset or empty, or a DSN https://<public key>@<host>[:<port>]/<project id> with a project id of decimal digits, no password, query or fragment; http:// only for 127.0.0.1, [::1] or localhost';

/**
 * Whether `value` holds a query, a fragment or a password that the URL parser reads as `''`
 * because it is empty, as in `.../42?`, `.../42#` or `https://pk:@host/42`: a raw `?` or `#`
 * anywhere, or a `:` in the user part before the host.
 */
function hasEmptyPart(value: string): boolean {
  if (value.includes('?') || value.includes('#')) return true;
  const authority = value.slice(value.indexOf('//') + 2).split(/[/\\]/)[0] ?? '';
  const at = authority.lastIndexOf('@');
  return at >= 0 && authority.slice(0, at).includes(':');
}

/** The parsed DSN, or `undefined` when `value` breaks the rule of section 1.2 of spec 007. */
export function parseSentryDsn(value: string): SentryDsn | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const secure = url.protocol === 'https:';
  const loopback = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  const project = PROJECT_PATH.exec(url.pathname)?.[1];
  if (
    (!secure && !loopback) ||
    url.username === '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    hasEmptyPart(value) ||
    project === undefined
  ) {
    return undefined;
  }
  return {
    envelopeUrl: `${url.protocol}//${url.host}/api/${project}/envelope/`,
    publicKey: decodeURIComponent(url.username),
  };
}
