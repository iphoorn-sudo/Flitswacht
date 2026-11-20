// Eigen SVG-iconen (inline strings, gebruiken currentColor waar zinvol).

const wrap = (body, vb = '0 0 64 64') =>
  `<svg viewBox="${vb}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${body}</svg>`;

/** Vaste flitser: afgeronde zeshoek met lens + flitsstraal. */
export const ICON_FIXED = (c = 'currentColor') => wrap(`
  <path d="M32 4 L56 18 L56 46 L32 60 L8 46 L8 18 Z" fill="${c}" opacity="0.16" stroke="${c}" stroke-width="3.5" stroke-linejoin="round"/>
  <rect x="17" y="24" width="24" height="18" rx="4" fill="${c}"/>
  <circle cx="29" cy="33" r="5.5" fill="#0b1219"/>
  <path d="M43 29 L50 25 M43 33 L52 33 M43 37 L50 41" stroke="${c}" stroke-width="3" stroke-linecap="round"/>
`);

/** Roodlichtcamera: verkeerslicht met camera-oog. */
export const ICON_REDLIGHT = (c = 'currentColor') => wrap(`
  <path d="M32 4 L56 18 L56 46 L32 60 L8 46 L8 18 Z" fill="${c}" opacity="0.16" stroke="${c}" stroke-width="3.5" stroke-linejoin="round"/>
  <rect x="24" y="14" width="16" height="36" rx="6" fill="${c}"/>
  <circle cx="32" cy="22" r="4.5" fill="#ff3d5a"/>
  <circle cx="32" cy="32" r="4.5" fill="#0b1219"/>
  <circle cx="32" cy="42" r="4.5" fill="#0b1219"/>
`);

/** Trajectcontrole: twee portalen met een lijn ertussen. */
export const ICON_SECTION = (c = 'currentColor') => wrap(`
  <path d="M32 4 L56 18 L56 46 L32 60 L8 46 L8 18 Z" fill="${c}" opacity="0.16" stroke="${c}" stroke-width="3.5" stroke-linejoin="round"/>
  <path d="M16 44 V22 H24 V44 M40 44 V22 H48 V44" fill="none" stroke="${c}" stroke-width="3.5" stroke-linejoin="round"/>
  <path d="M24 33 H40" stroke="${c}" stroke-width="3.5" stroke-dasharray="3 3"/>
  <path d="M36 29 L40 33 L36 37" fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
`);

/** Rustige toestand: weg-icoon. */
export const ICON_ROAD = (c = 'currentColor') => wrap(`
  <path d="M24 56 L29 8 H35 L40 56 Z" fill="${c}" opacity="0.18"/>
  <path d="M22 56 L28 8 M42 56 L36 8" stroke="${c}" stroke-width="3" stroke-linecap="round"/>
  <path d="M32 14 V20 M32 28 V36 M32 44 V54" stroke="${c}" stroke-width="3" stroke-linecap="round"/>
`);

/** Mobiele flitser (eigen melding): auto met radargolven. */
export const ICON_MOBILE = (c = 'currentColor') => wrap(`
  <path d="M32 4 L56 18 L56 46 L32 60 L8 46 L8 18 Z" fill="${c}" opacity="0.16" stroke="${c}" stroke-width="3.5" stroke-linejoin="round"/>
  <path d="M16 40 L19 31 Q20 28 23 28 H37 Q40 28 41 31 L44 40 Z" fill="${c}"/>
  <rect x="14" y="39" width="32" height="7" rx="2.5" fill="${c}"/>
  <circle cx="21" cy="46" r="3" fill="#0b1219"/><circle cx="39" cy="46" r="3" fill="#0b1219"/>
  <path d="M27 22 Q32 17 37 22 M23 18 Q32 9 41 18" fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round"/>
`);

export function iconForType(type, color) {
  switch (type) {
    case 'mobile': return ICON_MOBILE(color);
    case 'redlight': return ICON_REDLIGHT(color);
    case 'section_start':
    case 'section_end': return ICON_SECTION(color);
    case 'fixed':
    default: return ICON_FIXED(color);
  }
}

/** Positiepijl voor de kaart. */
export const ICON_ME = wrap(`
  <circle cx="32" cy="32" r="28" fill="#5ef2d6" opacity="0.18"/>
  <path d="M32 8 L50 52 L32 42 L14 52 Z" fill="#5ef2d6" stroke="#04110f" stroke-width="3" stroke-linejoin="round"/>
`);
