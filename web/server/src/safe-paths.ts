import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export class PathError extends Error {
  readonly status = 400
}

export function validateRunId(value: unknown): string {
  if (typeof value !== 'string' || value.length > 255 || !/^[\p{L}\p{N}_-]+$/u.test(value)) {
    throw new PathError('无效的训练ID')
  }
  return value
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

export async function assertPathWithin(root: string, target: string, options: { allowMissing?: boolean } = {}): Promise<string> {
  const rootPath = resolve(root)
  const targetPath = resolve(target)
  const realRoot = await realpath(rootPath)
  if (!isWithin(rootPath, targetPath) && !isWithin(realRoot, targetPath)) throw new PathError('文件路径超出授权目录')
  let existing = targetPath
  const suffix: string[] = []
  while (true) {
    try {
      const actual = await realpath(existing)
      if (!isWithin(realRoot, actual)) throw new PathError('文件链接超出授权目录')
      return resolve(actual, ...suffix.reverse())
    } catch (error) {
      if (!options.allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      try {
        if ((await lstat(existing)).isSymbolicLink()) throw new PathError('无效的文件链接')
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError
      }
      if (existing === rootPath) throw error
      const parent = dirname(existing)
      suffix.push(relative(parent, existing))
      existing = parent
    }
  }
}

export async function resolveRunPath(outputsRoot: string, runId: string, allowMissing = false): Promise<string> {
  const path = join(outputsRoot, validateRunId(runId))
  try {
    const entry = await lstat(path)
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new PathError('无效的训练目录')
  } catch (error) {
    if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return assertPathWithin(outputsRoot, path, { allowMissing })
}
