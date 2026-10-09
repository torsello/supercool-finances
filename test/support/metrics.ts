/** One sample of the Prometheus text format: a metric name, its labels and its value. */
export interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

const SAMPLE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})? (\S+)$/;
const LABEL = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

/** The samples of a scrape in the Prometheus text format, comments skipped. */
export function parseMetrics(text: string): Sample[] {
  return text
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      const match = SAMPLE.exec(line);
      if (match === null) throw new Error(`not a sample: ${line}`);
      const labels = Object.fromEntries(
        [...(match[2] ?? '').matchAll(LABEL)].map(([, name = '', value = '']) => [name, value]),
      );
      return { name: match[1] ?? '', labels, value: Number(match[3]) };
    });
}

/** Fetches `/metrics` from the metrics server on `port`. */
export async function scrape(port: number): Promise<Sample[]> {
  const response = await fetch(`http://127.0.0.1:${String(port)}/metrics`);
  if (response.status !== 200) throw new Error(`/metrics answered ${String(response.status)}`);
  return parseMetrics(await response.text());
}

/** The value of the sample of `name` whose labels include `labels`; 0 when there is none. */
export function valueOf(
  samples: readonly Sample[],
  name: string,
  labels: Record<string, string> = {},
): number {
  return samples
    .filter(
      (sample) =>
        sample.name === name &&
        Object.entries(labels).every(([label, value]) => sample.labels[label] === value),
    )
    .reduce((sum, sample) => sum + sample.value, 0);
}
