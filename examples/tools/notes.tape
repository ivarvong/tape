// notes.tape: a Sql tool, a small key-value notebook. Its `db: Sql` is its own database: one per tool, which no
// other tool or program can read, and which it keeps across calls.

schema "CREATE TABLE IF NOT EXISTS notes(key TEXT PRIMARY KEY NOT NULL, text \
    TEXT NOT NULL, revision INTEGER NOT NULL)"

type Key = View where len(self) >= 1 and len(self) <= 64
type Text = View where len(self) <= 2000
type Put { Put(key: Key, text: Text) }
type Get { Get(key: Key) }
type Stored { Stored(key: View, revision: Int) }
type Note { Note(key: View, text: View, revision: Int) }
// why notes refuses: a save that was not stored, a key with no note
type NoteError {
  NotSaved
  NoNote
}

// Save a note under a key, replacing what was there; each save of a key adds one to its revision.
export fn put(db: Sql, message: Put) -> Result[Stored, NoteError] {
  stored(found: sql_first(
    row: Stored,
    query: "INSERT INTO notes VALUES (:key, :text, 1) ON CONFLICT(key) \
        DO UPDATE SET text = excluded.text, revision = revision + 1 RETURNING key, revision",
    key: message.key,
    text: message.text
  ))
}

// Read the note saved under a key.
export fn get(db: Sql, message: Get) -> Result[Note, NoteError] {
  found(note: sql_first(
    row: Note,
    query: "SELECT key, text, revision FROM notes WHERE key = :key",
    key: message.key
  ))
}

fn stored(found: Option[Stored]) -> Result[Stored, NoteError] {
  match found {
    Some(value) -> Ok(value)
    None -> Err(error: NotSaved)
  }
}

fn found(note: Option[Note]) -> Result[Note, NoteError] {
  match note {
    Some(value) -> Ok(value)
    None -> Err(error: NoNote)
  }
}

invariant "a note has been saved at least once" {
  SELECT key, revision FROM notes WHERE revision < 1
}
