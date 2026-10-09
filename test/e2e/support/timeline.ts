import { projectContainers, serviceOf, type ContainerInspect, type HealthProbe } from './stack.js';
import { delay } from './wait.js';

/** An RFC 3339 timestamp of Docker, nanoseconds included, as nanoseconds since the epoch. */
export function nanos(timestamp: string): bigint {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(
    timestamp,
  );
  if (match === null) throw new Error(`not an RFC 3339 timestamp: ${timestamp}`);
  const seconds = BigInt(Date.parse(`${match[1] ?? ''}${match[3] ?? ''}`)) / 1000n;
  const fraction = (match[2] ?? '').padEnd(9, '0').slice(0, 9);
  return seconds * 1_000_000_000n + BigInt(fraction);
}

/**
 * Reads the project's containers with `docker inspect` every 200 ms while a stack starts, and keeps
 * every health probe it sees. Docker keeps only a container's last five probes, so the probe that
 * first passed, which is when the container became healthy, is gone from a single inspection made
 * once the stack is up (DEP-AC02).
 */
export class StartupTimeline {
  private readonly probes = new Map<string, Map<string, HealthProbe>>();
  private readonly containers = new Map<string, ContainerInspect>();
  private running = false;
  private loop: Promise<void> = Promise.resolve();

  start(): void {
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        await this.poll();
        await delay(200);
      }
    })();
  }

  /** Stops polling, after one last inspection. */
  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
    await this.poll();
  }

  private async poll(): Promise<void> {
    let containers: ContainerInspect[];
    try {
      containers = await projectContainers();
    } catch {
      // A container removed between listing and inspecting: the next poll sees the new state.
      return;
    }
    for (const container of containers) {
      const service = serviceOf(container);
      this.containers.set(service, container);
      const seen = this.probes.get(service) ?? new Map<string, HealthProbe>();
      for (const probe of container.State.Health?.Log ?? []) seen.set(probe.Start, probe);
      this.probes.set(service, seen);
    }
  }

  /** The last inspection of the container of `service`. */
  container(service: string): ContainerInspect {
    const found = this.containers.get(service);
    if (found === undefined) throw new Error(`no container of ${service} was seen`);
    return found;
  }

  /** When `service` became healthy: the end of its first passing health probe. */
  healthyAt(service: string): bigint {
    const passing = [...(this.probes.get(service)?.values() ?? [])]
      .filter((probe) => probe.ExitCode === 0)
      .map((probe) => ({ start: nanos(probe.Start), end: nanos(probe.End) }))
      .sort((left, right) => (left.start < right.start ? -1 : 1));
    const first = passing[0];
    if (first === undefined) throw new Error(`no passing health probe of ${service} was seen`);
    return first.end;
  }

  /** Every probe seen for `service`, in order, for a failure message. */
  probesOf(service: string): HealthProbe[] {
    return [...(this.probes.get(service)?.values() ?? [])].sort((left, right) =>
      nanos(left.Start) < nanos(right.Start) ? -1 : 1,
    );
  }
}
