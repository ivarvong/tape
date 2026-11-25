// compiler/diagnostics.ts: every code the compiler gives (L for the lexer, P for the parser, C for the checker and
// the rules), with one line on what it refuses and why. Data only: the compiler does not read it. The messages and
// fixes stay where each code is raised, because they name what the program wrote; this is what a code means
// whatever the program. docs/gen-diagnostics.ts writes docs/diagnostics.md from it, and test/diagnostics.ts fails
// when a code raised in compiler/, rules/ or sql/ has no row, a row names a code nothing raises, or a code has no
// test that makes the compiler give it.
// The keys are written bare, not quoted: test/definition.ts takes a quoted code in compiler/ for one the compiler
// gives, and a row is not that.

/** What a code means. `fixture` is said only of a code no program can cause, with the reason. */
export type Diagnostic = { readonly meaning: string; readonly fixture?: `none: ${string}` };

export const DIAGNOSTICS = {
  // ---- the lexer
  L01: {
    meaning:
      'A character Tape does not have outside a text literal or a comment. A `!`, a `;`, a `?`, a backtick, and the doubled & and | of other languages are each named, with what Tape writes instead.',
  },
  L02: {
    meaning:
      'A text literal not closed on its line. Text is on one line; a backslash at the end of a line carries it on.',
  },
  L03: {
    meaning:
      'An escape a text literal does not have. Text allows `\\" \\\\ \\/ \\n \\r \\t \\b \\f`, and a hole for a value.',
  },
  L04: { meaning: "A migration's SQL with no closing `}`, so the rest of the file would be read as SQL." },
  L05: {
    meaning:
      'A hole in a text literal that is not closed, or that holds a text literal: a hole holds one expression with no text in it.',
  },
  L06: {
    meaning:
      'A number Tape does not have: an exponent without the `f` of a Float, a Dec with more than 18 digits after the point, or a Float with more than 20 significant digits or past the largest Float.',
  },
  L07: {
    meaning:
      'A byte literal that is not one byte: empty, two characters, a character past ASCII, a raw control character, an unknown escape, or not closed.',
  },

  // ---- the parser
  P01: {
    meaning:
      'The parser expected one token and found another: most often a reserved word where a name goes, a `let` with a type, or a pattern that is an expression to compute.',
  },
  P02: {
    meaning:
      'Where an expression goes, something that is not one. It names the forms Tape does not have (`if`, `return`, tuples) and a line that starts with `-`, which starts a new value.',
  },
  P03: { meaning: 'Comparisons chained, `a < b < c`. A comparison is a Bool, and two are joined with `and`.' },
  P04: {
    meaning:
      'Where a pattern goes, something that is not one: a reserved word, `else` in a match on a value (its fallback is `_`), or `pattern ++` with no text literal after it.',
  },
  P05: {
    meaning:
      'At the top of a file, something that is not a declaration. A file is `fn`, `type`, `interface`, `migration`, `schema`, `flag`, `machine` and `invariant`; a statement goes inside a function.',
  },
  P06: {
    meaning:
      'An interface method that does not say `read` or `write`. It says whether a call may be repeated as it is or carries a key.',
  },
  P07: { meaning: 'The right side of a pipe is not a function call, so there is nothing to pass the value to.' },
  P08: { meaning: 'A literal outside its type: an Int past 64 bits, or a Dec past the 64-bit count of its scale.' },
  P09: {
    meaning:
      'An expression nested more than 500 deep (a match or a lambda counts four). The parser stops there rather than run out of stack; name a part with `let`.',
  },

  // ---- declarations and types
  C01: { meaning: 'A type or interface declared twice, or with the name of a built-in type. A name means one type.' },
  C02: { meaning: 'A type with no constructors. It would have no values, so nothing could be made or matched.' },
  C03: {
    meaning:
      'A constructor declared twice. A constructor belongs to one type, so a pattern or a call of it means one thing.',
  },
  C04: { meaning: 'A function defined twice in one file, or a method listed twice in one interface.' },
  C05: {
    meaning:
      'A type given the wrong number of type arguments: `Dec` without its scale, `Rows` without one row type, a declared type with more or fewer than it takes.',
  },
  C06: { meaning: 'A type name that nothing declares.' },
  C07: {
    meaning:
      'A type laid out inside itself, which would have no end. A type that holds itself through a field is boxed; today only a type parameter with the name of its own type reaches this.',
  },
  C08: {
    meaning:
      'A capability bound with `let`, or a Buf or a capability as a field. A Buf has one owner at a time and a capability is passed by name, so neither is stored.',
  },
  C09: {
    meaning:
      'A type that cannot be a row type, decoded from JSON or written as JSON, for a field neither holds; or a function value whose parameter takes a name already in use.',
  },

  // ---- calls and names
  C10: {
    meaning:
      'An argument after the first with no name, or a pattern for a field that does not name it. A call and a pattern say which value is which.',
  },
  C11: { meaning: 'An argument the function, constructor, method or built-in does not take.' },
  C12: {
    meaning:
      'One argument given twice (by name after a pipe already gave the first parameter, too), or a function value called with other than its arguments, in order and unnamed.',
  },
  C13: { meaning: 'A call or a constructor without an argument it needs. Every parameter and every field is given.' },
  C14: {
    meaning:
      'A value of one type where another is expected. It covers two Dec scales, a Dec scale that would pass 18 digits, an Int and a Float mixed, and a capability not passed where a built-in needs it.',
  },
  C15: { meaning: 'A name bound again in one function. Names are never reused, so each means one value.' },
  C16: { meaning: 'A name that is not a parameter, a `let` or a pattern binding in scope.' },
  C17: { meaning: 'A dot on a value of a type with several constructors. Only a one-constructor type has fields.' },
  C18: {
    meaning:
      "A field the value's type does not have, read with a dot or named in a pattern; or a function pattern given more than one pattern.",
  },
  C19: {
    meaning:
      'An operator its operands do not have: `++` on what is not text, `/` and `%` on a Dec, `%` on a Float, a comparison of Options, a value in a text hole that is not text or a number, a literal pattern for a Dec or a Float.',
  },
  C20: { meaning: 'A constructor that nothing declares.' },
  C21: {
    meaning:
      'A constructor of a generic type, such as `None`, used where nothing says which type it is (`Option[Int]` or `Option[View]`).',
  },
  C22: { meaning: 'A function that nothing defines, called or used as a pattern.' },
  C23: {
    meaning:
      'A match the value cannot have: a constructor of another type, a constructor pattern on a type with none, or a match on a Buf or a capability.',
  },
  C24: {
    meaning:
      'A match that does not cover every value of its subject, or a condition match without its last `else`. A match always says what it is.',
  },
  C25: { meaning: 'A Buf used after it was handed over. A Buf has one owner at a time.' },
  C26: {
    meaning:
      'A Buf handed over inside a guard, a condition, a pattern, a destructuring `let` or the right side of `and`/`or`, which may not run.',
  },
  C27: { meaning: 'A Buf that is never used: its bytes would be lost. Return it, pass it on, or freeze it.' },
  C28: {
    meaning:
      'Match arms that hand over different Bufs. Each arm uses the same ones, so each Buf has one owner after the match.',
  },
  C29: { meaning: "`size` given something other than a Buf variable. It reads a Buf's length without taking it." },
  C30: {
    meaning:
      'A function the program needs and does not have: an entry point the host calls (`handle`, an exported one), or a std function a form is built on when std is not compiled with the program.',
  },
  C32: {
    meaning:
      'A query that is not a text literal, uses a `?` placeholder, or names a placeholder after an argument every query call takes. Queries are fixed when the program is compiled, and each value is passed by name.',
  },
  C34: { meaning: 'A function used as a pattern that does not take one value and return an Option.' },
  C35: {
    meaning:
      'A form Tape has removed: a `json(…)` pattern (decode, then match) and `with { … }` (steps, `let P = e else …`).',
  },
  C36: {
    meaning:
      'A refined type built directly. A value becomes one only by matching its pattern, which checks the condition.',
  },
  C37: {
    meaning:
      'A flag misused: read but not declared, declared twice, with a default of the wrong kind, or pinned by a build when the program declares no such flag.',
  },
  C38: { meaning: 'A flag declared and never read: a rollout that already finished. Delete its declaration.' },
  C39: { meaning: 'A call to another program without `within`. Every call has a time budget in milliseconds.' },
  C41: {
    meaning:
      'A `call` (a command) without `once`. The key lets the other side run it at most once, so it can be sent again after a timeout.',
  },
  C42: {
    meaning:
      'An exported function that does not take capabilities and exactly one message, or does not return `Result[Reply, View]`, which is how another program calls it.',
  },
  C43: {
    meaning: 'A call of a generic function where nothing says what one of its type parameters is.',
  },
  C44: {
    meaning:
      'A function value with no parameter or more than two, or one that captures a Buf or a capability, which cannot be kept inside it.',
  },
  C45: {
    meaning: 'A name two files other than the first define, used unqualified. Say which: `file.name`.',
  },
  C46: { meaning: 'A method an interface does not have.' },
  C47: {
    meaning:
      'A migration out of order. Migrations are numbered 1, 2, 3 in the order they are written, and never renumbered.',
  },
  C48: {
    meaning:
      'A destructuring `let` that can fail, or of a value with no fields. A `let` takes apart only what always matches; the rest is `let … else` or `match`.',
  },
  C49: { meaning: 'A value piped into a function that takes nothing.' },

  // ---- capabilities, timers and effects
  C50: {
    meaning:
      'A program that sets a timer and exports no `woken`, or a `woken` that does not take a Wake. A timer that is due has nothing to call.',
  },
  C51: {
    meaning:
      'A migration that is not `contract` with a statement other than CREATE TABLE, CREATE INDEX, ALTER TABLE … ADD COLUMN or INSERT INTO: it may take away what a live version still reads.',
  },
  C52: {
    meaning:
      "A query over two or more tables with a column not qualified by its table, or a subquery naming the outer query's column bare: a column a later migration adds would change what it means.",
  },
  C53: {
    meaning:
      '`schema` statements and migrations in one program. Tables are declared one way, so they are built one way.',
  },
  C54: {
    meaning:
      'A write reached from `handle` or `woken` whose new values depend on the row (`n = n + 1`) with nothing to make a second run a no-op: a retry applies it twice.',
  },
  C55: {
    meaning: 'An INSERT reached from `handle` or `woken` that inserts no whole unique key: a retry makes a second row.',
  },
  C56: {
    meaning:
      'An op-id guard that does not name the row it protects, so the same op id sent for another row is taken for a repeat and that write is lost.',
  },
  C57: {
    meaning:
      'A machine over a table or column the program does not have, a second machine for one column, or a move to itself or listed twice.',
  },
  C58: {
    meaning:
      "An UPDATE, upsert or DELETE of a machine's table whose WHERE does not name the state it expects, so it also writes onto a row another request has moved on.",
  },
  C59: {
    meaning:
      'A write that makes a move its machine does not declare, or an INSERT whose row does not start in the first state.',
  },
  C60: {
    meaning:
      "A write of a machine's column whose states the checker cannot read (CASE, a subquery, REPLACE, a trigger, a state that is not a literal). It is refused rather than passed.",
  },
  C61: {
    meaning:
      "A literal compared with a machine's column that is not one of its states. No row is in it, so the comparison never matches.",
  },
  C62: {
    meaning:
      "A compare-and-set on a machine's column written with sql_exec or sql_first, which answer the same when another request moved the row first and when there is no row. It is a `sql_move`.",
  },
  C63: {
    meaning:
      'A `sql_move` whose statement is not one UPDATE of one row by its whole unique key, with a compare-and-set on the state and RETURNING the row type.',
  },
  C64: {
    meaning:
      "A command's `once:` key that is a number, a Bool or an Option. A key names the command: text, or a record of the program's own.",
  },
  C65: {
    meaning:
      "A command's `once:` key that is the same every time it is sent: each command after the first is answered with the first's reply.",
  },
  C66: {
    meaning:
      'A constructor of a private type made outside the file that declares it. A value of it is a witness that that file made it; a CallError comes only from a call.',
  },
  C67: {
    meaning:
      'A statement the SQL checker does not read: outside the subset it parses (WITH, triggers, window functions, schema names), or not SQL.',
  },
  C68: {
    meaning:
      'SQL naming a table or column the schema does not have, or a schema whose statements do not build, as SQLite would build them, one after another.',
  },
  C69: {
    meaning:
      "A query whose columns or values do not fit the program's types: a column count, name, type or NULL that the row type does not match, a value of the wrong kind, a NULL compared with `=`, or a write read as a row without RETURNING.",
  },
  C70: {
    meaning:
      "A migration or schema statement that writes a machine's column as a state the machine does not declare, or in a way the checker cannot read. Migrations run with the machine's triggers off.",
  },
  C71: {
    meaning:
      "A command built from a row whose key does not name that row, or, after a `sql_move`, does not carry what the move wrote. Another row's command with the same values is taken for a repeat.",
  },
  C72: {
    meaning:
      'A capability used on a path from an entry point that does not declare it. The host grants capabilities at an entry point, and every caller shows what it reaches.',
  },
  C73: {
    meaning:
      'An UPDATE that takes from a column (`n = n - e`) with no floor guard in its WHERE, or one too weak for its CHECK: two requests that each see enough both take, and the column is overdrawn.',
  },
  C74: {
    meaning:
      'An UPDATE that sets a column another write guards as a state, without saying which states it moves from, when no machine declares the column.',
  },
  C75: { meaning: 'A `*` in a query that the row type does not account for, column by column.' },
  C76: {
    meaning:
      "A program's own type or constructor used where std's, which it shadows, is meant. The message names both.",
  },
  C77: {
    meaning:
      'A machine state no write leaves, or a write into a state the program must leave itself with no timer set in the same commit, when nothing else comes back for the row.',
  },
  C78: {
    meaning:
      "A timer whose key is not the row's key, or that `woken` does not read back to that row: the run it starts does not do what is left for the row.",
  },
  C79: {
    meaning:
      "A timer's run with a path that leaves the row in a timed state and sets no timer again: the timer is spent, and nothing comes back for the row.",
  },
  C80: {
    meaning:
      'A constructor declared `final` made where a second run may decide otherwise: on the way to it, a condition reads the clock in a way that can flip, or the reply of an `ask`.',
  },
  C81: {
    meaning: 'A state named in a pattern on a row that its machine does not declare. The arm can never be taken.',
  },
  C82: {
    meaning:
      '`do` before something that is not a call, or a call whose value is not an Int. `do` drops only a number; an Option, a Result or a Move has outcomes to read.',
  },
  C83: {
    meaning: 'A call bound with `let` to a name never read, so what it does is hidden. Write `do call(…)`.',
  },
  C84: {
    meaning: 'A call passed to a parameter its function never reads, so what it does is hidden. Write `do call(…)`.',
  },
  C85: { meaning: 'A call multiplied by 0, so what it does is hidden and its value thrown away. Write `do call(…)`.' },
  C86: {
    meaning:
      "An invariant that is not one SELECT, without placeholders, over the schema's tables and columns, or one whose name is used twice.",
  },
  C87: {
    meaning:
      'A match on a reply where one arm takes a refusal together with no answer and sets a timer: the same key gets the same refusal, so it asks for ever.',
  },
  C88: {
    meaning:
      '`repeat: True` or `no_floor: True` on a call whose statement its rule (C54 and C55, or C73) accepts anyway. The argument is a claim about the write, so it is refused where it is not true.',
  },
  C93: {
    meaning:
      'The set of `scan` that is not a text literal. The bytes are fixed when the program is compiled, so the scan reads 16 at a time.',
  },
  C94: {
    meaning:
      "A `private fn` called, passed as a function value or matched as a pattern outside the file that defines it. std's helpers are private: what it reads and writes for decode is reached through decode, is_json and json_member.",
  },
  C99: {
    meaning:
      'A compiler bug, not a mistake in the program: a type not known where it must be, a function value of no function, a match with no arms, a std type not as the compiler expects. Report it with the program.',
    fixture:
      'none: each C99 is an invariant of the compiler that the checks before it make true for every program (a type is known, a match has an arm); a program that reaches one is a bug to report, and no test can hold one in place',
  },
} as const satisfies Record<string, Diagnostic>;

export type Code = keyof typeof DIAGNOSTICS;

/** Codes kept for rules not yet shipped, with why; the compiler gives none of them. */
export const RESERVED = {
  C89: 'a Float as a SQL parameter; reserved by docs/numbers-language-draft.md (spec Q12), not shipped',
  C90: "a Float in a call's key; reserved by docs/numbers-language-draft.md (spec Q12), not shipped",
  C91: 'a take-from-quantity or compare-and-set on a REAL column; reserved by docs/numbers-language-draft.md (spec Q12), not shipped',
  C92: 'a Dec meeting a column that does not hold it; reserved by docs/numbers-language-draft.md (spec Q12), not shipped',
} as const satisfies Record<string, string>;
