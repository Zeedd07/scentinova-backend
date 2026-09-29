/**
 * Authoritative India address check for checkout. Uses the exact same
 * @countrystatecity/countries-browser data files (pinned version) that the
 * storefront's State/City dropdowns are built from, read locally from node_modules.
 */
import { createRequire } from 'node:module'
import { ApiError } from './ApiError.js'

const require = createRequire(import.meta.url)
const PKG = '@countrystatecity/countries-browser'

export const COUNTRY_NAME = 'India'
const COUNTRY_CODE = 'IN'

// Administrative divisions in the dataset, not cities. Mirrored in the storefront.
const NOT_A_CITY = / Division$/i

const normalize = (text) => String(text ?? '').trim().replace(/\s+/g, ' ').toLowerCase()

let states = null
const citiesByState = new Map()

function loadStates() {
  if (!states) {
    states = require(`${PKG}/data/states/${COUNTRY_CODE}.json`).map((s) => ({
      name: s.name,
      code: s.iso2,
    }))
  }
  return states
}

function loadCities(stateCode) {
  if (!citiesByState.has(stateCode)) {
    let list = []
    try {
      list = require(`${PKG}/data/cities/${COUNTRY_CODE}-${stateCode}.json`)
    } catch {
      list = []
    }
    const byKey = new Map()
    for (const c of list) {
      const name = String(c.name || '').trim()
      if (name && !NOT_A_CITY.test(name)) byKey.set(normalize(name), name)
    }
    citiesByState.set(stateCode, byKey)
  }
  return citiesByState.get(stateCode)
}

function invalid(field, message) {
  return new ApiError(400, 'INVALID_ADDRESS', message, { [`shippingAddress.${field}`]: message })
}

/**
 * Validates country / state / city as a real Indian combination and returns the
 * canonical dataset names, e.g. "mumbai" + "MH" -> { city: "Mumbai", state: "Maharashtra" }.
 */
export function resolveIndiaAddress({ country, state, city }) {
  const countryKey = normalize(country || COUNTRY_NAME)
  if (countryKey !== 'india' && countryKey !== 'in') {
    throw invalid('country', 'We currently ship within India only.')
  }

  const stateKey = normalize(state)
  const matchedState = stateKey
    ? loadStates().find((s) => normalize(s.name) === stateKey || normalize(s.code) === stateKey)
    : null
  if (!matchedState) throw invalid('state', 'Please select a valid state.')

  const matchedCity = loadCities(matchedState.code).get(normalize(city))
  if (!matchedCity) {
    throw invalid('city', `Please select a valid city in ${matchedState.name}.`)
  }

  return { country: COUNTRY_NAME, state: matchedState.name, city: matchedCity }
}
