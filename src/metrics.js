'use strict';

function labelKey(labels) {
  const keys = Object.keys(labels).sort();
  if (!keys.length) return '';
  const escape = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  return `{${keys.map((k) => `${k}="${escape(labels[k])}"`).join(',')}}`;
}

/** Tiny Prometheus-compatible registry (counters + computed gauges). */
class Metrics {
  constructor() {
    this.counters = new Map(); // name -> { help, values: Map<labelKey, number> }
    this.gauges = new Map(); // name -> { help, collect: () => number | Array<[labels, number]> }
  }

  counter(name, help) {
    if (!this.counters.has(name)) this.counters.set(name, { help, values: new Map() });
    return this;
  }

  inc(name, labels = {}, value = 1) {
    if (!this.counters.has(name)) this.counter(name, name);
    const series = this.counters.get(name).values;
    const key = labelKey(labels);
    series.set(key, (series.get(key) || 0) + value);
  }

  gauge(name, help, collect) {
    this.gauges.set(name, { help, collect });
    return this;
  }

  value(name, labels = {}) {
    const counter = this.counters.get(name);
    return counter ? counter.values.get(labelKey(labels)) || 0 : 0;
  }

  render() {
    const lines = [];
    for (const [name, { help, values }] of this.counters) {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`);
      for (const [key, value] of values) lines.push(`${name}${key} ${value}`);
    }
    for (const [name, { help, collect }] of this.gauges) {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
      const result = collect();
      if (Array.isArray(result)) {
        for (const [labels, value] of result) lines.push(`${name}${labelKey(labels)} ${value}`);
      } else {
        lines.push(`${name} ${result}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }
}

module.exports = { Metrics };
