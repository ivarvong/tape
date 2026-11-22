// seeds.ts: the seeds a run is asked for.
/** The seeds in "1,2,5-8". */
export const seedsIn = (spec: string): number[] =>
  spec
    .split(',')
    .filter(part => part.length > 0)
    .flatMap(part => {
      const [from = 0, to = from] = part.split('-').map(Number);
      return Array.from({ length: to - from + 1 }, (_, i) => from + i);
    });
