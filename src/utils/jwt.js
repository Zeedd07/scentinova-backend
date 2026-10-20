import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'

export function signAccessToken(payload) {
  return jwt.sign(payload, env.jwtAccessSecret, {
    expiresIn: env.jwtAccessExpires,
  })
}

export function signRefreshToken(payload) {
  return jwt.sign(payload, env.jwtRefreshSecret, {
    expiresIn: env.jwtRefreshExpires,
  })
}

const VERIFY_OPTIONS = { algorithms: ['HS256'] }

export function verifyAccessToken(token) {
  return jwt.verify(token, env.jwtAccessSecret, VERIFY_OPTIONS)
}

export function verifyRefreshToken(token) {
  return jwt.verify(token, env.jwtRefreshSecret, VERIFY_OPTIONS)
}
