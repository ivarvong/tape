// The shortener task's acceptance requests, written from tasks/shortener.md alone. `run` does not give back response
// headers, so the Location header cannot be checked; the 302 and the body's `url` are.
import { field, json, problem, req, skip, status } from '../lib.ts';
import type { Grader } from '../lib.ts';

const link = (slug: string, url: string) => (j: unknown) => field(j, 'slug') === slug && field(j, 'url') === url;
const generated = (j: unknown): boolean => /^[A-Za-z0-9]{6}$/.test(String(field(j, 'slug')));
const shorten = (body: Record<string, unknown>) => req('POST', '/links', body);
const A = 'https://example.com/a';
const LONG = 'https://example.com/long/path?q=1';

const prefix = [shorten({ url: LONG }), shorten({ url: 'http://example.org/x' })];

export const grader: Grader = {
  task: 'shortener',
  scenarios: [
    {
      name: 'custom slugs, redirects and hits',
      requests: [
        shorten({ url: A, slug: 'my-page' }),
        shorten({ url: A, slug: 'my-page' }),
        shorten({ url: 'https://example.com/b', slug: 'my-page' }),
        req('GET', '/my-page'),
        req('GET', '/my-page'),
        req('GET', '/links/my-page'),
        req('GET', '/links/my-page'),
        req('GET', '/nope-slug'),
        req('GET', '/links/nope-slug'),
        shorten({ url: 'ftp://example.com/x' }),
        shorten({ url: 'example.com' }),
        shorten({ url: A, slug: 'ab' }),
        shorten({ url: A, slug: 'bad_slug!' }),
        shorten({ url: A, slug: 'a'.repeat(33) }),
        shorten({ url: `https://e.com/${'a'.repeat(2048 - 14 + 1)}` }),
        req('POST', '/links', '{"url": '),
        shorten({ url: A, slug: 'Abc-123' }),
        req('GET', '/links/my-page'),
      ],
      checks: r => [
        json('a new slug: 201', r[0], [201], link('my-page', A)),
        json('the same slug and URL again: 200', r[1], [200], link('my-page', A)),
        problem('a slug taken by another URL: 409', r[2], 409),
        json('GET /{slug}: 302 with the URL in the body', r[3], [302], j => field(j, 'url') === A),
        status('again: 302', r[4], 302),
        json('two redirects, two hits', r[5], [200], j => link('my-page', A)(j) && field(j, 'hits') === 2),
        json('GET /links counts no hit', r[6], [200], j => field(j, 'hits') === 2),
        problem('an unknown slug: 404', r[7], 404),
        problem("an unknown slug's stats: 404", r[8], 404),
        problem('ftp:// is 400', r[9], 400),
        problem('no scheme is 400', r[10], 400),
        problem('a 2-character slug is 400', r[11], 400),
        problem('a slug with _ and ! is 400', r[12], 400),
        problem('a 33-character slug is 400', r[13], 400),
        problem('a 2049-byte URL is 400', r[14], 400),
        problem('a body that is not JSON is 400', r[15], 400),
        json('capitals, digits and - in a slug are fine', r[16], [201], link('Abc-123', A)),
        json('hits still 2', r[17], [200], j => field(j, 'hits') === 2),
      ],
    },
    {
      name: 'generated slugs',
      requests: [...prefix, shorten({ url: LONG })],
      checks: r => [
        json('no slug: 201 and a 6-character slug', r[0], [201], j => generated(j) && field(j, 'url') === LONG),
        json(
          'another URL: another slug',
          r[1],
          [201],
          j => generated(j) && field(j, 'slug') !== field(r[0]?.json, 'slug'),
        ),
        json(
          'the same URL again: 200, the same slug',
          r[2],
          [200],
          j => field(j, 'slug') === field(r[0]?.json, 'slug'),
        ),
      ],
      // The slug is only known from an answer, so it is looked up in a second call that makes the links again.
      followup: first => {
        const slug = String(field(first[0]?.json, 'slug'));
        return {
          name: 'generated slugs redirect',
          requests: [...prefix, req('GET', `/${slug}`), req('GET', `/links/${slug}`)],
          checks: r => {
            if (String(field(r[0]?.json, 'slug')) !== slug)
              return [skip('a generated slug redirects', 'the slug differs between two calls')];
            return [
              json('a generated slug redirects: 302', r[2], [302], j => field(j, 'url') === LONG),
              json('and counts a hit', r[3], [200], j => field(j, 'hits') === 1),
            ];
          },
        };
      },
    },
  ],
};
