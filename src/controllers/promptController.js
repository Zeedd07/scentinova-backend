import { asyncHandler } from '../utils/asyncHandler.js'
import {
  generateNotePrompt,
  generateProductBackgroundPrompt,
} from '../services/promptService.js'

export const notePrompt = asyncHandler(async (req, res) => {
  res.json({ success: true, data: generateNotePrompt(req.body) })
})

export const backgroundPrompt = asyncHandler(async (req, res) => {
  res.json({ success: true, data: generateProductBackgroundPrompt(req.body) })
})
