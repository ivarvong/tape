// sim/dictionary.ts: words a request can use so that it names something that exists: the text values the
// programs' own INSERTs seed their tables with, by column name. A request for a card that is not there only ever
// tests the 404.
import { storedText } from '../compiler/fieldless.ts';
const CONSTRAINT = /^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)$/i;
const CREATE_TABLE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(((?:[^()]|\([^()]*\))*)\)/gi;
const INSERT_VALUES = /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(\w+)\s*(?:\(([^)]*)\)\s*)?VALUES\s*((?:\([^()]*\)\s*,?\s*)+)/gi;

// the columns of each table, in the order CREATE TABLE gives them
function columnsOf(texts: readonly string[]): Record<string, string[]> {
  const columns: Record<string, string[]> = {};
  for (const source of texts)
    for (const [, table = '', body = ''] of source.matchAll(CREATE_TABLE))
      columns[table] = body
        .split(/,(?![^()]*\))/)
        .map(column => column.trim().split(/\s+/)[0] ?? '')
        .filter(name => name !== '' && !CONSTRAINT.test(name));
  return columns;
}

// { column: [text, …], '*': [every text] }. A value in a table's first column also goes under the table's name,
// with and without its last s: a request names a row by what it is (a `section`, a `card`) more often than by the
// column it is kept in (`name`).
export type Dictionary = Record<string, string[]>;
export function dictionaryOf(texts: readonly string[]): Dictionary {
  const dict: Dictionary = { '*': [] },
    columns = columnsOf(texts);
  const put = (key: string, word: string): void => {
    if (!key) return;
    const words = (dict[key] ??= []);
    if (!words.includes(word)) words.push(word);
  };
  for (const source of texts)
    for (const [, table = '', listed, rows = ''] of source.matchAll(INSERT_VALUES)) {
      const named = listed ? listed.split(',').map(c => c.trim()) : (columns[table] ?? []);
      const first = (columns[table] ?? named)[0];
      for (const [, row = ''] of rows.matchAll(/\(([^()]*)\)/g)) {
        const values = row.match(/'(?:[^']|'')*'|[^,]+/g) ?? [];
        values.forEach((value, i) => {
          const word = /^\s*'(.*)'\s*$/s.exec(value)?.[1];
          const column = named[i];
          if (word === undefined || !column || word.length > 40) return;
          put(column, word);
          if (column === first) {
            put(table, word);
            put(table.replace(/s$/, ''), word);
          }
          put('*', word);
        });
      }
    }
  // the states a machine declares (the texts of its constructors), under its column's name: a request that asks for a state (`{"state": "outage"}`)
  // names one the program knows
  for (const source of texts)
    for (const [, , column = '', moves = ''] of source.matchAll(MACHINE))
      for (const [, ctor = ''] of moves.matchAll(/\b([A-Z]\w*)\b/g)) put(column, storedText(ctor));
  return dict;
}
const MACHINE = /^machine\s+(\w+)\.(\w+)\s*:\s*\w+\s*\{([^}]*)\}/gm;
