import crypto from 'node:crypto'

/** Id curto, ordenável por tempo de criação. */
export function newId(prefix = '') {
  const time = Date.now().toString(36).padStart(9, '0')
  return `${prefix}${time}${crypto.randomBytes(5).toString('hex')}`
}
