// Broken Shop: a tiny Persian shop used to demo Hamyar.
// Faults are switched with the FAULT env var (comma separated):
//   memory_leak  every request keeps 5 MB in memory forever
//   slow         /products runs one "query" per product (N+1), ~150 ms each
//   bad_release  the home page crashes with a TypeError
// DATABASE_URL is required; without it every page returns 500.
const express = require('express');

const app = express();
const faults = new Set((process.env.FAULT || '').split(',').map((f) => f.trim()).filter(Boolean));
const leaked = [];

const products = [
  { id: 1, name: 'ماگ سرامیکی', price: 180000 },
  { id: 2, name: 'دفترچه یادداشت', price: 95000 },
  { id: 3, name: 'هدفون بی‌سیم', price: 1450000 },
  { id: 4, name: 'کیف لپ‌تاپ', price: 780000 },
  { id: 5, name: 'چراغ مطالعه', price: 520000 },
  { id: 6, name: 'فلاسک', price: 340000 },
  { id: 7, name: 'ماوس', price: 410000 },
  { id: 8, name: 'کیبورد', price: 960000 },
  { id: 9, name: 'پاوربانک', price: 690000 },
  { id: 10, name: 'کوله‌پشتی', price: 1150000 },
  { id: 11, name: 'ساعت دیواری', price: 620000 },
  { id: 12, name: 'گلدان', price: 210000 },
  { id: 13, name: 'خودکار', price: 45000 },
  { id: 14, name: 'کتاب', price: 230000 },
  { id: 15, name: 'تی‌شرت', price: 390000 },
  { id: 16, name: 'کلاه', price: 160000 },
  { id: 17, name: 'جاکلیدی', price: 70000 },
  { id: 18, name: 'قاب گوشی', price: 150000 },
  { id: 19, name: 'شارژر', price: 280000 },
  { id: 20, name: 'بطری آب', price: 120000 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function db() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set: cannot connect to the database');
  return {
    async query(sql) {
      console.log(`[db] ${sql}`);
      await sleep(faults.has('slow') ? 150 : 2);
      return sql.includes('prices') ? [{ discount: 0 }] : products;
    },
  };
}

app.use((req, res, next) => {
  const started = Date.now();
  if (faults.has('memory_leak')) {
    leaked.push(Buffer.alloc(5 * 1024 * 1024, 1));
    const mb = Math.round(process.memoryUsage().rss / 1024 / 1024);
    console.log(`[mem] rss=${mb}MB cached_items=${leaked.length}`);
  }
  res.on('finish', () => {
    console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - started}ms`);
  });
  next();
});

app.get('/health', (req, res) => res.json({ ok: true }));

async function loadProducts() {
  const conn = db();
  const rows = await conn.query('SELECT * FROM products');
  if (!faults.has('slow')) return rows;
  // N+1: one extra query per product instead of a single JOIN
  for (const row of rows) {
    await conn.query(`SELECT * FROM prices WHERE product_id = ${row.id}`);
  }
  return rows;
}

app.get('/products', async (req, res, next) => {
  try {
    res.json(await loadProducts());
  } catch (err) {
    next(err);
  }
});

app.get('/', async (req, res, next) => {
  try {
    const rows = await loadProducts();
    const featured = faults.has('bad_release') ? rows.find((p) => p.id === 999) : rows[0];
    const items = rows
      .map((p) => `<li>${p.name} — ${p.price.toLocaleString('fa-IR')} تومان</li>`)
      .join('');
    res.send(`<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8">
<title>فروشگاه</title><body style="font-family:Tahoma;max-width:640px;margin:40px auto">
<h1>فروشگاه نمونه</h1><p>پیشنهاد ویژه: ${featured.name}</p><ul>${items}</ul></body></html>`);
  } catch (err) {
    next(err);
  }
});

app.use((err, req, res, next) => {
  console.error(`[error] ${req.method} ${req.path}: ${err.stack}`);
  res.status(500).send('خطای داخلی سرور');
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Broken Shop listening on port ${port} faults=[${[...faults].join(',') || 'none'}]`);
});
