// The invoice task's acceptance requests, written from tasks/invoice.md alone. Every expected amount was worked by
// hand from the spec's rules (exact line totals, one rounding of the tax, half away from zero).
import { field, json, problem, req, status } from '../lib.ts';
import type { Grader } from '../lib.ts';

type Line = { description: string; quantity: unknown; unit_price: unknown };
const line = (quantity: unknown, unit_price: unknown, description = 'Item'): Line => ({
  description,
  quantity,
  unit_price,
});
const post = (invoice_id: string, currency: string, tax_rate: unknown, lines: Line[]) =>
  req('POST', '/invoices', { invoice_id, currency, tax_rate, lines });
const invoice =
  (id: string, currency: string, lineTotals: string[], subtotal: string, tax: string, total: string) =>
  (j: unknown) => {
    const lines = field(j, 'lines');
    return (
      field(j, 'invoice_id') === id &&
      field(j, 'currency') === currency &&
      Array.isArray(lines) &&
      lines.length === lineTotals.length &&
      lineTotals.every((t, i) => field(lines[i], 'line_total') === t) &&
      field(j, 'subtotal') === subtotal &&
      field(j, 'tax') === tax &&
      field(j, 'total') === total
    );
  };
const INV1 = [line(3, '19.99', 'Widget'), line(1, '0.05', 'Sticker')];
const inv1 = invoice('inv-1', 'USD', ['59.97', '0.05'], '60.02', '5.33', '65.35');

export const grader: Grader = {
  task: 'invoice',
  scenarios: [
    {
      name: 'exact totals',
      requests: [
        post('inv-1', 'USD', '8.875', INV1),
        post('inv-1', 'USD', '8.875', INV1),
        req('GET', '/invoices/inv-1'),
        req('GET', '/invoices/nope'),
        post('inv-2', 'USD', '1.25', [line(1, '10.00')]),
        post('inv-3', 'JPY', '10', [line(2, '1500')]),
        post('inv-4', 'JPY', '8.5', [line(1, '999')]),
        post('inv-5', 'USD', '0', [line(2, '1.5')]),
        post('inv-6', 'EUR', '0', [line(1000, '9999.99')]),
        post('inv-7', 'EUR', '20', [line(3, '3')]),
        post('inv-8', 'USD', '50', [line(1, '0.01')]),
        post('inv-9', 'USD', '7.125', [line(7, '0.07')]),
        post('inv-10', 'USD', '100', [line(1000000, '100000000')]),
        post('inv-11', 'USD', '8.25', [line(2, '0.10'), line(3, '0.20')]),
      ],
      checks: r => [
        json("the spec's example: 201", r[0], [201], inv1),
        json('a retry: 200, the same invoice', r[1], [200], inv1),
        json('GET the stored invoice', r[2], [200], inv1),
        problem('an unknown invoice: 404', r[3], 404),
        json(
          '10.00 at 1.25%: tax 0.125 rounds up to 0.13',
          r[4],
          [201],
          invoice('inv-2', 'USD', ['10.00'], '10.00', '0.13', '10.13'),
        ),
        json('JPY: no decimals', r[5], [201], invoice('inv-3', 'JPY', ['3000'], '3000', '300', '3300')),
        json(
          'JPY 999 at 8.5%: 84.915 rounds to 85',
          r[6],
          [201],
          invoice('inv-4', 'JPY', ['999'], '999', '85', '1084'),
        ),
        json(
          '"1.5" is written 2 decimals: 3.00, tax 0.00',
          r[7],
          [201],
          invoice('inv-5', 'USD', ['3.00'], '3.00', '0.00', '3.00'),
        ),
        json(
          '1000 x 9999.99 = 9999990.00',
          r[8],
          [201],
          invoice('inv-6', 'EUR', ['9999990.00'], '9999990.00', '0.00', '9999990.00'),
        ),
        json('EUR 3 x "3" at 20%', r[9], [201], invoice('inv-7', 'EUR', ['9.00'], '9.00', '1.80', '10.80')),
        json(
          '0.01 at 50%: 0.005 rounds to 0.01',
          r[10],
          [201],
          invoice('inv-8', 'USD', ['0.01'], '0.01', '0.01', '0.02'),
        ),
        json(
          '0.49 at 7.125%: 0.0349125 rounds to 0.03',
          r[11],
          [201],
          invoice('inv-9', 'USD', ['0.49'], '0.49', '0.03', '0.52'),
        ),
        json(
          'the largest line at 100%: no overflow',
          r[12],
          [201],
          invoice(
            'inv-10',
            'USD',
            ['100000000000000.00'],
            '100000000000000.00',
            '100000000000000.00',
            '200000000000000.00',
          ),
        ),
        json(
          'two lines summed, then taxed once',
          r[13],
          [201],
          invoice('inv-11', 'USD', ['0.20', '0.60'], '0.80', '0.07', '0.87'),
        ),
      ],
    },
    {
      name: 'validation',
      requests: [
        post('v-1', 'USD', '0', [line(1, '19.999')]),
        post('v-2', 'JPY', '0', [line(1, '12.5')]),
        post('v-3', 'USD', '0', [line(1, 'abc')]),
        post('v-4', 'USD', '0', [line(1, '-1.00')]),
        post('v-5', 'USD', '0', [line(1, 19.99)]),
        post('v-6', 'USD', '0', [line(0, '1.00')]),
        post('v-7', 'GBP', '0', [line(1, '1.00')]),
        post('v-8', 'USD', '0', []),
        post('v-9', 'USD', '8.8755', [line(1, '1.00')]),
        post('v-10', 'USD', '101', [line(1, '1.00')]),
        post('v-11', 'USD', '0', [line(1, '1e3')]),
        req('POST', '/invoices', { currency: 'USD', tax_rate: '0', lines: [line(1, '1.00')] }),
        req('POST', '/invoices', '{"invoice_id": '),
        req('GET', '/invoices/v-1'),
        post('v-ok', 'USD', '0', [line(1, '1')]),
        req('GET', '/nope'),
      ],
      checks: r => [
        problem('3 decimals in USD: 400', r[0], 400),
        problem('decimals in JPY: 400', r[1], 400),
        problem('"abc": 400', r[2], 400),
        problem('a negative price: 400', r[3], 400),
        problem('a JSON number price: 400', r[4], 400),
        problem('quantity 0: 400', r[5], 400),
        problem('an unknown currency: 400', r[6], 400),
        problem('no lines: 400', r[7], 400),
        problem('a tax rate with 4 decimals: 400', r[8], 400),
        problem('a tax rate over 100: 400', r[9], 400),
        problem('"1e3": 400', r[10], 400),
        problem('no invoice_id: 400', r[11], 400),
        problem('a body that is not JSON: 400', r[12], 400),
        problem('a refused invoice was not stored', r[13], 404),
        json('"1" in USD is 1.00', r[14], [201], invoice('v-ok', 'USD', ['1.00'], '1.00', '0.00', '1.00')),
        status('an unknown route: 404', r[15], 404),
      ],
    },
  ],
};
