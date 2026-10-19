// Execution schedule for READY cases: dependency levels, isolation (parallel vs serial) and worker
// budget. Setup of dependent cases is inlined by the planner, so levels order the work and explain
// failures (a broken producer explains failing dependents) rather than gate execution.

import type { ProjectConfig } from '../config/project-config.schema.ts';
import { findCycles, runnableCases } from '../planning/planner.ts';
import type { TestPlan } from '../planning/schema.ts';
import { analyzeIsolation, type Isolation } from './isolation.ts';

export interface ScheduledCase {
  id: string;
  level: number;
  dependsOn: string[];
  isolation: Isolation;
  reasons: string[];
}

export interface Schedule {
  schemaVersion: 1;
  cases: ScheduledCase[];
  levels: string[][];
  parallel: string[];
  serial: string[];
  workers: { parallel: number; serial: 1 };
  rationale: string[];
}

export class ScheduleError extends Error {
  override name = 'ScheduleError';
}

/**
 * Parallel workers: the configured `workers.max`, capped at 2 until a project proves more
 * (roadmap P5-T04), and only for cases whose data is isolated. Everything else runs with 1 worker.
 */
export function buildSchedule(plan: Pick<TestPlan, 'cases'>, config: ProjectConfig): Schedule {
  const ready = runnableCases(plan);
  const ids = new Set(ready.map((c) => c.id));
  const deps = new Map(ready.map((c) => [c.id, c.dependencies.filter((d) => ids.has(d))]));
  const cycles = findCycles(deps);
  if (cycles.length)
    throw new ScheduleError(
      `dependency cycle among READY cases: ${cycles.map((c) => c.join(' -> ')).join('; ')}`,
    );

  const level = new Map<string, number>();
  const levelOf = (id: string): number => {
    const known = level.get(id);
    if (known !== undefined) return known;
    const l = Math.max(-1, ...(deps.get(id) ?? []).map(levelOf)) + 1;
    level.set(id, l);
    return l;
  };
  const cases: ScheduledCase[] = ready
    .map((c) => {
      const v = analyzeIsolation(c);
      return {
        id: c.id,
        level: levelOf(c.id),
        dependsOn: deps.get(c.id) ?? [],
        isolation: v.isolation,
        reasons: v.reasons,
      };
    })
    .sort((a, b) => a.level - b.level || a.id.localeCompare(b.id));
  const levels: string[][] = [];
  for (const c of cases) (levels[c.level] ??= []).push(c.id);

  const parallel = cases.filter((c) => c.isolation === 'isolated').map((c) => c.id);
  const serial = cases.filter((c) => c.isolation === 'serial').map((c) => c.id);
  const parallelWorkers = parallel.length > 1 ? Math.min(config.workers.max, 2) : 1;
  const rationale = [
    `${parallel.length} isolated case(s) may run in parallel with ${parallelWorkers} worker(s) (workers.max=${config.workers.max}, capped at 2)`,
    `${serial.length} case(s) touch shared state and run afterwards with 1 worker`,
    ...cases.filter((c) => c.isolation === 'serial').map((c) => `${c.id}: ${c.reasons.join('; ')}`),
  ];
  return {
    schemaVersion: 1,
    cases,
    levels,
    parallel,
    serial,
    workers: { parallel: parallelWorkers, serial: 1 },
    rationale,
  };
}
