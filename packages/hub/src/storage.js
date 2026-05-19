// IndexedDB wrapper for the hub. Persists per-instance config (URLs,
// labels, colors, bearer tokens, display order) plus a tiny `settings`
// store for the active-instance pointer.
//
// Promise-based on top of the raw IDB request API. No external deps.

const DB_NAME = "spannora-hub";
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("instances")) {
        const s = db.createObjectStore("instances", { keyPath: "id" });
        s.createIndex("by_order", "order", { unique: false });
      }
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function reqDone(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getAll(store, indexName = null) {
  const db = await openDb();
  const tx = db.transaction(store, "readonly");
  const source = indexName ? tx.objectStore(store).index(indexName) : tx.objectStore(store);
  const rows = await reqDone(source.getAll());
  await txDone(tx);
  return rows;
}

export async function getOne(store, key) {
  const db = await openDb();
  const tx = db.transaction(store, "readonly");
  const row = await reqDone(tx.objectStore(store).get(key));
  await txDone(tx);
  return row;
}

export async function putOne(store, value) {
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  await reqDone(tx.objectStore(store).put(value));
  await txDone(tx);
  return value;
}

export async function deleteOne(store, key) {
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  await reqDone(tx.objectStore(store).delete(key));
  await txDone(tx);
}

export async function bulkPut(store, values) {
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  const s = tx.objectStore(store);
  for (const v of values) s.put(v);
  await txDone(tx);
}
