// compiler/wire.ts: Tape source generated for JSON. For every record type T a program can decode, a decoder:
//   json_decode_T(json)     the bytes read once into a tree (std/json.tape json_tree), then json_as_T
//   json_as_T(obj)          the first constructor whose keys and kinds fit the object (or why not, from the one that
//                           got furthest), its refined fields checked in order, then its records and lists decoded,
//                           each reason with the path to it
//   json_decode_top_L(json)  for each `decode(json:, as: List[…])`: the array, its elements decoded in turn
// and for each record type that is not one flat constructor (`written`):
//   wire_write_T(out, value)  the object, field by field: an Option field that is None has no key, and a type with
//                             several constructors is {"Constructor": {…}}, the form json_as_T reads first
// decode calls json_decode_T; write_json calls wire_write_T. A field is: Int, Bool, View (or a refinement); a record; List[…] of those; Option[…] of
// any. What decode accepts and the reasons it gives are those of the host's decode before it (JSON.parse, then the
// shape), with numbers read exactly (std/json.tape json_int). The code calls std's functions by their qualified names
// (json.json_get, text.write_int, json.json_append for append) and names only std types a program cannot define
// (shadow.ts CORE), so a program's own max, push or List does not take their place.
import { asType, partsOf } from './ast.ts';
import type { Expr, Program, TypeAst, Variant } from './ast.ts';
import { decExpected, refusalOf } from './rule.ts';

/** What a field is in JSON: a scalar, a record, a list of one of those, or any of them that may be absent. */
export type WireKind =
  | { k: 's'; base: string; t: TypeAst; scale?: number }
  | { k: 'rec'; name: string; t: TypeAst }
  | { k: 'list'; of: WireKind; t: TypeAst }
  | { k: 'opt'; of: WireKind; t: TypeAst };
export type Wire = {
  /** the Tape source written for the nested types */
  text: string;
  /** the record types that have a field that is a record or a list */
  nested: Set<string>;
  kind: (t: TypeAst, inList: boolean, busy: Set<string>) => WireKind | null;
  /** the record types written by wire_write_T: all that can be JSON but one flat constructor without Option */
  written: Set<string>;
  /** every record type that can be JSON (written by wire_write_T or, one flat constructor, by write_json itself) */
  encodable: Set<string>;
  /** the record types that have a decoder (json_decode_T) */
  decodable: Set<string>;
};
// the kind of a field when it is there
// the variable generated code holds a field in: a field may be named by a reserved word (`type`), a variable not
const vr = (field: string): string => `w_${field}`;
const stop = (what: string): never => {
  throw new Error(`wire: ${what}`);
};
const astText = (t: TypeAst): string => (t.args.length > 0 ? `${t.name}[${t.args.map(astText).join(', ')}]` : t.name);
/** A type's text as part of a generated name: `List[Item]` is `List_Item`. */
export const mangled = (text: string): string => text.replaceAll(/[^A-Za-z0-9]+/g, '_').replace(/_$/, '');
/** Every List type the program decodes on its own, `decode(json:, as: List[T])`. */
function topLists(prog: Program): TypeAst[] {
  const out = new Map<string, TypeAst>();
  const visit = (e: Expr): void => {
    if (e.k === 'call' && e.name === 'decode') {
      const as = e.args.find(a => a.label === 'as')?.value,
        t = as ? asType(as) : null;
      if (t?.name === 'List') out.set(astText(t), t);
    }
    partsOf(e).forEach(visit);
  };
  for (const f of prog.fns.values()) visit(f.body);
  return [...out.values()];
}

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
  // the scale of Dec[s], or of a refinement of one
  const decScale = (t: TypeAst): number | null => {
    let at: TypeAst | undefined = t,
      seen = 0;
    while (at && types.get(at.name)?.refine && seen++ < 20) at = types.get(at.name)?.refine?.base;
    const [s] = at?.args ?? [];
    return at?.name === 'Dec' && at.args.length === 1 && s && /^\d+$/.test(s.name) && (at === t || t.args.length === 0)
      ? Number(s.name)
      : null;
  };
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
    const s = decScale(t);
    if (s !== null) return { k: 's', base: 'Dec', t, scale: s };
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
  // the program's own record types, std's Wake (a timer's message), and the records their fields hold: std's other
  // types are never decoded, and every function is type-checked, so none is written for them
  const decodable = new Set<string>();
  const add = (n: string): void => {
    if (decodable.has(n)) return;
    decodable.add(n);
    for (const v of types.get(n)?.variants ?? [])
      for (const f of v.fields) {
        let k = kind(f.type, false, new Set());
        while (k && k.k !== 's' && k.k !== 'rec') k = k.of;
        if (k?.k === 'rec') add(k.name);
      }
  };
  for (const n of types.keys())
    if (
      record(n) &&
      (!(types.get(n)?.file ?? '').startsWith('std/') || n === 'Wake') &&
      ![n, ...(types.get(n)?.variants ?? []).map(v => v.name)].some(x => x.startsWith('std.')) &&
      able(n)
    )
      add(n);
  // the helpers are std/json.tape's: a build without it decodes nothing (decode says so)
  if (!prog.fns.has('json_tree') || !prog.fns.has('write_bool') || !prog.fns.has('wire_key'))
    return { text: '', nested: new Set(), decodable: new Set(), kind, written: new Set(), encodable: new Set() };
  const fieldKinds = (n: string): (WireKind | null)[] =>
    (types.get(n)?.variants ?? []).flatMap(v => v.fields.map(f => kind(f.type, false, new Set())));
  // std's own types are written only as one flat constructor: no writer is generated for them
  const written = new Set(
    [...decodable].filter(
      n =>
        nested.has(n) ||
        (!types.get(n)?.file.startsWith('std/') &&
          ((types.get(n)?.variants.length ?? 0) > 1 || fieldKinds(n).some(k => k?.k === 'opt'))),
    ),
  );
  const out: string[] = [],
    lists = new Map<string, boolean>(),
    helpers = new Set<string>(),
    mangle = (t: TypeAst): string => mangled(text(t));
  const once = (name: string, src: () => string): string => {
    if (!helpers.has(name)) {
      helpers.add(name);
      out.push(src());
    }
    return name;
  };
  // what json_check is told a kind is: 0 text, 1 true or false, 2 an integer, 3 an object, 4 an array
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
  // the check of a field (or a list item, named "value") of kind k, as json_check or, for a Float, json_check_float
  const check = (k: WireKind, found: string, name: string, optional: boolean, depth: number): string => {
    const one = k.k === 'opt' ? k.of : k;
    if (one.k === 's' && one.base === 'Dec')
      return `json.json_check_dec(found: ${found}, scale: ${one.scale ?? 0}, name: "${name}", optional: ${optional ? 'True' : 'False'}, depth: ${depth})`;
    return one.k === 's' && one.base === 'Float'
      ? `json.json_check_float(found: ${found}, name: "${name}", optional: ${optional ? 'True' : 'False'}, depth: ${depth})`
      : `json.json_check(found: ${found}, kind: ${code(k)}, name: "${name}", optional: ${optional ? 'True' : 'False'}, depth: ${depth})`;
  };
  const scalarOf = (of: string, found: string): string =>
    of === 'View'
      ? `json.json_text_of(found: ${found})`
      : of === 'Bool'
        ? `json.json_bool_of(found: ${found})`
        : of === 'Float'
          ? `json.json_float_of(found: ${found})`
          : `json.json_int_of(found: ${found})`;
  const maybeOf = (of: string, found: string): string =>
    of === 'View'
      ? `json.json_maybe_text(found: ${found})`
      : of === 'Bool'
        ? `json.json_maybe_bool(found: ${found})`
        : of === 'Float'
          ? `json.json_maybe_float(found: ${found})`
          : `json.json_maybe_int(found: ${found})`;
  // Option[R] of a refined R, from Option[its base]: None when the value there is not an R
  const maybeRefined = (t: TypeAst, of: string): string =>
    once(
      `json_maybe_${mangle(t)}`,
      () =>
        `fn json_maybe_${mangle(t)}(found: Option[${of}]) -> Option[Option[${text(t)}]] {\n  match found {\n    Some(value: ${t.name}(x)) -> Some(value: Some(value: x))\n    None -> Some(value: None)\n    _ -> None\n  }\n}\n`,
    );
  // a Dec's value from the text of the number or string found (json_check_dec has checked it)
  const decOf = (k: Extract<WireKind, { k: 's' }>, found: string): string =>
    `parse_dec(text: json.json_number_text(found: ${found}), scale: ${k.scale ?? 0})`;
  // what decode's 400 says a value must be, after "expected ", as a Tape text literal's inside
  const said = (s: string): string => s.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  const refused = (t: TypeAst): string => said(refusalOf(prog, t.name));
  // a scalar element's value, its refinement checked
  function itemValue(k: Extract<WireKind, { k: 's' }>): string {
    const m = mangle(k.t);
    return once(`json_value_${m}`, () => {
      if (k.base === 'Dec') {
        const value = refined(k.t)
          ? `  let ${k.t.name}(y) = x else -> Err(error: "${refused(k.t)}")\n  Ok(value: y)\n`
          : `  Ok(value: x)\n`;
        return `fn json_value_${m}(item: Json_Tree) -> Result[${text(k.t)}, View] {\n  let Some(value: x) = ${decOf(k, 'Some(value: item)')} else -> Err(error: "expected ${decExpected(k.scale ?? 0)}")\n${value}}\n`;
      }
      const got = scalarOf(k.base, 'Some(value: item)');
      const body = refined(k.t)
        ? `  let ${k.t.name}(x) = ${got} else -> Err(error: "${refused(k.t)}")\n  Ok(value: x)\n`
        : `  Ok(value: ${got})\n`;
      return `fn json_value_${m}(item: Json_Tree) -> Result[${text(k.t)}, View] {\n${body}}\n`;
    });
  }
  // one element of a List of k: a record is an object; anything else is read as {"value": …} was
  function item(k: WireKind): string {
    const m = mangle(k.t);
    return once(`json_item_${m}`, () => {
      if (k.k === 'rec')
        return `fn json_item_${m}(item: Json_Tree) -> Result[${text(k.t)}, View] {\n  match {\n    json.json_is_object(item) -> json_as_${k.name}(obj: item)\n    json.json_is_null(item) -> Err(error: "null")\n    else -> Err(error: "expected an object")\n  }\n}\n`;
      const read =
        k.k === 'list'
          ? `${each(k.of)}(arr: item)`
          : k.k === 's'
            ? `${itemValue(k)}(item)`
            : stop('an Option in a List');
      return `fn json_item_${m}(item: Json_Tree) -> Result[${text(k.t)}, View] {\n  match ${check(k, 'Some(value: item)', 'value', false, 0)} {\n    Json_Hit -> ${read}\n    Json_Miss(why) -> Err(error: json.json_plain(error: why))\n  }\n}\n`;
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
      return `${once(`json_maybe_rec_${m}`, () => `fn json_maybe_rec_${m}(found: Option[Json_Tree]) -> Result[Option[${text(inner.t)}], View] {\n  match json.json_present(found) {\n    Some(value) -> json.json_some(decoded: json_as_${inner.name}(obj: value))\n    None -> Ok(value: None)\n  }\n}\n`)}(found: ${found})`;
    if (inner.k === 'list') {
      const every = each(inner.of);
      return `${once(`json_maybe_list_${m}`, () => `fn json_maybe_list_${m}(found: Option[Json_Tree]) -> Result[Option[${text(inner.t)}], View] {\n  match json.json_present(found) {\n    Some(value) -> json.json_some(decoded: ${every}(arr: value))\n    None -> Ok(value: None)\n  }\n}\n`)}(found: ${found})`;
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
        : `fn json_as_${n}(obj: Json_Tree) -> Result[${n}, View] {\n  match json.json_tag(obj) {\n${vs.map((v, i) => `    "${v.name}" -> json_tagged_${n}_${i}(found: json.json_get(obj, key: "${v.name}"))\n`).join('')}    _ -> json_untagged_${n}(obj)\n  }\n}\n` +
            `fn json_untagged_${n}(obj: Json_Tree) -> Result[${n}, View] {\n${vs.map((_, i) => `  let c${i} = json_named_${n}_${i}(obj)\n`).join('')}  let b0 = 0\n  let m0 = c0\n${steps.join('')}  match {\n    m${last} < 0 -> json_try_${n}_0(obj, far: -1, why: "")\n${vs
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
        // {"Name": {…}}, as write_json writes it: that constructor, from the object inside
        out.push(
          `fn json_tagged_${n}_${i}(found: Option[Json_Tree]) -> Result[${n}, View] {\n  let inner = json.json_value_of(found)\n  match {\n    json.json_is_object(item: inner) -> json_one_${n}_${i}(obj: inner)\n    else -> Err(error: "${v.name}: expected an object")\n  }\n}\n`,
        );
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
          `json.json_and(a: ${check(kAt(j), `json.json_get(obj, key: "${f.name}")`, f.name, kAt(j).k === 'opt', j)}, b: ${rest})`,
        'Json_Hit',
      );
      out.push(`fn json_fit_${n}_${i}(obj: Json_Tree) -> Json_Fit {\n  ${fit}\n}\n`);
      // the values: scalars read, then refinements checked in field order, then records and lists decoded
      const get = (f: string): string => `json.json_get(obj, key: "${f}")`;
      const lines: string[] = [];
      const as = new Map<string, string>();
      v.fields.forEach((f, j) => {
        const k = kAt(j);
        if (k.k === 's' && k.base === 'Dec')
          lines.push(
            `  let Some(value: w_${f.name}) = ${decOf(k, get(f.name))} else -> Err(error: "${f.name}: expected ${decExpected(k.scale ?? 0)}")\n`,
          );
        else if (k.k === 's') lines.push(`  let w_${f.name} = ${scalarOf(k.base, get(f.name))}\n`);
        else if (k.k === 'opt' && k.of.k === 's' && k.of.base === 'Dec')
          lines.push(`  let w_${f.name} = ${decOf(k.of, get(f.name))}\n`);
        else if (k.k === 'opt' && k.of.k === 's')
          lines.push(`  let w_${f.name} = ${maybeOf(k.of.base, get(f.name))}\n`);
        else return;
        as.set(f.name, `w_${f.name}`);
      });
      v.fields.forEach((f, j) => {
        const k = kAt(j);
        if (k.k === 's' && refined(k.t))
          lines.push(`  let ${k.t.name}(r_${f.name}) = w_${f.name} else -> Err(error: "${f.name}: ${refused(k.t)}")\n`);
        else if (k.k === 'opt' && k.of.k === 's' && refined(k.of.t))
          lines.push(
            `  let Some(value: r_${f.name}) = ${maybeRefined(k.of.t, k.of.base === 'Dec' ? `Dec[${k.of.scale ?? 0}]` : k.of.base)}(found: w_${f.name}) else -> Err(error: "${f.name}: ${refused(k.of.t)}")\n`,
          );
        else return;
        as.set(f.name, `r_${f.name}`);
      });
      v.fields.forEach((f, j) => {
        const k = kAt(j);
        if (!deep(k)) return;
        lines.push(
          `  let Ok(value: d_${f.name}) = ${deepOf(k, get(f.name))} else {\n    Err(error) -> Err(error: json.json_join(path: "${f.name}", error))\n  }\n`,
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
  for (const t of topLists(prog)) {
    const k = kind(t, false, new Set());
    if (k?.k !== 'list') continue;
    out.push(
      `fn json_decode_top_${mangle(t)}(json: View) -> Result[${text(t)}, View] {\n  match json.json_array(v: json) {\n    Ok(value) -> ${each(k.of)}(arr: value)\n    Err(error) -> Err(error)\n  }\n}\n`,
    );
  }
  // the kind of a constructor's i-th field: every field of a type that can be JSON has one
  const kinds = (v: Variant): ((i: number) => WireKind) => {
    const all = v.fields.map(f => kind(f.type, false, new Set()));
    return i => all[i] ?? stop(`${v.name} has no field ${i} that can be JSON`);
  };
  // A constructor's object: its fields in order, each written by write_json. An Option field that is None has no
  // key, so a key that may be the first one written is put after a comma only when a field before it is there.
  const object = (v: Variant, buf: string): string => {
    const ks = kinds(v),
      key = (name: string): string => `\\"${name}\\":`;
    if (v.fields.length === 0) return `  json.json_append(out: ${buf}, view: "{}")`;
    if (!v.fields.some((_, i) => ks(i).k === 'opt')) {
      const acc = v.fields.reduce(
        (o, f, i) =>
          `write_json(out: json.json_append(out: ${o}, view: "${i ? ',' : '{'}${key(f.name)}"), value: ${vr(f.name)})`,
        buf,
      );
      return `  json.json_append(out: ${acc}, view: "}")`;
    }
    // whether something is written before field i: a field there for certain, or an Option field that is Some
    const before = (i: number): string => {
      const earlier = v.fields.slice(0, i);
      if (earlier.some((_, j) => ks(j).k !== 'opt')) return 'True';
      return earlier.map(f => `json.json_there(found: ${vr(f.name)})`).join(' or ') || 'False';
    };
    const acc = v.fields.reduce(
      (o, f, i) =>
        ks(i).k === 'opt'
          ? `json.wire_field(out: ${o}, more: ${before(i)}, key: "${key(f.name)}", found: ${vr(f.name)})`
          : `write_json(out: json.wire_key(out: ${o}, more: ${before(i)}, key: "${key(f.name)}"), value: ${vr(f.name)})`,
      `json.json_append(out: ${buf}, view: "{")`,
    );
    return `  json.json_append(out: ${acc}, view: "}")`;
  };
  const bound = (v: Variant): string =>
    `${v.name}${v.fields.length > 0 ? `(${v.fields.map(f => `${f.name}: ${vr(f.name)}`).join(', ')})` : ''}`;
  for (const n of written) {
    const d = types.get(n) ?? stop(`no type ${n}`),
      [only] = d.variants;
    if (d.variants.length === 1 && only) {
      out.push(
        `fn wire_write_${n}(out: Buf, value: ${n}) -> Buf {\n${only.fields.length > 0 ? `  let ${bound(only)} = value\n` : ''}${object(only, 'out')}\n}\n`,
      );
      continue;
    }
    // several constructors: {"Constructor": {…}}, each constructor's object written by a function of its own
    out.push(
      `fn wire_write_${n}(out: Buf, value: ${n}) -> Buf {\n  match value {\n${d.variants.map(v => `    ${bound(v)} -> json.json_append(out: wire_object_${v.name}(out: json.json_append(out, view: "{\\"${v.name}\\":")${v.fields.map(f => `, ${vr(f.name)}`).join('')}), view: "}")`).join('\n')}\n  }\n}\n`,
      ...d.variants.map(
        v =>
          `fn wire_object_${v.name}(out: Buf${v.fields.map(f => `, ${vr(f.name)}: ${text(f.type)}`).join('')}) -> Buf {\n${object(v, 'out')}\n}\n`,
      ),
    );
  }
  return { text: out.join('\n'), nested, decodable, kind, written, encodable: new Set(decodable) };
}
