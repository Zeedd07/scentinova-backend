import { asyncHandler } from '../utils/asyncHandler.js'
import { NewsletterSubscriber } from '../models/NewsletterSubscriber.js'

export const subscribe = asyncHandler(async (req, res) => {
  const email = req.body.email.toLowerCase()
  const existing = await NewsletterSubscriber.findOne({ email })
  if (existing) {
    if (existing.status === 'subscribed') {
      return res.json({
        success: true,
        data: { subscriber: existing.toJSON(), alreadySubscribed: true },
      })
    }
    existing.status = 'subscribed'
    existing.subscribedAt = new Date()
    existing.unsubscribedAt = null
    await existing.save()
    return res.json({ success: true, data: { subscriber: existing.toJSON() } })
  }

  const subscriber = await NewsletterSubscriber.create({ email })
  res.status(201).json({ success: true, data: { subscriber: subscriber.toJSON() } })
})

export const adminList = asyncHandler(async (_req, res) => {
  const subscribers = await NewsletterSubscriber.find({ status: 'subscribed' }).sort({
    subscribedAt: -1,
  })
  res.json({
    success: true,
    data: { subscribers: subscribers.map((s) => s.toJSON()) },
  })
})
