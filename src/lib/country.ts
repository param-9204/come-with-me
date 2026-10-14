/**
 * Comprehensive Country Normalization & Identification Utility.
 * Prevents countries (e.g. China, France, USA, Japan) from being misclassified as cities.
 */

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Mapping of lowercase country names, variations, and common aliases to ISO 3166-1 alpha-2 codes.
 */
export const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  // China & Greater China
  china: 'CN',
  'peoples republic of china': 'CN',
  'people s republic of china': 'CN',
  prc: 'CN',
  'mainland china': 'CN',
  taiwan: 'TW',
  'hong kong': 'HK',
  macau: 'MO',
  macao: 'MO',

  // United States & Americas
  'united states': 'US',
  'united states of america': 'US',
  usa: 'US',
  us: 'US',
  america: 'US',
  canada: 'CA',
  mexico: 'MX',
  brazil: 'BR',
  brasil: 'BR',
  argentina: 'AR',
  chile: 'CL',
  colombia: 'CO',
  peru: 'PE',
  bolivia: 'BO',
  ecuador: 'EC',
  venezuela: 'VE',
  uruguay: 'UY',
  paraguay: 'PY',
  guyana: 'GY',
  suriname: 'SR',
  costa_rica: 'CR',
  'costa rica': 'CR',
  panama: 'PA',
  guatemala: 'GT',
  honduras: 'HN',
  belize: 'BZ',
  el_salvador: 'SV',
  'el salvador': 'SV',
  nicaragua: 'NI',
  cuba: 'CU',
  jamaica: 'JM',
  haiti: 'HT',
  'dominican republic': 'DO',
  'puerto rico': 'PR',
  bahamas: 'BS',
  barbados: 'BB',
  trinidad: 'TT',
  'trinidad and tobago': 'TT',

  // Europe & UK
  'united kingdom': 'GB',
  uk: 'GB',
  'great britain': 'GB',
  britain: 'GB',
  england: 'GB',
  scotland: 'GB',
  wales: 'GB',
  'northern ireland': 'GB',
  ireland: 'IE',
  france: 'FR',
  germany: 'DE',
  deutschland: 'DE',
  italy: 'IT',
  italia: 'IT',
  spain: 'ES',
  espana: 'ES',
  portugal: 'PT',
  netherlands: 'NL',
  holland: 'NL',
  belgium: 'BE',
  switzerland: 'CH',
  austria: 'AT',
  greece: 'GR',
  sweden: 'SE',
  norway: 'NO',
  denmark: 'DK',
  finland: 'FI',
  iceland: 'IS',
  poland: 'PL',
  'czech republic': 'CZ',
  czechia: 'CZ',
  slovakia: 'SK',
  hungary: 'HU',
  romania: 'RO',
  bulgaria: 'BG',
  croatia: 'HR',
  slovenia: 'SI',
  serbia: 'RS',
  bosnia: 'BA',
  'bosnia and herzegovina': 'BA',
  montenegro: 'ME',
  albania: 'AL',
  'north macedonia': 'MK',
  macedonia: 'MK',
  cyprus: 'CY',
  malta: 'MT',
  luxembourg: 'LU',
  estonia: 'EE',
  latvia: 'LV',
  lithuania: 'LT',
  ukraine: 'UA',
  belarus: 'BY',
  russia: 'RU',
  moldova: 'MD',
  monaco: 'MC',
  andorra: 'AD',
  'san marino': 'SM',
  liechtenstein: 'LI',
  'vatican city': 'VA',
  vatican: 'VA',

  // Asia & Pacific
  japan: 'JP',
  nippon: 'JP',
  nihon: 'JP',
  'south korea': 'KR',
  korea: 'KR',
  'north korea': 'KP',
  india: 'IN',
  bharat: 'IN',
  australia: 'AU',
  'new zealand': 'NZ',
  indonesia: 'ID',
  thailand: 'TH',
  vietnam: 'VN',
  philippines: 'PH',
  malaysia: 'MY',
  singapore: 'SG',
  pakistan: 'PK',
  bangladesh: 'BD',
  'sri lanka': 'LK',
  nepal: 'NP',
  bhutan: 'BT',
  maldives: 'MV',
  myanmar: 'MM',
  burma: 'MM',
  cambodia: 'KH',
  laos: 'LA',
  mongolia: 'MN',
  kazakhstan: 'KZ',
  uzbekistan: 'UZ',
  turkmenistan: 'TM',
  kyrgyzstan: 'KG',
  tajikistan: 'TJ',
  fiji: 'FJ',
  'papua new guinea': 'PG',

  // Middle East
  'united arab emirates': 'AE',
  uae: 'AE',
  'saudi arabia': 'SA',
  qatar: 'QA',
  oman: 'OM',
  kuwait: 'KW',
  bahrain: 'BH',
  israel: 'IL',
  jordan: 'JO',
  lebanon: 'LB',
  turkey: 'TR',
  turkiye: 'TR',
  iran: 'IR',
  iraq: 'IQ',
  yemen: 'YE',
  syria: 'SY',

  // Africa
  egypt: 'EG',
  morocco: 'MA',
  'south africa': 'ZA',
  kenya: 'KE',
  tanzania: 'TZ',
  nigeria: 'NG',
  ghana: 'GH',
  ethiopia: 'ET',
  uganda: 'UG',
  rwanda: 'RW',
  algeria: 'DZ',
  tunisia: 'TN',
  mauritius: 'MU',
  seychelles: 'SC',
  madagascar: 'MG',
  namibia: 'NA',
  botswana: 'BW',
  zimbabwe: 'ZW',
  zambia: 'ZM',
  senegal: 'SN',
  ivory_coast: 'CI',
  'ivory coast': 'CI',
  'cote d ivoire': 'CI',
};

/**
 * Returns true if the string exactly matches a country name or abbreviation.
 */
export function isCountryName(value: string | null | undefined): boolean {
  if (!value?.trim()) return false;
  const normalized = normalizeText(value);
  return Boolean(COUNTRY_NAME_TO_CODE[normalized]);
}

/**
 * Returns the ISO 2-letter country code if the string matches a country, or null.
 */
export function getCountryCode(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  const normalized = normalizeText(value);
  return COUNTRY_NAME_TO_CODE[normalized] || null;
}

/**
 * Strips country names from a city candidate string.
 * - If the input is purely a country name (e.g. "China"), returns "".
 * - If the input is "City, Country" (e.g. "Taizhou, China"), returns "Taizhou".
 * - If the input is a valid city without country, returns the cleaned city.
 */
export function stripCountryFromCity(value: string | null | undefined): string {
  if (!value?.trim()) return '';
  const trimmed = value.trim();

  // If the whole string is a country name, it's not a city
  if (isCountryName(trimmed)) return '';

  // If formatted like "Taizhou, China" or "Paris, France"
  if (trimmed.includes(',')) {
    const parts = trimmed.split(',').map((p) => p.trim()).filter(Boolean);
    // Check if the last part is a country
    if (parts.length >= 2 && isCountryName(parts[parts.length - 1])) {
      const cityPart = parts.slice(0, -1).join(', ').trim();
      return isCountryName(cityPart) ? '' : cityPart;
    }
  }

  return trimmed;
}
