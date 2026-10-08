import { BlockList, isIPv4, isIPv6 } from 'node:net';

/** The prefix of an IPv4 address written as IPv6, as a dual-stack socket reports a peer. */
const IPV4_MAPPED = '::ffff:';

/**
 * Fastify's `trustProxy` for `TRUSTED_PROXY_CIDRS` (SEC-R18): `false` when it is empty, so the
 * client address is always the TCP peer's; otherwise a function that trusts an address inside
 * one of the blocks. Fastify walks `X-Forwarded-For` from the TCP peer leftwards while each
 * address is trusted, so the client address is the rightmost address that is not, or the peer's
 * own when it is not trusted. The blocks are already validated by the configuration loader.
 */
export function trustProxy(cidrs: readonly string[]): false | ((address: string) => boolean) {
  if (cidrs.length === 0) return false;
  const blocks = new BlockList();
  for (const cidr of cidrs) {
    const [address = '', prefix = ''] = cidr.split('/');
    blocks.addSubnet(address, Number(prefix), isIPv4(address) ? 'ipv4' : 'ipv6');
  }
  return (address) => {
    const mapped = address.toLowerCase().startsWith(IPV4_MAPPED)
      ? address.slice(IPV4_MAPPED.length)
      : undefined;
    if (mapped !== undefined && isIPv4(mapped)) return blocks.check(mapped, 'ipv4');
    if (isIPv4(address)) return blocks.check(address, 'ipv4');
    return isIPv6(address) && blocks.check(address, 'ipv6');
  };
}
