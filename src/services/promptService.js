/**
 * Deterministic AI image prompt builders (no external AI calls).
 * Same input always yields the same prompt, so admins can copy/edit and reuse them.
 */
import { slugify } from '../utils/slugify.js'

export const BRAND_PALETTE = Object.freeze({
  crimson: '#962D2E',
  oxblood: '#6E1E22',
  gold: '#C9A24A',
  nearBlack: '#171512',
  ivory: '#F5F2EB',
})

const BRAND_LINE =
  `Scentinova luxury perfume house aesthetic: restrained, editorial and warm; palette of deep crimson ${BRAND_PALETTE.crimson}, ` +
  `oxblood ${BRAND_PALETTE.oxblood}, antique gold ${BRAND_PALETTE.gold}, near-black ${BRAND_PALETTE.nearBlack} and warm ivory ${BRAND_PALETTE.ivory}, ` +
  'used as subtle accents rather than flat fills'

const FAMILIES = {
  CITRUS: {
    material: 'glistening zest oils, textured peel pores and translucent juice vesicles',
    lighting: 'bright, crisp morning side light with a soft specular highlight',
    mood: 'bright, sparkling and uplifting',
    surface: 'pale honed travertine with a few droplets of water',
  },
  FLORAL: {
    material: 'velvety petals with delicate veins, soft translucency and a touch of dew',
    lighting: 'soft diffused window light with gentle backlight glowing through the petals',
    mood: 'romantic, luminous and graceful',
    surface: 'ivory silk draped over warm marble',
  },
  WOODY: {
    material: 'raw wood grain, split fibres and rich natural resin',
    lighting: 'low, warm directional light raking across the grain',
    mood: 'grounded, quiet and sophisticated',
    surface: 'dark oiled walnut plinth',
  },
  AMBER: {
    material: 'translucent resin tears, glowing golden fragments and fine dust of resin',
    lighting: 'warm golden backlight making the resin glow from within',
    mood: 'warm, sensual and enveloping',
    surface: 'polished travertine with a soft amber reflection',
  },
  MUSK: {
    material: 'soft powdery textures, cashmere-like fibres and fine translucent veils',
    lighting: 'very soft, wrapping high-key light with minimal shadow',
    mood: 'intimate, clean and skin-like',
    surface: 'brushed ivory plaster',
  },
  SPICY: {
    material: 'whole spices with dry, textured surfaces and scattered fine powder',
    lighting: 'warm chiaroscuro light with rich shadows',
    mood: 'vibrant, warm and magnetic',
    surface: 'dark stone with a warm crimson undertone',
  },
  FRESH: {
    material: 'clear water droplets, mineral textures and cool translucent surfaces',
    lighting: 'cool, clean daylight with crisp caustic reflections',
    mood: 'airy, clean and expansive',
    surface: 'wet pale stone with gentle ripples of water',
  },
  GOURMAND: {
    material: 'glossy, edible textures with fine crystalline and creamy details',
    lighting: 'warm soft light with a gentle golden rim',
    mood: 'indulgent, comforting and refined',
    surface: 'warm cream marble',
  },
  LEATHER: {
    material: 'supple grained leather with visible stitching and a soft sheen',
    lighting: 'moody low-key light with a warm edge highlight',
    mood: 'bold, confident and luxurious',
    surface: 'dark oxblood leather over a near-black plinth',
  },
  FRUITY: {
    material: 'juicy fruit flesh, soft bloom on the skin and fresh droplets',
    lighting: 'soft warm daylight with a luminous highlight',
    mood: 'playful, lush and vivid',
    surface: 'ivory marble',
  },
  GREEN: {
    material: 'crisp leaves, fresh stems and fine natural veins',
    lighting: 'fresh diffused daylight with soft green bounce',
    mood: 'fresh, natural and vivid',
    surface: 'pale limestone',
  },
  OTHER: {
    material: 'natural raw-ingredient textures with fine detail',
    lighting: 'soft, warm diffused studio light',
    mood: 'refined, quiet and luxurious',
    surface: 'honed ivory marble plinth',
  },
}

/** keyword → [family, subject description]. Longest matching keyword wins. */
const NOTE_LIBRARY = [
  ['calabrian bergamot', 'CITRUS', 'a halved Calabrian bergamot with textured green-gold peel and a curl of zest'],
  ['bergamot', 'CITRUS', 'a halved bergamot fruit with textured green-gold peel and a curl of zest'],
  ['lemon', 'CITRUS', 'a sliced lemon with a spiral of fresh zest'],
  ['mandarin', 'CITRUS', 'a peeled mandarin with segments fanned open'],
  ['orange blossom', 'FLORAL', 'a sprig of white orange blossoms with glossy leaves'],
  ['neroli', 'FLORAL', 'a sprig of white neroli blossoms with glossy leaves'],
  ['orange', 'CITRUS', 'a halved blood-orange with glistening flesh'],
  ['grapefruit', 'CITRUS', 'a halved pink grapefruit with glistening flesh'],
  ['yuzu', 'CITRUS', 'a whole and a halved yuzu fruit'],
  ['lime', 'CITRUS', 'sliced limes with bright green zest'],
  ['jasmine sambac', 'FLORAL', 'a small cluster of white Jasmine Sambac blossoms with a single glossy leaf'],
  ['jasmine', 'FLORAL', 'a small cluster of star-shaped white jasmine blossoms'],
  ['taif rose', 'FLORAL', 'a single deep-pink Taif rose in full bloom with a few loose petals'],
  ['rose', 'FLORAL', 'a single rose in full bloom with a few loose petals'],
  ['tuberose', 'FLORAL', 'a stem of creamy white tuberose flowers'],
  ['ylang', 'FLORAL', 'a few golden-yellow ylang-ylang flowers with long twisted petals'],
  ['orris', 'FLORAL', 'a sliced orris root beside a single pale iris flower'],
  ['iris', 'FLORAL', 'a single pale violet iris flower'],
  ['violet', 'FLORAL', 'a small posy of violets'],
  ['lavender', 'FLORAL', 'a small bundle of lavender stems tied with raw twine'],
  ['peony', 'FLORAL', 'a single blush peony in full bloom'],
  ['magnolia', 'FLORAL', 'a single open magnolia flower'],
  ['gardenia', 'FLORAL', 'a single creamy white gardenia with glossy leaves'],
  ['osmanthus', 'FLORAL', 'a sprig of tiny apricot-coloured osmanthus flowers'],
  ['white floral', 'FLORAL', 'an airy arrangement of mixed white blossoms'],
  ['hedione', 'FLORAL', 'a sheer, luminous white jasmine petal suspended in soft mist'],
  ['rosewood', 'WOODY', 'polished rosewood pieces with fine shavings'],
  ['sandalwood', 'WOODY', 'a block of creamy sandalwood with fine shavings'],
  ['cedar', 'WOODY', 'split cedarwood pieces with fresh aromatic shavings'],
  ['vetiver', 'WOODY', 'a bundle of dried vetiver roots'],
  ['agarwood', 'WOODY', 'dark resin-streaked agarwood (oud) chips'],
  ['oud', 'WOODY', 'dark resin-streaked oud wood chips'],
  ['patchouli', 'WOODY', 'dried patchouli leaves'],
  ['guaiac', 'WOODY', 'a piece of smoky guaiac wood'],
  ['bakhoor', 'AMBER', 'bakhoor wood chips smouldering in a small brass burner with a thin ribbon of smoke'],
  ['olibanum', 'AMBER', 'pale golden olibanum resin tears'],
  ['frankincense', 'AMBER', 'pale golden frankincense resin tears'],
  ['incense', 'AMBER', 'a thin ribbon of incense smoke rising from resin'],
  ['myrrh', 'AMBER', 'reddish-amber myrrh resin pieces'],
  ['labdanum', 'AMBER', 'sticky dark labdanum resin'],
  ['benzoin', 'AMBER', 'warm benzoin resin pieces'],
  ['amber', 'AMBER', 'glowing pieces of golden amber resin'],
  ['tonka', 'GOURMAND', 'a few wrinkled tonka beans, one shaved to reveal its interior'],
  ['vanilla', 'GOURMAND', 'split vanilla pods with glistening seeds'],
  ['caramel', 'GOURMAND', 'a glossy ribbon of amber caramel'],
  ['praline', 'GOURMAND', 'crushed praline shards'],
  ['coffee', 'GOURMAND', 'roasted coffee beans'],
  ['cocoa', 'GOURMAND', 'raw cocoa beans and a curl of dark chocolate'],
  ['honey', 'GOURMAND', 'a honey dipper dripping golden honey'],
  ['coconut', 'GOURMAND', 'a halved coconut with creamy white flesh'],
  ['white musk', 'MUSK', 'a soft cloud of white cotton and fine powder'],
  ['ambrette', 'MUSK', 'a small pile of ambrette seeds'],
  ['musk', 'MUSK', 'a soft billow of cashmere fibres and fine powder'],
  ['saffron', 'SPICY', 'a few crimson saffron threads on a small brass dish'],
  ['pink pepper', 'SPICY', 'a scattering of pink peppercorns'],
  ['black pepper', 'SPICY', 'cracked black peppercorns'],
  ['pepper', 'SPICY', 'a scattering of peppercorns'],
  ['cardamom', 'SPICY', 'green cardamom pods, one cracked open'],
  ['cinnamon', 'SPICY', 'a small bundle of cinnamon sticks'],
  ['clove', 'SPICY', 'whole cloves'],
  ['nutmeg', 'SPICY', 'a whole nutmeg and a halved nutmeg showing its marbled interior'],
  ['ginger', 'SPICY', 'fresh sliced ginger root'],
  ['leather', 'LEATHER', 'a folded piece of supple oxblood leather'],
  ['suede', 'LEATHER', 'a soft swatch of suede'],
  ['tobacco', 'LEATHER', 'cured golden tobacco leaves'],
  ['calone', 'FRESH', 'a translucent wave of sea water with fine salt spray'],
  ['sea water', 'FRESH', 'a translucent wave of sea water with fine salt spray'],
  ['sea salt', 'FRESH', 'coarse sea salt crystals'],
  ['marine', 'FRESH', 'a translucent wave of sea water with fine salt spray'],
  ['aquatic', 'FRESH', 'a translucent splash of clear water'],
  ['mint', 'GREEN', 'a sprig of fresh mint'],
  ['green tea', 'GREEN', 'loose green tea leaves'],
  ['basil', 'GREEN', 'fresh basil leaves'],
  ['galbanum', 'GREEN', 'galbanum resin with crisp green stems'],
  ['fig', 'GREEN', 'a halved fig with a single fig leaf'],
  ['wild berries', 'FRUITY', 'a small cluster of wild berries'],
  ['raspberry', 'FRUITY', 'a few ripe raspberries'],
  ['blackcurrant', 'FRUITY', 'a sprig of blackcurrants'],
  ['plum', 'FRUITY', 'a ripe plum, halved'],
  ['peach', 'FRUITY', 'a ripe peach with a single leaf'],
  ['pear', 'FRUITY', 'a ripe pear'],
  ['apple', 'FRUITY', 'a crisp red apple, halved'],
].sort((a, b) => b[0].length - a[0].length)

const TIER_MODIFIERS = {
  TOP: 'conveying a bright, airy first impression',
  HEART: 'conveying a full, rounded, blooming character',
  BASE: 'conveying deep, grounded, lingering warmth',
}

const NOTE_NEGATIVES = [
  'text',
  'letters',
  'logos',
  'watermarks',
  'labels',
  'perfume bottles',
  'packaging',
  'hands',
  'people',
  'frames or borders',
  'clutter',
  'multiple competing subjects',
  'oversaturated colours',
  'cartoon or illustration style',
  'CGI or plastic look',
  'harsh shadows',
  'blurry subject',
]

const BACKGROUND_NEGATIVES = [
  'any perfume bottle or product in the scene',
  'text',
  'logos',
  'watermarks',
  'people',
  'hands',
  'clutter inside the negative space',
  'distorted perspective',
  'floating or cut-off props',
  'cartoon or illustration style',
  'CGI or plastic look',
  'oversaturated colours',
]

function normalizeName(name) {
  return slugify(name).replace(/-/g, ' ')
}

/** Infer family + subject for a note name. Explicit category wins over inference. */
export function classifyNote(noteName, category) {
  const normalized = normalizeName(noteName)
  const match = NOTE_LIBRARY.find(([keyword]) => ` ${normalized} `.includes(` ${keyword} `))
    || NOTE_LIBRARY.find(([keyword]) => normalized.includes(keyword))
  const family = category && FAMILIES[category] ? category : match?.[1] || 'OTHER'
  const subject = match?.[2] || `${String(noteName).trim()}, shown as the raw perfumery ingredient in its natural form`
  return { family, subject, matched: Boolean(match) }
}

function sentence(text) {
  const t = String(text).trim().replace(/\.$/, '')
  return t.charAt(0).toUpperCase() + t.slice(1)
}

function assemble(rawSections, negatives, aspectRatio) {
  const sections = rawSections.map((s) => ({ ...s, text: sentence(s.text) }))
  const body = sections.map((s) => s.text).join('. ') + '.'
  const negativePrompt = negatives.join(', ')
  const prompt = `${body}\n\nNegative prompt: ${negativePrompt}.\nAspect ratio: ${aspectRatio}.`
  return {
    prompt,
    negativePrompt,
    aspectRatio,
    sections: [
      ...sections,
      { key: 'NEGATIVES', label: 'Negatives', text: negativePrompt },
      { key: 'ASPECT', label: 'Aspect ratio', text: aspectRatio },
    ],
  }
}

/**
 * Prompt for a single note thumbnail — tuned to read clearly at 80–160px
 * and to match every other note image in the library (ivory seamless background).
 */
export function generateNotePrompt({ noteName, category, tier, aspectRatio = '1:1', style } = {}) {
  const name = String(noteName || '').trim()
  if (!name) throw new Error('noteName is required')
  const { family, subject } = classifyNote(name, category)
  const f = FAMILIES[family]
  const tierText = tier && TIER_MODIFIERS[tier] ? `, ${TIER_MODIFIERS[tier]}` : ''

  const sections = [
    { key: 'SUBJECT', label: 'Subject', text: `A single editorial still life of ${subject}, representing the ${name} fragrance note${tierText}` },
    { key: 'MATERIAL', label: 'Material', text: `Rendered with ${f.material}` },
    {
      key: 'COMPOSITION',
      label: 'Composition',
      text: 'One centred subject filling about 60% of the frame with an even margin on all sides, a clean readable silhouette that still works as a small thumbnail',
    },
    { key: 'LIGHTING', label: 'Lighting', text: f.lighting },
    {
      key: 'BACKGROUND',
      label: 'Background',
      text: `Seamless warm ivory ${BRAND_PALETTE.ivory} backdrop with a soft tonal gradient and a gentle contact shadow, identical across the whole note library`,
    },
    { key: 'MOOD', label: 'Mood', text: f.mood },
    {
      key: 'STYLE',
      label: 'Style',
      text: style?.trim() || 'High-end fragrance campaign photography, photorealistic, 100mm macro lens, shallow depth of field, fine natural detail, subtle film grain',
    },
    { key: 'BRAND', label: 'Brand', text: BRAND_LINE },
  ]

  return { ...assemble(sections, NOTE_NEGATIVES, aspectRatio), family }
}

function dominantFamily(notes) {
  const counts = new Map()
  for (const note of notes) {
    const { family } = classifyNote(note)
    if (family === 'OTHER') continue
    counts.set(family, (counts.get(family) || 0) + 1)
  }
  let best = 'OTHER'
  let bestCount = 0
  for (const [family, count] of counts) {
    if (count > bestCount) {
      best = family
      bestCount = count
    }
  }
  return best
}

const PLACEMENT = {
  CENTER: 'Leave a clear, well-lit empty space at the exact centre of the frame for the bottle, with props framing both sides symmetrically and nothing overlapping the centre',
  LEFT: 'Keep the left third of the frame as clean negative space for the bottle, with props and texture gathered on the right two-thirds',
  RIGHT: 'Keep the right third of the frame as clean negative space for the bottle, with props and texture gathered on the left two-thirds',
}

/**
 * Prompt for an empty product-photography set; the bottle is composited later,
 * so the placement area must stay clear.
 */
export function generateProductBackgroundPrompt({
  productName,
  notes = [],
  placement = 'CENTER',
  mood,
  colors,
  lighting,
  environment,
  surface,
  aspectRatio = '4:5',
} = {}) {
  const name = String(productName || '').trim()
  if (!name) throw new Error('productName is required')
  const cleanNotes = notes.map((n) => String(n || '').trim()).filter(Boolean)
  const family = dominantFamily(cleanNotes)
  const f = FAMILIES[family]
  const accents = cleanNotes.slice(0, 4).map((n) => classifyNote(n).subject)

  const sections = [
    {
      key: 'SUBJECT',
      label: 'Subject',
      text: `An empty luxury product-photography set for the ${name} perfume, with no bottle in the scene`,
    },
    {
      key: 'MATERIAL',
      label: 'Material',
      text: accents.length
        ? `Subtle ingredient accents placed with restraint: ${accents.join('; ')}`
        : `Refined natural textures: ${f.material}`,
    },
    { key: 'COMPOSITION', label: 'Composition', text: `${PLACEMENT[placement] || PLACEMENT.CENTER}, eye-level camera, straight horizon` },
    { key: 'LIGHTING', label: 'Lighting', text: lighting?.trim() || f.lighting },
    {
      key: 'BACKGROUND',
      label: 'Background',
      text: `${environment?.trim() || 'Minimal architectural studio set with soft depth falloff'}, on ${surface?.trim() || f.surface}`,
    },
    { key: 'MOOD', label: 'Mood', text: mood?.trim() || f.mood },
    {
      key: 'STYLE',
      label: 'Style',
      text: 'High-end fragrance campaign photography, photorealistic, medium-format look, natural shadows and reflections',
    },
    {
      key: 'BRAND',
      label: 'Brand',
      text: colors?.trim() ? `${BRAND_LINE}; colour direction: ${colors.trim()}` : BRAND_LINE,
    },
  ]

  return { ...assemble(sections, BACKGROUND_NEGATIVES, aspectRatio), family }
}
