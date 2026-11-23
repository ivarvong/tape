// compiler/wire.ts: Tape source generated for JSON. For every record type T a program can decode, a decoder:
//   json_decode_T(json)     the bytes read once into a tree (std/json.tape json_tree), then json_as_T
//   json_as_T(obj)          the first constructor whose keys and kinds fit the object (or why not, from the one that
//                           got furthest), its refined fields checked in order, then its records and lists decoded,
//                           each reason with the path to it
// and for a record type with a field that is a record or a List (`nested`):
//   wire_write_T(out, value)  the object, field by field (types with one constructor and no Option, as write_json)
// decode calls json_decode_T. A field is: Int, Bool, View (or a refinement); a record; List[…] of those; Option[…] of
// any. What decode accepts and the reasons it gives are those of the host's decode before it (JSON.parse, then the
// shape), with numbers read exactly (std/json.tape json_int). The code calls std's functions by their qualified names
// (json.json_get, text.write_int, json.json_append for append) and names only std types a program cannot define
// (shadow.ts CORE), so a program's own max, push or List does not take their place.
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
  /** the record types that have a decoder (json_decode_T) */
  decodable: Set<string>;
};
// the kind of a field when it is there
const present = (k: WireKind): WireKind => (k.k === 'opt' ? k.of : k);
// the variable generated code holds a field in: a field may be named by a reserved word (`type`), a variable not
const vr = (field: string): string => `w_${field}`;
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
    ['Int', 'Float', 'Bool', 'View'].includes(base(n)) &&
    (['Int', 'Float', 'Bool', 'View'].includes(n) || !!types.get(n)?.refine);
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
  const decodable = new Set(
    [...types.keys()].filter(
      n =>
        record(n) &&
        ![n, ...(types.get(n)?.variants ?? []).map(v => v.name)].some(x => x.startsWith('std.')) &&
        able(n),
    ),
  );
  // the helpers are std/json.tape's: a build without it decodes nothing (decode says so)
  if (!prog.fns.has('json_tree') || !prog.fns.has('write_bool'))
    return { text: '', nested: new Set(), decodable: new Set(), kind, writable: new Set() };
  const out: string[] = [],
    lists = new Map<string, boolean>(),
    helpers = new Set<string>(),
    mangle = (t: TypeAst): string =>
      text(t)
        .replaceAll(/[^A-Za-z0-9]+/g, '_')
        .replace(/_$/, '');
  const once = (name: string, src: () => string): string => {
    if (!helpers.has(name)) {
      helpers.add(name);
      out.push(src());
    }
    return name;
  };
  // what json_check is told a kind is: 0 text, 1 true or false, 2 a whole number, 3 an object, 4 an array
  const code = (k: WireKind): number =>
    k.k === 's'
      ? k.base === 'View'
        ? 0
        : k.base === 'Bool'
          ? 1
          : 2
      : k.k === 'rec'
        ? 3
        : k.k === 'list'
          ? 4
          : code(k.of);
  const refined = (t: TypeAst): boolean => !!types.get(t.name)?.refine;
  const scalarOf = (of: string, found: string): string =>
    of === 'View'
      ? `json.json_text_of(found: ${found})`
      : of === 'Bool'
        ? `json.json_bool_of(found: ${found})`
        : `json.json_int_of(found: ${found})`;
  const maybeOf = (of: string, found: string): string =>
    of === 'View'
      ? `json.json_maybe_text(found: ${found})`
      : of === 'Bool'
        ? `json.json_maybe_bool(found: ${found})`
        : `json.json_maybe_int(found: ${found})`;
  // Option[R] of a refined R, from Option[its base]: None when the value there is not an R
  const maybeRefined = (t: TypeAst, of: string): string =>
    once(
      `json_maybe_${mangle(t)}`,
      () =>
        `fn json_maybe_${mangle(t)}(found: Option[${of}]) -> Option[Option[${text(t)}]] {\n  match found {\n    Some(value: ${t.name}(x)) -> Some(value: Some(value: x))\n    None -> Some(value: None)\n    _ -> None\n  }\n}\n`,
    );
  // a scalar element's value, its refinement checked
  function itemValue(k: Extract<WireKind, { k: 's' }>): string {
    const m = mangle(k.t);
    return once(`json_value_${m}`, () => {
      const got = scalarOf(k.base, 'Some(value: item)');
      const body = refined(k.t)
        ? `  let ${k.t.name}(x) = ${got} else -> Err(error: "not a valid ${k.t.name}")\n  Ok(value: x)\n`
        : `  Ok(value: ${got})\n`;
      return `fn json_value_${m}(item: Json_Tree) -> Result[${text(k.t)}, View] {\n${body}}\n`;
    });
  }
  // one element of a List of k: a record is an object; anything else is read as {"value": …} was
  function item(k: WireKind): string {
    const m = mangle(k.t);
    return once(`json_item_${m}`, () => {
      if (k.k === 'rec')
        return `fn json_item_${m}(item: Json_Tree) -> Result[${text(k.t)}, View] {\n  match {\n    json.json_is_object(item) -> json_as_${k.name}(obj: item)\n    else -> Err(error: "not an object")\n  }\n}\n`;
      const read =
        k.k === 'list'
          ? `${each(k.of)}(arr: item)`
          : k.k === 's'
            ? `${itemValue(k)}(item)`
            : stop('an Option in a List');
      return `fn json_item_${m}(item: Json_Tree) -> Result[${text(k.t)}, View] {\n  match json.json_check(found: Some(value: item), kind: ${code(k)}, name: "value", optional: False, depth: 0) {\n    Json_Hit -> ${read}\n    Json_Miss(why) -> Err(error: json.json_plain(error: why))\n  }\n}\n`;
    });
  }
  function each(k: WireKind): string {
    const m = mangle(k.t);
    if (lists.has(`d${m}`)) return `json_list_${m}`;
    lists.set(`d${m}`, true);
    const by = item(k);
    out.push(
      `fn json_list_${m}(arr: Json_Tree) -> Result[List[${text(k.t)}], View] {\n  json.json_each(arr, by: fn(item: Json_Tree) -> Result[${text(k.t)}, View] { ${by}(item) })\n}\n`,
    );
    return `json_list_${m}`;
  }
  // a deep field's decoded value (a Result), from the member's value `found`
  const deepOf = (k: WireKind, found: string): string => {
    if (k.k === 'rec') return `json_as_${k.name}(obj: json.json_value_of(found: ${found}))`;
    if (k.k === 'list') return `${each(k.of)}(arr: json.json_value_of(found: ${found}))`;
    if (k.k !== 'opt') return stop('a scalar is read, not decoded');
    const inner = k.of;
    const m = mangle(inner.t);
    if (inner.k === 'rec')
      return `${once(`json_maybe_rec_${m}`, () => `fn json_maybe_rec_${m}(found: Option[Json_Tree]) -> Result[Option[${text(inner.t)}], View] {\n  match found {\n    Some(value) -> json.json_some(decoded: json_as_${inner.name}(obj: value))\n    None -> Ok(value: None)\n  }\n}\n`)}(found: ${found})`;
    if (inner.k === 'list') {
      const every = each(inner.of);
      return `${once(`json_maybe_list_${m}`, () => `fn json_maybe_list_${m}(found: Option[Json_Tree]) -> Result[Option[${text(inner.t)}], View] {\n  match found {\n    Some(value) -> json.json_some(decoded: ${every}(arr: value))\n    None -> Ok(value: None)\n  }\n}\n`)}(found: ${found})`;
    }
    return stop('an Option of a scalar is read, not decoded');
  };
  for (const n of decodable) {
    const d = types.get(n) ?? stop(`no type ${n}`);
    const kindsOf = (v: Variant): WireKind[] =>
      v.fields.map(f => kind(f.type, false, new Set()) ?? stop(`${v.name}.${f.name} cannot be JSON`));
    out.push(
      `fn json_decode_${n}(json: View) -> Result[${n}, View] {\n  match json.json_object(v: json) {\n    Ok(value) -> json_as_${n}(obj: value)\n    Err(error) -> Err(error)\n  }\n}\n`,
    );
    const vs = d.variants;
    // of several constructors, the one that has all its fields (bar Options) among the keys and names the most of
    // them, the first on a tie; when none has its fields, the reason of the one that got furthest
    const steps = vs
      .slice(1)
      .map(
        (_, j) =>
          `  let b${j + 1} = json.json_better(best: b${j}, most: m${j}, at: ${j + 1}, n: c${j + 1})\n  let m${j + 1} = json.json_most(a: m${j}, b: c${j + 1})\n`,
      );
    const last = vs.length - 1;
    out.push(
      vs.length === 1
        ? `fn json_as_${n}(obj: Json_Tree) -> Result[${n}, View] {\n  json_one_${n}_0(obj)\n}\n`
        : `fn json_as_${n}(obj: Json_Tree) -> Result[${n}, View] {\n${vs.map((_, i) => `  let c${i} = json_named_${n}_${i}(obj)\n`).join('')}  let b0 = 0\n  let m0 = c0\n${steps.join('')}  match {\n    m${last} < 0 -> json_try_${n}_0(obj, far: -1, why: "")\n${vs
            .slice(0, -1)
            .map((_, i) => `    b${last} == ${i} -> json_one_${n}_${i}(obj)\n`)
            .join('')}    else -> json_one_${n}_${last}(obj)\n  }\n}\n`,
    );
    vs.forEach((v, i) => {
      const ks = kindsOf(v);
      const kAt = (j: number): WireKind => ks[j] ?? stop('kind');
      out.push(
        `fn json_one_${n}_${i}(obj: Json_Tree) -> Result[${n}, View] {\n  match json_fit_${n}_${i}(obj) {\n    Json_Hit -> json_build_${n}_${i}(obj)\n    Json_Miss(why) -> Err(error: why)\n  }\n}\n`,
      );
      if (vs.length > 1) {
        const required = v.fields.filter((_, j) => kAt(j).k !== 'opt').map(f => `json.json_has(obj, key: "${f.name}")`);
        const count = v.fields.length > 0 ? v.fields.map(f => `json.json_one(obj, key: "${f.name}")`).join(' + ') : '0';
        out.push(
          `fn json_named_${n}_${i}(obj: Json_Tree) -> Int {\n${required.length > 0 ? `  match {\n    ${required.join(' and ')} -> ${count}\n    else -> -1\n  }\n` : `  ${count}\n`}}\n`,
        );
        const next = (far: string, why: string): string =>
          i + 1 < vs.length ? `json_try_${n}_${i + 1}(obj, far: ${far}, why: ${why})` : `Err(error: ${why})`;
        out.push(
          `fn json_try_${n}_${i}(obj: Json_Tree, far: Int, why: View) -> Result[${n}, View] {\n  match json_fit_${n}_${i}(obj) {\n    Json_Hit -> json_build_${n}_${i}(obj)\n    Json_Miss(depth, why: reason) if depth > far -> ${next('depth', 'reason')}\n    _ -> ${next('far', 'why')}\n  }\n}\n`,
        );
      }
      const fit = v.fields.reduceRight(
        (rest, f, j) =>
          `json.json_and(a: json.json_check(found: json.json_get(obj, key: "${f.name}"), kind: ${code(kAt(j))}, name: "${f.name}", optional: ${kAt(j).k === 'opt' ? 'True' : 'False'}, depth: ${j}), b: ${rest})`,
        'Json_Hit',
      );
      out.push(`fn json_fit_${n}_${i}(obj: Json_Tree) -> Json_Fit {\n  ${fit}\n}\n`);
      // the values: scalars read, then refinements checked in field order, then records and lists decoded
      const get = (f: string): string => `json.json_get(obj, key: "${f}")`;
      const lines: string[] = [];
      const as = new Map<string, string>();
      v.fields.forEach((f, j) => {
        const k = kAt(j);
        if (k.k === 's') lines.push(`  let w_${f.name} = ${scalarOf(k.base, get(f.name))}\n`);
        else if (k.k === 'opt' && k.of.k === 's')
          lines.push(`  let w_${f.name} = ${maybeOf(k.of.base, get(f.name))}\n`);
        else return;
        as.set(f.name, `w_${f.name}`);
      });
      v.fields.forEach((f, j) => {
        const k = kAt(j);
        if (k.k === 's' && refined(k.t))
          lines.push(
            `  let ${k.t.name}(r_${f.name}) = w_${f.name} else -> Err(error: "${f.name}: not a valid ${k.t.name}")\n`,
          );
        else if (k.k === 'opt' && k.of.k === 's' && refined(k.of.t))
          lines.push(
            `  let Some(value: r_${f.name}) = ${maybeRefined(k.of.t, k.of.base)}(found: w_${f.name}) else -> Err(error: "${f.name}: not a valid ${k.of.t.name}")\n`,
          );
        else return;
        as.set(f.name, `r_${f.name}`);
      });
      v.fields.forEach((f, j) => {
        const k = kAt(j);
        if (!deep(k)) return;
        const sep = present(k).k === 'list' ? '' : ': ';
        lines.push(
          `  let Ok(value: d_${f.name}) = ${deepOf(k, get(f.name))} else {\n    Err(error) -> Err(error: "${f.name}${sep}" ++ error)\n  }\n`,
        );
        as.set(f.name, `d_${f.name}`);
      });
      const built =
        v.fields.length > 0
          ? `${v.name}(${v.fields.map(f => `${f.name}: ${as.get(f.name) ?? stop(f.name)}`).join(', ')})`
          : v.name;
      out.push(
        `fn json_build_${n}_${i}(obj: Json_Tree) -> Result[${n}, View] {\n${lines.join('')}  Ok(value: ${built})\n}\n`,
      );
    });
  }
  const write = (o: string, e: string, k: WireKind): string =>
    k.k === 's'
      ? k.base === 'Int'
        ? `text.write_int(out: ${o}, value: ${e})`
        : k.base === 'Float'
          ? `json.json_write_float(out: ${o}, value: ${e})`
          : k.base === 'Bool'
            ? `json.write_bool(out: ${o}, value: ${e})`
            : `json.write_json_string(out: ${o}, text: ${e})`
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
        `fn wire_write_list_${m}(out: Buf, list: ${lt}) -> Buf {\n  wire_write_rest_${m}(out: json.json_push(out, byte: 91), list, first: True)\n}\n`,
        `fn wire_write_rest_${m}(out: Buf, list: ${lt}, first: Bool) -> Buf {\n  match list {\n    Cons(head, tail) if first -> wire_write_rest_${m}(out: ${write('out', 'head', k)}, list: tail, first: False)\n    Cons(head, tail) -> wire_write_rest_${m}(out: ${write('json.json_push(out, byte: 44)', 'head', k)}, list: tail, first: False)\n    Nil -> json.json_push(out, byte: 93)\n  }\n}\n`,
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
    if (canWrite(n)) {
      writable.add(n);
      const v = d.variants[0] ?? stop(`${n} has no constructor`),
        ks = kinds(v);
      let acc = 'out';
      v.fields.forEach((f, i) => {
        acc = write(`json.json_append(out: ${acc}, view: "${i ? ',' : '{'}\\"${f.name}\\":")`, vr(f.name), ks(i));
      });
      out.push(
        `fn wire_write_${n}(out: Buf, value: ${n}) -> Buf {\n${v.fields.length > 0 ? `  let ${v.name}(${v.fields.map(f => `${f.name}: ${vr(f.name)}`).join(', ')}) = value\n  json.json_append(out: ${acc}, view: "}")` : '  json.json_append(out, view: "{}")'}\n}\n`,
      );
    }
  }
  return { text: out.join('\n'), nested, decodable, kind, writable };
}
