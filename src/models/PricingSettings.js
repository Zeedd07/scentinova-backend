import mongoose from 'mongoose'

export const PRICING_SETTINGS_KEY = 'global'

const paise = {
  type: Number,
  required: true,
  min: 0,
  validate: {
    validator: Number.isInteger,
    message: '{PATH} must be an integer amount in paise.',
  },
}

const pricingSettingsSchema = new mongoose.Schema(
  {
    // Singleton: exactly one checkout configuration document
    key: {
      type: String,
      default: PRICING_SETTINGS_KEY,
      enum: [PRICING_SETTINGS_KEY],
      unique: true,
      immutable: true,
    },
    shipping: {
      enabled: { type: Boolean, required: true },
      standardFeePaise: paise,
      freeShippingEnabled: { type: Boolean, required: true },
      freeShippingThresholdPaise: paise,
    },
    convenienceFee: {
      enabled: { type: Boolean, required: true },
      amountPaise: paise,
      applyToPrepaid: { type: Boolean, required: true },
      applyToCod: { type: Boolean, required: true },
    },
    codFee: {
      enabled: { type: Boolean, required: true },
      amountPaise: paise,
    },
    paymentMethods: {
      prepaidEnabled: { type: Boolean, required: true },
      codEnabled: { type: Boolean, required: true },
    },
    version: { type: Number, required: true, default: 1, min: 1 },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true },
)

pricingSettingsSchema.set('toJSON', {
  versionKey: false,
  transform(_doc, ret) {
    delete ret._id
    return ret
  },
})

export const PricingSettings = mongoose.model('PricingSettings', pricingSettingsSchema)
