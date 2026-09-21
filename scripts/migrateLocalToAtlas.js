/**
 * Copy all collections from local MongoDB → Atlas (MONGODB_URI in .env).
 * Usage: LOCAL_MONGODB_URI=mongodb://127.0.0.1:27017/scentinova node scripts/migrateLocalToAtlas.js
 */
import "dotenv/config";
import mongoose from "mongoose";

const LOCAL_URI =
  process.env.LOCAL_MONGODB_URI || "mongodb://127.0.0.1:27017/scentinova";
const ATLAS_URI = process.env.MONGODB_URI;

if (!ATLAS_URI || ATLAS_URI.includes("127.0.0.1") || ATLAS_URI.includes("localhost")) {
  console.error("MONGODB_URI must point to Atlas (not localhost).");
  process.exit(1);
}

const SYSTEM = new Set(["system.indexes", "system.profile", "system.users", "system.views"]);

async function copyDb() {
  console.log("Connecting to local…");
  const local = await mongoose.createConnection(LOCAL_URI).asPromise();
  console.log("Connecting to Atlas…");
  const atlas = await mongoose.createConnection(ATLAS_URI).asPromise();

  const collections = (await local.db.listCollections().toArray())
    .map((c) => c.name)
    .filter((n) => !SYSTEM.has(n) && !n.startsWith("system."));

  if (collections.length === 0) {
    console.log("Local DB has no collections. Nothing to copy.");
    await local.close();
    await atlas.close();
    return;
  }

  console.log(`Found ${collections.length} collection(s): ${collections.join(", ")}`);

  for (const name of collections) {
    const docs = await local.db.collection(name).find({}).toArray();
    const dest = atlas.db.collection(name);

    if (docs.length === 0) {
      console.log(`  ${name}: 0 docs (skipped insert)`);
      continue;
    }

    await dest.deleteMany({});
    await dest.insertMany(docs, { ordered: false });
    console.log(`  ${name}: copied ${docs.length} doc(s)`);

    try {
      const indexes = await local.db.collection(name).indexes();
      for (const idx of indexes) {
        if (idx.name === "_id_") continue;
        const { key, name: indexName, v, ns, ...options } = idx;
        try {
          await dest.createIndex(key, { ...options, name: indexName });
        } catch (err) {
          console.warn(`    index ${indexName}: ${err.message}`);
        }
      }
    } catch (err) {
      console.warn(`  ${name}: could not copy indexes — ${err.message}`);
    }
  }

  await local.close();
  await atlas.close();
  console.log("Done. Atlas now has a copy of local data.");
}

copyDb().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});
