// The todo task's acceptance requests, written from tasks/todo.md alone.
import { check, field, json, problem, req, status } from '../lib.ts';
import type { Grader } from '../lib.ts';

const todo = (j: unknown, id: number, title: string, done: boolean): boolean =>
  field(j, 'id') === id && field(j, 'title') === title && field(j, 'done') === done;
const ids = (j: unknown): number[] | null => (Array.isArray(j) ? j.map(t => Number(field(t, 'id'))) : null);
const same = (a: number[] | null, b: number[]): boolean => a !== null && a.join(',') === b.join(',');

export const grader: Grader = {
  task: 'todo',
  scenarios: [
    {
      name: 'empty list',
      requests: [req('GET', '/todos')],
      checks: ([a]) => [json('GET /todos with none is []', a, [200], j => Array.isArray(j) && j.length === 0)],
    },
    {
      name: 'create, read, update, filter, delete',
      requests: [
        req('POST', '/todos', { title: 'Buy milk' }),
        req('POST', '/todos', { title: 'Walk dog' }),
        req('POST', '/todos', { title: 'Buy milk' }),
        req('GET', '/todos/1'),
        req('GET', '/todos/99'),
        req('GET', '/todos/abc'),
        req('GET', '/todos'),
        req('PATCH', '/todos/2', { done: true }),
        req('PATCH', '/todos/1', { title: 'Buy oat milk' }),
        req('GET', '/todos?done=true'),
        req('GET', '/todos?done=false'),
        req('GET', '/todos?done=maybe'),
        req('DELETE', '/todos/3'),
        req('DELETE', '/todos/3'),
        req('GET', '/todos/3'),
        req('GET', '/todos'),
        req('PATCH', '/todos/99', { done: true }),
        req('GET', '/nope'),
      ],
      checks: r => [
        json('POST answers 201 and the todo, id 1', r[0], [201], j => todo(j, 1, 'Buy milk', false)),
        json('second POST is id 2', r[1], [201], j => todo(j, 2, 'Walk dog', false)),
        json('same title again is a new todo, id 3', r[2], [201], j => todo(j, 3, 'Buy milk', false)),
        json('GET /todos/1', r[3], [200], j => todo(j, 1, 'Buy milk', false)),
        problem('GET of a missing id is 404 with an error', r[4], 404),
        status('GET of a non-numeric id is 404', r[5], 404),
        json('GET /todos lists 1,2,3', r[6], [200], j => same(ids(j), [1, 2, 3])),
        json('PATCH done answers the whole todo', r[7], [200], j => todo(j, 2, 'Walk dog', true)),
        json('PATCH title keeps done', r[8], [200], j => todo(j, 1, 'Buy oat milk', false)),
        json('?done=true filters', r[9], [200], j => same(ids(j), [2])),
        json('?done=false filters', r[10], [200], j => same(ids(j), [1, 3])),
        problem('?done=maybe is 400', r[11], 400),
        check('DELETE answers 204, empty body', r[12]?.status === 204 && r[12].body === '', r[12]?.body),
        problem('DELETE again is 404', r[13], 404),
        status('GET after DELETE is 404', r[14], 404),
        json('list after DELETE is 1,2', r[15], [200], j => same(ids(j), [1, 2])),
        problem('PATCH of a missing id is 404', r[16], 404),
        status('an unknown route is 404', r[17], 404),
      ],
    },
    {
      name: 'validation',
      requests: [
        req('POST', '/todos', {}),
        req('POST', '/todos', { title: '' }),
        req('POST', '/todos', { title: 'a'.repeat(101) }),
        req('POST', '/todos', { title: 'a'.repeat(100) }),
        req('POST', '/todos', { title: 5 }),
        req('POST', '/todos', '{title: '),
        req('POST', '/todos', '[1,2]'),
        req('PATCH', '/todos/1', {}),
        req('PATCH', '/todos/1', { done: 'yes' }),
        req('GET', '/todos'),
      ],
      checks: r => [
        problem('missing title is 400', r[0], 400),
        problem('empty title is 400', r[1], 400),
        problem('101-byte title is 400', r[2], 400),
        json('100-byte title is accepted', r[3], [201], j => todo(j, 1, 'a'.repeat(100), false)),
        problem('a number title is 400', r[4], 400),
        problem('a body that is not JSON is 400', r[5], 400),
        problem('a JSON array body is 400', r[6], 400),
        problem('PATCH with neither field is 400', r[7], 400),
        problem('PATCH with a non-boolean done is 400', r[8], 400),
        json('refused creates made nothing', r[9], [200], j => same(ids(j), [1])),
      ],
    },
  ],
};
