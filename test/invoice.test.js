const assert = require('node:assert/strict');
const test = require('node:test');
const coupons = require('../lib/coupons');
const invoice = require('../lib/invoice');
const pricing = require('../lib/pricing');
const reports = require('../lib/reports');

function item(hsn, price, id = 1) {
  return { id, name: 'Test item ' + id, hsn, price, qty: 1 };
}

function billedOrder(items, coupon = '', id = 1) {
  const { subtotal, discount, tax, total } = pricing.computeTotals(items, coupon);
  return { id, items, coupon, subtotal, discount, tax, total };
}

test('invoice matches the billed total and GST for a mixed-slab order with capped SAVE10', function () {
  const order = billedOrder([
    { ...item('1006', 640), qty: 2 },
    { ...item('0405', 260, 2), qty: 4 }
  ], 'SAVE10');
  const figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual({ discount: order.discount, tax: order.tax, total: order.total }, {
    discount: 150, tax: 176.59, total: 2346.59
  });
  assert.deepEqual({
    discount: figures.discount,
    tax: figures.tax,
    total: figures.total,
    lineGst: figures.rows.map(({ gstPercent, lineTax }) => [gstPercent, lineTax])
  }, {
    discount: 150, tax: 176.59, total: 2346.59, lineGst: [[5, 59.86], [12, 116.73]]
  });
});

test('an order with no configured GST slab or coupon matches its invoice', function () {
  const order = billedOrder([item('9999', 100)]);
  const figures = invoice.computeInvoiceFigures(order);

  assert.equal(order.total, 118);
  assert.equal(figures.total, 118);
  assert.equal(figures.tax, 18);
  assert.equal(figures.rows[0].gstPercent, 18);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('invoices use HSN slabs on ordinary order lines', function () {
  const order = billedOrder([item('1006', 100), item('0405', 100, 2)]);
  const figures = invoice.computeInvoiceFigures(order);

  assert.equal(order.tax, 17);
  assert.equal(order.total, 217);
  assert.deepEqual(figures.rows.map(({ gstPercent, lineTax }) => [gstPercent, lineTax]), [
    [5, 5],
    [12, 12]
  ]);
  assert.deepEqual([figures.tax, figures.cgst, figures.sgst, figures.total], [17, 8.5, 8.5, 217]);
});

test('invoices apply capped percentage coupons before GST', function () {
  const items = [item('1006', 1000), item('0405', 1000, 2)];
  const order = billedOrder(items, 'SAVE10');
  const checkout = pricing.computeTotals(items, order.coupon);
  const figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual(checkout.lines.map(({ discount, tax }) => [discount, tax]), [
    [75, 46.25],
    [75, 111]
  ]);
  assert.deepEqual([checkout.cgst, checkout.sgst], [78.63, 78.62]);
  assert.deepEqual([order.discount, order.tax, order.total], [150, 157.25, 2007.25]);
  assert.deepEqual([figures.cgst, figures.sgst], [78.63, 78.62]);
  assert.deepEqual([figures.discount, figures.tax, figures.total], [150, 157.25, 2007.25]);
});

test('invoices ignore saved coupons that checkout pricing would reject', function () {
  const cases = [
    { code: 'FLAT50', price: 100, total: 118 },
    { code: 'DIWALI20', price: 1200, total: 1416 }
  ];

  for (const { code, price, total } of cases) {
    const order = { ...billedOrder([item('9999', price)]), coupon: code };
    const figures = invoice.computeInvoiceFigures(order);
    const html = invoice.render(order);

    assert.equal(coupons.validate(code, order.subtotal).valid, false, code);
    assert.equal(order.discount, 0, code);
    assert.equal(order.total, total, code);
    assert.equal(figures.discount, 0, code);
    assert.equal(figures.total, total, code);
    assert.ok(html.includes('Promo Applied:</strong><br>None'), code);
    assert.doesNotMatch(html, /Coupon Discount/, code);
  }
});

test('invoices apply decimal and zero GST overrides the same way as checkout', function () {
  const items = [
    { ...item('1006', 100), gstRate: 0.05 },
    { ...item('0405', 100, 2), gstRate: 0 }
  ];
  const order = billedOrder(items);
  const figures = invoice.computeInvoiceFigures(order);

  assert.equal(order.tax, 5);
  assert.equal(order.total, 205);
  assert.deepEqual(figures.rows.map(({ gstPercent, lineTax }) => [gstPercent, lineTax]), [
    [5, 5],
    [0, 0]
  ]);
  assert.equal(figures.tax, 5);
  assert.equal(figures.total, 205);
});

test('invoice GST adds up the displayed rounded line taxes', function () {
  const order = billedOrder([item('9999', 0.03), item('9999', 0.03, 2)]);
  const figures = invoice.computeInvoiceFigures(order);

  assert.equal(order.tax, 0.02);
  assert.equal(order.total, 0.08);
  assert.deepEqual(figures.rows.map(({ lineTax }) => lineTax), [0.01, 0.01]);
  assert.equal(figures.tax, 0.02);
  assert.equal(figures.total, 0.08);
});

test('printable HTML shows the billed GST and total without a mismatch warning', function () {
  const order = billedOrder([item('1006', 100)]);
  const html = invoice.render(order);

  assert.match(html, />5%<\/td><td[^>]*>₹5\.00<\/td>/);
  assert.match(html, /Invoice Total<\/td><td[^>]*>₹105\.00<\/td>/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});

test('printable HTML warns when the saved total differs from the invoice', function () {
  const order = { ...billedOrder([item('1006', 100)]), total: 104 };

  assert.match(invoice.render(order), /Accountant Reconciliation Notice:.*₹105\.00.*₹104\.00.*\+₹1\.00/);
});

test('reconciliation skips cancellations and adds the absolute value of each total difference', function () {
  const items = [item('1006', 100)];
  const positive = { ...billedOrder(items, '', 1), total: 100 };
  const negative = { ...billedOrder(items, '', 2), total: 107 };
  const matched = billedOrder(items, '', 3);
  const cancelled = { ...positive, id: 4, status: 'cancelled' };
  const result = reports.getGstReconciliation({ orders: [positive, negative, matched, cancelled] });

  assert.equal(result.totalChecked, 3);
  assert.equal(result.mismatchCount, 2);
  assert.equal(result.totalDelta, 7);
  assert.deepEqual(result.rows.map(({ orderId, delta, matched }) => [orderId, delta, matched]), [
    [1, 5, false],
    [2, -2, false],
    [3, 0, true]
  ]);
});

test('CURRENT BEHAVIOUR: a GST-only mismatch appears in reconciliation without an invoice warning', function () {
  const order = { ...billedOrder([item('9999', 100)]), tax: 17 };
  const result = reports.getGstReconciliation({ orders: [order] });
  const row = result.rows[0];

  assert.equal(row.ledgerTotal, 118);
  assert.equal(row.invoiceTotal, 118);
  assert.equal(row.ledgerTax, 17);
  assert.equal(row.invoiceTax, 18);
  assert.equal(row.matched, false);
  assert.equal(result.mismatchCount, 1);
  assert.equal(result.totalDelta, 0);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});
