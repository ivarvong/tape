// rules/driver.ts: rules(prog), which runs every rule over a parsed program and returns what it refuses.
import type { Program } from '../compiler/ast.ts';
import type { Problem } from '../compiler/common.ts';
import { inNames } from '../compiler/sqltext.ts';
import { commandRules } from './commands.ts';
import { declaredRules } from './declared.ts';
import { finalRules } from './final.ts';
import { floorRules } from './floors.ts';
import { guardRules } from './guards.ts';
import { machineRules } from './machines.ts';
import { queriesOf, sqlModel, tablesOf } from './model.ts';
import { replayRules } from './replay.ts';
import type { Reading } from './types.ts';

/** The names of a query's placeholders, when the place a problem is at is the query's call. */
const namesAt = (at: object | null | undefined): readonly string[] | null => {
  const params: unknown = at && 'params' in at ? at.params : null;
  return Array.isArray(params) ? params.filter(p => typeof p === 'string') : null;
};

/** Every problem the rules find, in the order of the files and lines they are in. */
export function rules(prog: Program): Problem[] {
  const problems: Problem[] = [];
  const reading: Reading = {
    prog,
    ...queriesOf(prog),
    tables: tablesOf(prog),
    model: sqlModel(prog),
    // a rule reads the numbered statement; where it is said of a query's call, it is said in the call's names
    bad: (code, at, message, hint) => {
      const names = namesAt(at);
      problems.push({
        code,
        file: at?.file ?? '',
        line: at?.line ?? 0,
        message: inNames(message, names),
        hint: inNames(hint, names),
      });
    },
  };
  declaredRules(reading); // C51-C53, C63, C66-C68
  machineRules(prog, reading.bad); // C57-C62, C70, C77-C79
  finalRules(prog, reading.calls, reading.bad); // C80
  replayRules(reading); // C54-C56
  commandRules(reading); // C71, C81, C87
  floorRules(reading); // C73
  guardRules(reading); // C74
  return problems.toSorted((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.code.localeCompare(b.code));
}
