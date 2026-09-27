/**
 * Optional: copy the old global checkout fees (PricingSettings 'global') onto products
 * that have no per-product `fees` yet. Products that already have fees are never touched.
 *
 * Dry run by default — prints what would change.
 *   npm run migrate:product-fees
 *   npm run migrate:product-fees -- --apply
 *
 * Without this script, products with no `fees` are priced as "no fees, COD allowed".
 */
import { connectDb, disconnectDb } from '../src/config/db.js'
import { Product } from '../src/models/Product.js'
import { PricingSettings, PRICING_SETTINGS_KEY } from '../src/models/PricingSettings.js'
import { writeAudit } from '../src/services/auditService.js'

const apply = process.argv.includes('--apply')

function amount(section) {
  const n = section?.amountPaise ?? section?.standardFeePaise
  return Number.isSafeInteger(n) && n >= 0 ? n : 0
}

await connectDb()
try {
  const settings = await PricingSettings.findOne({ key: PRICING_SETTINGS_KEY }).lean()
  if (!settings) {
    console.log('No global pricing settings found; nothing to copy.')
  } else {
    const fees = {
      convenience: {
        enabled: settings.convenienceFee?.enabled === true,
        amountPaise: amount(settings.convenienceFee),
        applyToPrepaid: settings.convenienceFee?.applyToPrepaid !== false,
        applyToCod: settings.convenienceFee?.applyToCod !== false,
      },
      cod: { enabled: settings.codFee?.enabled === true, amountPaise: amount(settings.codFee) },
      shipping: {
        enabled: settings.shipping?.enabled === true,
        amountPaise: amount(settings.shipping),
      },
      codAllowed: settings.paymentMethods?.codEnabled !== false,
    }

    const filter = { fees: { $exists: false } }
    const targets = await Product.find(filter).select('name slug').lean()
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', fees, products: targets.length }, null, 2))
    for (const p of targets) console.log(`  - ${p.name} (${p.slug})`)

    if (apply && targets.length) {
      const result = await Product.updateMany(filter, { $set: { fees } })
      await writeAudit({
        actorType: 'SYSTEM',
        action: 'PRODUCT_FEES_BACKFILLED',
        entityType: 'Product',
        entityId: 'bulk',
        metadata: {
          source: 'migrateProductFees',
          settingsVersion: settings.version ?? null,
          fees,
          modified: result.modifiedCount,
        },
      })
      console.log(`Updated ${result.modifiedCount} product(s).`)
    } else if (!apply) {
      console.log('Dry run only. Re-run with --apply to write these fees.')
    }
  }
} finally {
  await disconnectDb()
}
