const http = require("http");
const { URL } = require("url");
const fs = require("fs/promises");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "stroyinvest-secret-token";
const DATA_FILE = path.join(__dirname, "data", "products.json");
const ANALYTICS_FILE = path.join(__dirname, "data", "analytics.json");
const SITE_FILE = path.join(__dirname, "index.html");
const ADMIN_FILE = path.join(__dirname, "stroyinvest-admin.html");
const FALLBACK_IMG = "https://placehold.co/600x340/111827/f6c141?text=Товар";

const send = (res, code, payload) => {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS"
  });
  res.end(JSON.stringify(payload));
};
const ok = (res, payload) => send(res, 200, payload);
const fail = (res, code, error) => send(res, code, { error });

function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function getClientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  return (Array.isArray(xf) ? xf[0] : (xf || req.socket.remoteAddress || "unknown")).toString().split(",")[0].trim();
}

function emptyAnalytics() {
  return {
    totals: { visits: 0, uniqueVisitors: 0, pageViews: 0, productViews: 0, cartAdds: 0 },
    visitors: {},
    productViewsById: {},
    daily: {},
    recentEvents: []
  };
}

async function readJsonFile(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonFile(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2), "utf8");
}

async function readProducts() {
  return readJsonFile(DATA_FILE, []);
}

async function writeProducts(list) {
  await writeJsonFile(DATA_FILE, list);
}

async function readAnalytics() {
  return readJsonFile(ANALYTICS_FILE, emptyAnalytics());
}

async function writeAnalytics(data) {
  await writeJsonFile(ANALYTICS_FILE, data);
}

function adminOnly(req, res) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (token !== ADMIN_TOKEN) {
    fail(res, 401, "Требуется авторизация администратора");
    return false;
  }
  return true;
}

function getBody(req) {
  return new Promise((resolve, reject) => {
    let d = "";
    req.on("data", c => d += c);
    req.on("end", () => {
      if (!d) return resolve({});
      try { resolve(JSON.parse(d)); } catch { reject(new Error("Невалидный JSON")); }
    });
    req.on("error", reject);
  });
}

function normalizeImages(body = {}) {
  const raw = Array.isArray(body.images) ? body.images : [];
  const withSingle = body.img ? [String(body.img)] : [];
  const merged = [...raw, ...withSingle].map(v => String(v || "").trim()).filter(Boolean);
  const uniq = [...new Set(merged)];
  return uniq.length ? uniq : [FALLBACK_IMG];
}

function normalizeProducts(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((p, i) => {
      const images = normalizeImages(p);
      return {
        id: Number(p.id) || i + 1,
        title: String(p.title || "").trim(),
        type: String(p.type || "").trim(),
        price: Number(p.price) || 0,
        unit: String(p.unit || "₽/шт"),
        images,
        img: images[0]
      };
    })
    .filter(p => p.title && p.type && p.price > 0);
}

async function trackEvent(req, type, payload = {}) {
  const data = await readAnalytics();
  const key = dayKey();
  const ip = getClientIp(req);
  if (!data.daily[key]) data.daily[key] = { visits: 0, pageViews: 0, productViews: 0, cartAdds: 0 };

  const event = { type, ip, at: new Date().toISOString(), ...payload };
  data.recentEvents.unshift(event);
  data.recentEvents = data.recentEvents.slice(0, 200);

  if (type === "visit") {
    data.totals.visits += 1;
    data.daily[key].visits += 1;
    if (!data.visitors[ip]) {
      data.visitors[ip] = { firstSeen: event.at, lastSeen: event.at, visits: 1 };
      data.totals.uniqueVisitors += 1;
    } else {
      data.visitors[ip].lastSeen = event.at;
      data.visitors[ip].visits += 1;
    }
  }
  if (type === "page_view") {
    data.totals.pageViews += 1;
    data.daily[key].pageViews += 1;
  }
  if (type === "product_view") {
    data.totals.productViews += 1;
    data.daily[key].productViews += 1;
    const id = String(payload.productId || "unknown");
    data.productViewsById[id] = (data.productViewsById[id] || 0) + 1;
  }
  if (type === "cart_add") {
    data.totals.cartAdds += 1;
    data.daily[key].cartAdds += 1;
  }

  await writeAnalytics(data);
}

http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathName = url.pathname;
  const idMatch = pathName.match(/^\/api\/products\/(\d+)$/);

  try {
    if (req.method === "GET" && (pathName === "/" || pathName === "/index.html")) {
      await trackEvent(req, "visit");
      const html = await fs.readFile(SITE_FILE, "utf8").catch(() => fs.readFile(ADMIN_FILE, "utf8"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    }
    if (req.method === "GET" && pathName === "/admin") {
      const html = await fs.readFile(ADMIN_FILE, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    }

    if (req.method === "GET" && pathName === "/api/health") return ok(res, { ok: true });
    if (req.method === "POST" && pathName === "/api/auth") {
      const body = await getBody(req);
      if ((body.password || "") !== ADMIN_PASSWORD) return fail(res, 401, "Неверный пароль");
      return ok(res, { token: ADMIN_TOKEN });
    }

    if (req.method === "GET" && pathName === "/api/products") return ok(res, { products: await readProducts() });
    if (req.method === "GET" && pathName === "/api/products/export") {
      if (!adminOnly(req, res)) return;
      return ok(res, { products: await readProducts() });
    }

    if (req.method === "GET" && pathName === "/api/stats") {
      if (!adminOnly(req, res)) return;
      const list = await readProducts();
      const analytics = await readAnalytics();
      const prices = list.map(p => Number(p.price) || 0);
      const sum = prices.reduce((a, b) => a + b, 0);
      const topProducts = Object.entries(analytics.productViewsById || {})
        .map(([id, views]) => {
          const p = list.find(x => String(x.id) === id);
          return { id: Number(id), title: p?.title || `ID ${id}`, views };
        })
        .sort((a, b) => b.views - a.views)
        .slice(0, 5);

      return ok(res, {
        total: list.length,
        avgPrice: list.length ? sum / list.length : 0,
        minPrice: list.length ? Math.min(...prices) : 0,
        maxPrice: list.length ? Math.max(...prices) : 0,
        analytics: analytics.totals,
        topProducts,
        recentEvents: analytics.recentEvents.slice(0, 10),
        daily: analytics.daily
      });
    }

    if (req.method === "POST" && pathName === "/api/track") {
      const body = await getBody(req);
      const type = String(body.type || "");
      if (!type) return fail(res, 400, "type обязателен");
      await trackEvent(req, type, body.payload || {});
      return ok(res, { tracked: true });
    }

    if (req.method === "POST" && pathName === "/api/products") {
      if (!adminOnly(req, res)) return;
      const body = await getBody(req);
      const { title, type, price, unit } = body;
      if (!title || !type || !price || !unit) return fail(res, 400, "Заполните title/type/price/unit");
      const list = await readProducts();
      const id = list.length ? Math.max(...list.map(p => p.id)) + 1 : 1;
      const images = normalizeImages(body);
      const item = { id, title, type, price: Number(price), unit, images, img: images[0] };
      list.unshift(item);
      await writeProducts(list);
      return ok(res, { product: item });
    }

    if (req.method === "PUT" && idMatch) {
      if (!adminOnly(req, res)) return;
      const id = Number(idMatch[1]);
      const body = await getBody(req);
      const list = await readProducts();
      const idx = list.findIndex(p => p.id === id);
      if (idx < 0) return fail(res, 404, "Товар не найден");
      const images = normalizeImages({ ...list[idx], ...body });
      list[idx] = {
        ...list[idx],
        ...body,
        id,
        price: Number(body.price ?? list[idx].price),
        images,
        img: images[0]
      };
      await writeProducts(list);
      return ok(res, { product: list[idx] });
    }

    if (req.method === "DELETE" && idMatch) {
      if (!adminOnly(req, res)) return;
      const id = Number(idMatch[1]);
      const list = await readProducts();
      const next = list.filter(p => p.id !== id);
      if (next.length === list.length) return fail(res, 404, "Товар не найден");
      await writeProducts(next);
      return ok(res, { deleted: id });
    }

    if (req.method === "POST" && pathName === "/api/products/import") {
      if (!adminOnly(req, res)) return;
      const body = await getBody(req);
      const cleaned = normalizeProducts(body.products);
      if (!cleaned.length) return fail(res, 400, "Пустой или невалидный список товаров");
      const withIds = cleaned.map((p, i) => ({ ...p, id: i + 1 }));
      await writeProducts(withIds);
      return ok(res, { imported: withIds.length });
    }

    return fail(res, 404, "Not found");
  } catch (e) {
    return fail(res, 500, e.message || "Server error");
  }
}).listen(PORT, () => {
  console.log(`API running on http://localhost:${PORT}`);
  console.log(`Admin password: ${ADMIN_PASSWORD}`);
});
