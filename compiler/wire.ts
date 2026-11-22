// compiler/wire.ts: Tape source generated for nested JSON.
// Records inside records, and lists, in JSON (decode, write_json, and so every message between programs). The host
// decodes one flat object at a time (host.ts json), so for each record type T with a field that is a record or a
// List the compiler writes, as Tape source:
//   type Wire_T               T with each such field as text for a second decode (std/json.tape: WireObject, …)
//   wire_decode_T(json)       decode Wire_T, then each nested field, naming the field in the reason when one fails
//   wire_write_T(out, value)  the object, field by field (types with one constructor and no Option, as write_json)
// and for a list of anything but records, an item type {"value": …} and its decoder. decodeTo and write_json call
// these for such a T. A field is: Int, Bool, View (or a refinement); a record; List[…] of those; Option[…] of any.
import type { Program, TypeAst, Variant } from './ast.ts';

/** What a field is in JSON: a scalar, a record, a list of one of those, or any of them that may be absent. */
export type WireKind =
  | { k: 's'; base: string; t: TypeAst }
  | { k: 'rec'; name: string; t: TypeAst }
  | { k: 'list'; of: WireKind; t: TypeAst }
  | { k: 'opt'; of: WireKind; t: TypeAst };
export type Wire = {
  /** the Tape source written for the nested types */
  text: string;
  /** the record types that have a field that is a record or a list */
  nested: Set<string>;
  kind: (t: TypeAst, inList: boolean, busy: Set<string>) => WireKind | null;
  /** those of `nested` that can also be written */
  writable: Set<string>;
};
// the kind of a field when it is there
const present = (k: WireKind): WireKind => (k.k === 'opt' ? k.of : k);
const stop = (what: string): never => {
  throw new Error(`wire: ${what}`);
};
export function wireSource(prog: Program): Wire {
  const types = prog.types,
    memo = new Map<string, boolean>(),
    text = (t: TypeAst): string => (t.args.length > 0 ? `${t.name}[${t.args.map(text).join(', ')}]` : t.name);
  const base = (n: string): string => {
    let d = types.get(n),
      seen = 0;
    while (d?.refine && seen++ < 20) {
      n = d.refine.base.name;
      d = types.get(n);
    }
    return n;
  };
  const scalar = (n: string): boolean =>
    ['Int', 'Bool', 'View'].includes(base(n)) && (['Int', 'Bool', 'View'].includes(n) || !!types.get(n)?.refine);
  const isList = (t: TypeAst): boolean =>
    t.name === 'List' &&
    t.args.length === 1 &&
    types
      .get('List')
      ?.variants.map(v => v.name)
      .join() === 'Cons,Nil';
  const record = (n: string): boolean => {
    const d = types.get(n);
    return !!d && !d.refine && d.params.length === 0 && d.variants.length > 0 && !['Option', 'Result'].includes(n);
  };
  // a field's kind: { k: 's' | 'rec' | 'list' | 'opt', … } or null when it cannot be JSON
  const kind = (t: TypeAst, inList: boolean, busy: Set<string>): WireKind | null => {
    const [inner] = t.args;
    if (t.args.length === 0 && scalar(t.name)) return { k: 's', base: base(t.name), t };
    if (t.name === 'Option' && inner && t.args.length === 1 && !inList) {
      const of = kind(inner, true, busy);
      return of && of.k !== 'opt' ? { k: 'opt', of, t } : null;
    }
    if (isList(t) && inner) {
      const of = kind(inner, true, busy);
      return of ? { k: 'list', of, t } : null;
    }
    if (t.args.length === 0 && record(t.name) && able(t.name, busy)) return { k: 'rec', name: t.name, t };
    return null;
  };
  const able = (n: string, busy = new Set<string>()): boolean => {
    const known = memo.get(n);
    if (known !== undefined) return known;
    if (busy.has(n)) return false; // a type that contains itself
    busy.add(n);
    const ok = (types.get(n)?.variants ?? []).every(v => v.fields.every(f => kind(f.type, false, busy)));
    busy.delete(n);
    memo.set(n, ok);
    return ok;
  };
  const deep = (k: WireKind | null): boolean =>
    !!k && (k.k === 'rec' || k.k === 'list' || (k.k === 'opt' && deep(k.of)));
  const nested = new Set(
    [...types.keys()].filter(
      n =>
        record(n) &&
        !n.startsWith('Wire_') &&
        // a std type whose name or a constructor's a program's own has moved aside (`std.Malformed`) cannot be
        // named in source; std decodes none of its own types as nested JSON
        ![n, ...(types.get(n)?.variants ?? []).map(v => v.name)].some(x => x.startsWith('std.')) &&
        able(n) &&
        !!types.get(n)?.variants.some(v => v.fields.some(f => deep(kind(f.type, false, new Set())))),
    ),
  );
  // the helpers are std/json.tape's: a build without it has no nested JSON (C09, as before)
  if (nested.size === 0 || !types.has('WireObject') || !prog.fns.has('wire_each') || !prog.fns.has('write_bool'))
    return { text: '', nested: new Set(), kind, writable: new Set() };
  const out: string[] = [],
    items = new Map<string, boolean>(),
    lists = new Map<string, boolean>(),
    maybes = new Map<string, boolean>(),
    mangle = (t: TypeAst): string =>
      text(t)
        .replaceAll(/[^A-Za-z0-9]+/g, '_')
        .replace(/_$/, '');
  const wireType = (k: WireKind): string =>
    k.k === 's'
      ? text(k.t)
      : k.k === 'rec'
        ? 'WireObject'
        : k.k === 'list'
          ? k.of.k === 'rec'
            ? 'WireItems'
            : 'WireValues'
          : `Option[${k.of.k === 's' ? text(k.of.t) : wireType(k.of)}]`;
  const lambda = (k: WireKind, body: string): string => `fn(item: View) -> Result[${text(k.t)}, View] { ${body} }`;
  const dec = (e: string, k: WireKind): string =>
    k.k === 'rec'
      ? nested.has(k.name)
        ? `wire_decode_${k.name}(json: ${e})`
        : `decode(json: ${e}, as: ${k.name})`
      : k.k === 'list'
        ? `wire_each(items: ${e}, by: ${lambda(k.of, k.of.k === 'rec' ? dec('item', k.of) : `${item(k.of)}(json: item)`)})`
        : k.k === 'opt'
          ? `${maybe(k)}(found: ${e})`
          : stop('a scalar is decoded with its record');
  // a key that may be absent: None, or what its value decodes to
  function maybe(k: Extract<WireKind, { k: 'opt' }>): string {
    const m = mangle(k.of.t);
    if (!maybes.has(m)) {
      maybes.set(m, true);
      out.push(
        `fn wire_maybe_${m}(found: ${wireType(k)}) -> Result[${text(k.t)}, View] {\n  match found {\n    Some(value) -> wire_some(decoded: ${dec('value', k.of)})\n    None -> Ok(value: None)\n  }\n}\n`,
      );
    }
    return `wire_maybe_${m}`;
  }
  // an element that is not a record arrives as {"value": …}
  function item(k: WireKind): string {
    const m = mangle(k.t);
    if (!items.has(m)) {
      items.set(m, true);
      out.push(
        `type Wire_item_${m} {\n  Wire_item_${m}(value: ${wireType(k)})\n}\n`,
        `fn wire_item_${m}(json: View) -> Result[${text(k.t)}, View] {\n  match decode(json, as: Wire_item_${m}) {\n    Ok(value: Wire_item_${m}(value)) -> ${k.k === 's' ? 'Ok(value)' : dec('value', k)}\n    Err(error) -> Err(error: wire_plain(error))\n  }\n}\n`,
      );
    }
    return `wire_item_${m}`;
  }
  const write = (o: string, e: string, k: WireKind): string =>
    k.k === 's'
      ? k.base === 'Int'
        ? `write_int(out: ${o}, value: ${e})`
        : k.base === 'Bool'
          ? `write_bool(out: ${o}, value: ${e})`
          : `write_json_string(out: ${o}, text: ${e})`
      : k.k === 'rec'
        ? nested.has(k.name)
          ? `wire_write_${k.name}(out: ${o}, value: ${e})`
          : `write_json(out: ${o}, value: ${e})`
        : k.k === 'list'
          ? `${list(k.of)}(out: ${o}, list: ${e})`
          : stop('a field that may be absent is not written');
  function list(k: WireKind): string {
    const m = mangle(k.t),
      lt = `List[${text(k.t)}]`;
    if (!lists.has(m)) {
      lists.set(m, true);
      out.push(
        `fn wire_write_list_${m}(out: Buf, list: ${lt}) -> Buf {\n  wire_write_rest_${m}(out: push(buf: out, byte: 91), list, first: True)\n}\n`,
        `fn wire_write_rest_${m}(out: Buf, list: ${lt}, first: Bool) -> Buf {\n  match list {\n    Cons(head, tail) if first -> wire_write_rest_${m}(out: ${write('out', 'head', k)}, list: tail, first: False)\n    Cons(head, tail) -> wire_write_rest_${m}(out: ${write('push(buf: out, byte: 44)', 'head', k)}, list: tail, first: False)\n    Nil -> push(buf: out, byte: 93)\n  }\n}\n`,
      );
    }
    return `wire_write_list_${m}`;
  }
  const writable = new Set<string>();
  const canWrite = (n: string, busy = new Set<string>()): boolean => {
    const only = types.get(n)?.variants.length === 1 ? types.get(n)?.variants[0] : undefined;
    if (busy.has(n) || !only) return false;
    busy.add(n);
    const ok = only.fields.every(f => {
      const go = (k: WireKind | null): boolean =>
        !!k && (k.k === 's' || (k.k === 'rec' && canWrite(k.name, busy)) || (k.k === 'list' && go(k.of)));
      return go(kind(f.type, false, new Set()));
    });
    busy.delete(n);
    return ok;
  };
  for (const n of nested) {
    const d = types.get(n) ?? stop(`no type ${n}`),
      // the kind of a constructor's i-th field: every field of a nested type has one
      kinds = (v: Variant): ((i: number) => WireKind) => {
        const all = v.fields.map(f => kind(f.type, false, new Set()));
        return i => all[i] ?? stop(`${v.name} has no field ${i} that can be JSON`);
      };
    out.push(
      `type Wire_${n} {\n${d.variants.map(v => `  Wire_${v.name}${v.fields.length > 0 ? `(${v.fields.map((f, i) => `${f.name}: ${wireType(kinds(v)(i))}`).join(', ')})` : ''}`).join('\n')}\n}\n`,
      `fn wire_decode_${n}(json: View) -> Result[${n}, View] {\n  match decode(json, as: Wire_${n}) {\n${d.variants.map(v => `    Ok(value: Wire_${v.name}${v.fields.length > 0 ? `(${v.fields.map(f => f.name).join(', ')})` : ''}) -> wire_build_${v.name}(${v.fields.map(f => f.name).join(', ')})`).join('\n')}\n    Err(error) -> Err(error)\n  }\n}\n`,
    );
    for (const v of d.variants) {
      const ks = kinds(v),
        steps = v.fields
          .map((f, i) =>
            deep(ks(i))
              ? `  let Ok(value: wire_${f.name}) = ${dec(f.name, ks(i))} else {\n    Err(error) -> Err(error: "${f.name}${present(ks(i)).k === 'list' ? '' : ': '}" ++ error)\n  }\n`
              : '',
          )
          .join('');
      out.push(
        `fn wire_build_${v.name}(${v.fields.map((f, i) => `${f.name}: ${wireType(ks(i))}`).join(', ')}) -> Result[${n}, View] {\n${steps}  Ok(value: ${v.name}${v.fields.length > 0 ? `(${v.fields.map((f, i) => (deep(ks(i)) ? `${f.name}: wire_${f.name}` : f.name)).join(', ')})` : ''})\n}\n`,
      );
    }
    if (canWrite(n)) {
      writable.add(n);
      const v = d.variants[0] ?? stop(`${n} has no constructor`),
        ks = kinds(v);
      let acc = 'out';
      v.fields.forEach((f, i) => {
        acc = write(`append(buf: ${acc}, view: "${i ? ',' : '{'}\\"${f.name}\\":")`, f.name, ks(i));
      });
      out.push(
        `fn wire_write_${n}(out: Buf, value: ${n}) -> Buf {\n${v.fields.length > 0 ? `  let ${v.name}(${v.fields.map(f => f.name).join(', ')}) = value\n  append(buf: ${acc}, view: "}")` : '  append(buf: out, view: "{}")'}\n}\n`,
      );
    }
  }
  return { text: out.join('\n'), nested, kind, writable };
}
