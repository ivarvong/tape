// The sales report task's acceptance requests, written from tasks/sales.md alone.
import { check, field, json, problem, req, status } from '../lib.ts';
import type { Grader, Res } from '../lib.ts';

const sale = (sale_id: string, region: string, product: string, quantity: unknown, unit_price_cents: unknown) =>
  req('POST', '/sales', { sale_id, region, product, quantity, unit_price_cents });
type Row = [region: string, orders: number, units: number, revenue: number];
type PRow = [region: string, product: string, orders: number, units: number, revenue: number];
const rows = (want: Row[]) => (j: unknown) =>
  Array.isArray(j) &&
  j.length === want.length &&
  want.every(
    ([region, orders, units, revenue], i) =>
      field(j[i], 'region') === region &&
      field(j[i], 'orders') === orders &&
      field(j[i], 'units') === units &&
      field(j[i], 'revenue_cents') === revenue,
  );
const prows = (want: PRow[]) => (j: unknown) =>
  Array.isArray(j) &&
  j.length === want.length &&
  want.every(
    ([region, product, orders, units, revenue], i) =>
      field(j[i], 'region') === region &&
      field(j[i], 'product') === product &&
      field(j[i], 'orders') === orders &&
      field(j[i], 'units') === units &&
      field(j[i], 'revenue_cents') === revenue,
  );
const csv = (name: string, r: Res | undefined, want: string) =>
  check(
    name,
    r?.status === 200 && r.body === want,
    `want 200 ${JSON.stringify(want)}, got ${r?.status} ${JSON.stringify(r?.body)}`,
  );
const HEAD = 'region,orders,units,revenue_cents\n';

export const grader: Grader = {
  task: 'sales',
  scenarios: [
    {
      name: 'sales and reports',
      requests: [
        sale('s-1', 'emea', 'widget', 3, 250),
        sale('s-1', 'emea', 'widget', 3, 250),
        sale('s-2', 'amer', 'widget', 2, 250),
        sale('s-3', 'amer', 'gadget', 3, 250),
        sale('s-4', 'apac', 'widget', 1, 0),
        req('GET', '/report'),
        req('GET', '/report?format=json'),
        req('GET', '/report?format=csv'),
        req('GET', '/report?region=amer&format=csv'),
        req('GET', '/report?format=csv&region=amer'),
        req('GET', '/report?region=zzz'),
        req('GET', '/report?group=product'),
        req('GET', '/report?group=product&format=csv'),
        req('GET', '/report?format=xml'),
        req('GET', '/report?group=customer'),
        req('GET', '/nope'),
      ],
      checks: r => {
        const all: Row[] = [
          ['amer', 2, 5, 1250],
          ['apac', 1, 1, 0],
          ['emea', 1, 3, 750],
        ];
        return [
          json('a sale: 201', r[0], [201], j => field(j, 'sale_id') === 's-1'),
          json('the same sale again: 200', r[1], [200], j => field(j, 'sale_id') === 's-1'),
          status('more sales: 201', r[2], 201),
          status('a sale of a price of 0: 201', r[4], 201),
          json('GET /report: JSON rows by region, the retry counted once', r[5], [200], rows(all)),
          json('format=json: the same', r[6], [200], rows(all)),
          csv('format=csv', r[7], `${HEAD}amer,2,5,1250\napac,1,1,0\nemea,1,3,750\n`),
          csv('region=amer&format=csv', r[8], `${HEAD}amer,2,5,1250\n`),
          csv('parameters in the other order', r[9], `${HEAD}amer,2,5,1250\n`),
          json('a region with no sales: []', r[10], [200], rows([])),
          json(
            'group=product',
            r[11],
            [200],
            prows([
              ['amer', 'gadget', 1, 3, 750],
              ['amer', 'widget', 1, 2, 500],
              ['apac', 'widget', 1, 1, 0],
              ['emea', 'widget', 1, 3, 750],
            ]),
          ),
          csv(
            'group=product&format=csv',
            r[12],
            'region,product,orders,units,revenue_cents\namer,gadget,1,3,750\namer,widget,1,2,500\napac,widget,1,1,0\nemea,widget,1,3,750\n',
          ),
          problem('format=xml: 400', r[13], 400),
          problem('group=customer: 400', r[14], 400),
          status('an unknown route: 404', r[15], 404),
        ];
      },
    },
    {
      name: 'validation and an empty report',
      requests: [
        sale('v-1', 'EMEA', 'widget', 1, 1),
        sale('v-2', 'emea', 'widget', 0, 1),
        sale('v-3', 'emea', 'widget', 10001, 1),
        sale('v-4', 'emea', 'widget', 1, -1),
        req('POST', '/sales', { sale_id: 'v-5', region: 'emea', quantity: 1, unit_price_cents: 1 }),
        req('POST', '/sales', 'region=emea'),
        sale('', 'emea', 'widget', 1, 1),
        sale('v-8', 'emea', 'widget', '1', 1),
        req('GET', '/report?format=csv'),
        req('GET', '/report'),
      ],
      checks: r => [
        problem('a region with capitals: 400', r[0], 400),
        problem('quantity 0: 400', r[1], 400),
        problem('quantity 10001: 400', r[2], 400),
        problem('a negative price: 400', r[3], 400),
        problem('a missing product: 400', r[4], 400),
        problem('a body that is not JSON: 400', r[5], 400),
        problem('an empty sale_id: 400', r[6], 400),
        problem('a quantity that is a string: 400', r[7], 400),
        csv('no sales: the CSV header alone', r[8], HEAD),
        json('no sales: []', r[9], [200], rows([])),
      ],
    },
    {
      name: 'large totals',
      requests: [
        sale('b-1', 'emea', 'server', 10000, 10000000),
        sale('b-2', 'emea', 'server', 10000, 10000000),
        req('GET', '/report?format=csv'),
      ],
      checks: r => [csv('10000 x 10000000, twice', r[2], `${HEAD}emea,2,20000,200000000000\n`)],
    },
  ],
};
