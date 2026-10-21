const COLORS = [
  'from-indigo-500 to-purple-600',
  'from-emerald-500 to-teal-600',
  'from-rose-500 to-pink-600',
  'from-amber-500 to-orange-600',
  'from-cyan-500 to-blue-600',
  'from-violet-500 to-fuchsia-600',
  'from-lime-500 to-green-600',
  'from-red-500 to-rose-600',
]

const EMOJIS = ['🚀', '✨', '🔥', '🌟', '💎', '🎯', '🦊', '🐼', '🦄', '🐙']

export function getAvatarColor(phone: string): string {
  let hash = 0
  for (let i = 0; i < phone.length; i++) {
    hash = ((hash << 5) - hash) + phone.charCodeAt(i)
    hash |= 0
  }
  return COLORS[Math.abs(hash) % COLORS.length]
}

export function getAvatarEmoji(phone: string): string {
  let hash = 0
  for (let i = 0; i < phone.length; i++) {
    hash = ((hash << 5) - hash) + phone.charCodeAt(i)
    hash |= 0
  }
  return EMOJIS[Math.abs(hash) % EMOJIS.length]
}

export function getAvatarInitial(phone: string): string {
  return phone.slice(-2)
}
